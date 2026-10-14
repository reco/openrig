import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { SuccessorSessionLauncher } from "../src/domain/successor-session-launcher.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { nodeRuntimeHomes, resolveRuntimeHomes, sessionClaudeConfigDir } from "../src/domain/runtime-homes.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

const exec = promisify(execFile);
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of cleanup.splice(0)) f(); });

const TV = "/Users/someone/.claude-tv";

function spec(rigHomes?: unknown, memberHomes?: unknown) {
  const member = { id: "dev", agent_ref: "local:agents/dev", profile: "default", runtime: "claude-code", cwd: ".", ...(memberHomes ? { runtime_homes: memberHomes } : {}) };
  return { version: "0.2", name: "tv", ...(rigHomes ? { runtime_homes: rigHomes } : {}), pods: [{ id: "dev", label: "Dev", members: [member], edges: [] }], edges: [] };
}

function seat(claude?: string) {
  const db = createFullTestDb();
  cleanup.push(() => db.close());
  const rigRepo = new RigRepository(db);
  const rig = rigRepo.createRig("tv");
  const node = rigRepo.addNode(rig.id, "dev.dev", { runtime: "claude-code", cwd: "/w", runtimeHomes: claude ? { claude } : {} });
  return { db, rigRepo, rig, node };
}

describe("runtime_homes: a seat runs on its own Claude account", () => {
  it("a rig sets the Claude config dir for every seat, a member overrides it, and ~ expands", () => {
    expect(RigSpecSchema.validate(spec({ claude: "~/.claude-tv" })).valid).toBe(true);
    expect(RigSpecSchema.validate(spec(undefined, { claude: TV })).valid).toBe(true);
    expect(RigSpecSchema.validate(spec({ claude: "relative/dir" })).errors).toContain("runtime_homes.claude: must be an absolute path or start with ~/");
    expect(RigSpecSchema.validate(spec(undefined, { gemini: "/x" })).errors.join()).toMatch(/gemini: unknown runtime home/);
    expect(resolveRuntimeHomes({ claude: "~/.claude-tv" }, undefined, "/Users/someone")).toEqual({ claude: TV });
    expect(resolveRuntimeHomes({ claude: "/rig" }, { claude: "/seat" })).toEqual({ claude: "/seat" });
    expect(resolveRuntimeHomes(undefined, undefined)).toEqual({});
  });

  it("the setting survives a spec round trip", () => {
    const normalized = RigSpecSchema.normalize(spec({ claude: "~/.claude-tv" }, { claude: TV }) as Record<string, unknown>);
    const reparsed = RigSpecCodec.parse(RigSpecCodec.serialize(normalized)) as Record<string, unknown>;
    expect(reparsed["runtime_homes"]).toEqual({ claude: "~/.claude-tv" });
    expect((reparsed["pods"] as Array<{ members: Array<Record<string, unknown>> }>)[0]!.members[0]!["runtime_homes"]).toEqual({ claude: TV });
  });

  it("the seat's dir is stored on its node and found from its session name", () => {
    const { db, node } = seat(TV);
    expect(nodeRuntimeHomes(db, node.id)).toEqual({ claude: TV });
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s1', ?, 'dev@tv', 'running')").run(node.id);
    expect(sessionClaudeConfigDir(db, "dev@tv")).toBe(TV);
    expect(nodeRuntimeHomes(db, seat().node.id)).toEqual({});
  });

  it("a fresh launch or restore creates the seat's tmux session with CLAUDE_CONFIG_DIR", async () => {
    const { db, rigRepo, rig } = seat(TV);
    const createSession = vi.fn(async () => ({ ok: true as const }));
    const tmux = { createSession, killSession: async () => ({ ok: true }), listPanes: async () => [], hasSession: async () => false } as unknown as TmuxAdapter;
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db), tmuxAdapter: tmux, sessionEnv: { HOME: "/Users/someone" } });
    expect((await launcher.launchNode(rig.id, "dev.dev")).ok).toBe(true);
    expect((createSession.mock.calls[0] as unknown[])[2]).toMatchObject({ CLAUDE_CONFIG_DIR: TV });
  });

  it("a handover respawns the pane with the seat's CLAUDE_CONFIG_DIR", async () => {
    const db = createFullTestDb();
    cleanup.push(() => db.close());
    const respawnPane = vi.fn(async () => ({ ok: true }));
    const tmux = { listPanes: async () => [{ id: "%7", active: true }], respawnPane, setRemainOnExit: async () => ({ ok: true }), signalPaneProcess: async () => ({ ok: true }),
      isPaneDead: async () => true, getDefaultShell: async () => "/bin/zsh", getPaneCommand: async () => "zsh", createSession: async () => ({ ok: true }) } as unknown as TmuxAdapter;
    const adapter = { runtime: "claude-code", launchHarness: async () => ({ ok: true }), checkReady: async () => ({ ready: true }) } as unknown as RuntimeAdapter;
    const launcher = new SuccessorSessionLauncher(tmux, new DiscoveryRepository(db), { sessionEnv: { HOME: "/Users/someone" }, runtimeAdapters: { "claude-code": adapter },
      readinessTimeoutMs: 50, sleep: async () => {}, exitPollMs: 1 });
    await launcher.createSuccessor({ node: { id: "n", runtime: "claude-code", cwd: "/w", runtimeHomes: { claude: TV } }, departingSessionName: "dev@tv" });
    expect((respawnPane.mock.calls[0] as unknown[])[2]).toMatchObject({ env: { CLAUDE_CONFIG_DIR: TV } });
  });

  it.skipIf(process.platform === "win32")("the typed launch command runs claude on the seat's dir even when the shell rc exports another", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "runtime-homes-")));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "rig"), "#!/bin/sh\n");
    writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho \"config=$CLAUDE_CONFIG_DIR\"\n");
    chmodSync(path.join(bin, "rig"), 0o755);
    chmodSync(path.join(bin, "claude"), 0o755);
    const rc = path.join(root, "rc");
    writeFileSync(rc, `export CLAUDE_CONFIG_DIR=/user/claude PATH=${shellQuote(`${bin}:/usr/bin:/bin`)}\n`);
    const identity: Record<string, string> = { OPENRIG_NODE_ID: "node-tv", OPENRIG_SESSION_NAME: "dev@tv", OPENRIG_RUNTIME: "claude-code" };
    const tmux = new TmuxAdapter(async (cmd) => { const key = Object.keys(identity).find((k) => cmd.endsWith(shellQuote(k))); return key ? `${key}=${identity[key]}\n` : `-${cmd.split(" ").pop()!.replace(/'/g, "")}\n`; });
    vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("bash");
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, OPENRIG_HOME: path.join(root, "instance") };
    const run = async (homes: Record<string, { claude?: string }>) => {
      const launch = new SeatLaunchEnvironment(tmux, env, root, path.join(bin, "rig"), undefined, (nodeId) => homes[nodeId] ?? {});
      const command = await launch.command("dev@tv", "claude --session-id x", { nodeId: "node-tv", runtime: "claude-code" });
      expect(command).toContain("OPENRIG_NODE_ID=");
      return (await exec("/bin/bash", ["--noprofile", "--rcfile", rc, "-ic", command], { env, cwd: root, timeout: 5000 })).stdout.trim();
    };
    expect(await run({ "node-tv": { claude: TV } })).toBe(`config=${TV}`);
    expect(await run({})).toBe("config=/user/claude");
  });

  it("a managed launch selects and provisions the seat's dir", () => {
    const { db, node } = seat(TV);
    const managed = new ClaudeManagedLaunch(db, { PATH: "/usr/bin", HOME: "/Users/someone" }, {});
    expect(managed.configPaths("/w", node.id)).toEqual({ configDir: TV, statePath: `${TV}/.claude.json` });
    expect(managed.selectedStatePath("/w", node.id)).toBe(`${TV}/.claude.json`);
    expect(managed.configPaths("/w")).toEqual({ configDir: "/Users/someone/.claude", statePath: "/Users/someone/.claude.json" });
  });
});
