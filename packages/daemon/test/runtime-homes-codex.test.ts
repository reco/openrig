// Every executable and Codex state file below is a fixture; no real Codex home or auth file is read.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
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
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { makeCodexPriorPolicyReader } from "../src/domain/codex-prior-policy.js";
import { nodeRuntimeHomes, resolveRuntimeHomes, sessionRuntimeHomes } from "../src/domain/runtime-homes.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

const exec = promisify(execFile);
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const f of cleanup.splice(0)) f(); });

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-homes-codex-")));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), daemonHome = path.join(root, "daemon codex"), tvHome = path.join(root, "home", ".codex-tvlabs"), cwd = path.join(root, "project"), bin = path.join(root, "bin");
  for (const dir of [home, daemonHome, tvHome, cwd, bin]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}\nconsole.log(JSON.stringify({ home: process.env.CODEX_HOME }));\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, "rig"), "#!/bin/sh\n", { mode: 0o700 });
  const env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, OPENRIG_HOME: path.join(root, "instance") };
  const rc = path.join(root, "pane.rc");
  fs.writeFileSync(rc, `export CODEX_HOME=${shellQuote(path.join(home, ".codex"))}\n`);
  const run = async (cmd: string) => JSON.parse((await exec("/bin/bash", ["--noprofile", "--norc", "-c", `. ${shellQuote(rc)}; ${cmd}`], { cwd, env, timeout: 5000 })).stdout).home as string;
  return { root, home, daemonHome, tvHome, cwd, bin, env, run };
}

/** Codex's own pid-keyed logs and thread state, as a Codex process on `pid` leaves them. */
function seedThread(codexHome: string, threadId: string, pid = 42) {
  const rollout = path.join(codexHome, `rollout-${threadId}.jsonl`);
  fs.writeFileSync(rollout, `${JSON.stringify({ type: "turn_context", payload: { sandbox_policy: { type: "workspace-write", writable_roots: [], network_access: false }, approval_policy: "on-request", effort: "high" } })}\n`);
  const logs = new Database(path.join(codexHome, "logs_2.sqlite"));
  logs.exec("CREATE TABLE logs (process_uuid TEXT, thread_id TEXT, ts INTEGER)");
  logs.prepare("INSERT INTO logs VALUES (?, ?, ?)").run(`pid:${pid}:fixture`, threadId, 2000000000);
  logs.close();
  const state = new Database(path.join(codexHome, "state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT, source TEXT, rollout_path TEXT)");
  state.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(threadId, "cli", rollout);
  state.close();
}

function spec(rigHomes?: unknown, memberHomes?: unknown) {
  const member = { id: "checker", agent_ref: "local:agents/checker", profile: "default", runtime: "codex", cwd: ".", ...(memberHomes ? { runtime_homes: memberHomes } : {}) };
  return { version: "0.2", name: "device-io", ...(rigHomes ? { runtime_homes: rigHomes } : {}), pods: [{ id: "dev", label: "Dev", members: [member], edges: [] }], edges: [] };
}

function seat(codex?: string) {
  const db = createFullTestDb();
  cleanup.push(() => db.close());
  const rigRepo = new RigRepository(db);
  const rig = rigRepo.createRig("device-io");
  const node = rigRepo.addNode(rig.id, "dev.checker", { runtime: "codex", cwd: "/w", runtimeHomes: codex ? { codex } : {} });
  return { db, rigRepo, rig, node };
}

describe("runtime_homes.codex: a seat runs on its own Codex account", () => {
  it("a rig or member names an existing Codex home; ~ expands; a missing dir is refused with the login step", () => {
    const f = fixture();
    expect(RigSpecSchema.validate(spec({ codex: f.tvHome })).valid).toBe(true);
    expect(RigSpecSchema.validate(spec(undefined, { codex: f.tvHome, claude: "~/.claude-tv" })).valid).toBe(true);
    const missing = path.join(f.root, "no-such-home");
    expect(RigSpecSchema.validate(spec({ codex: missing })).errors).toContain(`runtime_homes.codex: ${missing} does not exist; log in there first (CODEX_HOME=${missing} codex login)`);
    expect(RigSpecSchema.validate(spec(undefined, { codex: "relative" })).errors.join()).toMatch(/runtime_homes\.codex: must be an absolute path or start with ~\//);
    expect(RigSpecSchema.validate(spec({ cursor: "/x" })).errors).toContain("runtime_homes.cursor: unknown runtime home (expected claude or codex)");
    expect(resolveRuntimeHomes({ codex: "~/.codex-tvlabs", claude: "/c" }, { codex: "/seat" }, f.home)).toEqual({ codex: "/seat", claude: "/c" });
    expect(resolveRuntimeHomes({ codex: "~/.codex-tvlabs" }, undefined, f.home)).toEqual({ codex: f.tvHome });
  });

  it("the setting survives a spec round trip and is stored on the seat and the rig", () => {
    const f = fixture();
    const reparsed = RigSpecCodec.parse(RigSpecCodec.serialize(RigSpecSchema.normalize(spec({ codex: f.tvHome }, { codex: f.tvHome }) as Record<string, unknown>))) as Record<string, unknown>;
    expect(reparsed["runtime_homes"]).toEqual({ codex: f.tvHome });
    const { db, rigRepo, rig, node } = seat(f.tvHome);
    expect(nodeRuntimeHomes(db, node.id)).toEqual({ codex: f.tvHome });
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s1', ?, 'checker@device-io', 'running')").run(node.id);
    expect(sessionRuntimeHomes(db, "checker@device-io")).toEqual({ codex: f.tvHome });
    rigRepo.setRigRuntimeHomes(rig.id, { codex: f.tvHome, claude: "/c" });
    expect(rigRepo.getRigRuntimeHomes(rig.id)).toEqual({ codex: f.tvHome, claude: "/c" });
  });

  it("a fresh launch or restore creates the seat's tmux session with CODEX_HOME", async () => {
    const { db, rigRepo, rig } = seat("/accounts/tv");
    const createSession = vi.fn(async () => ({ ok: true as const }));
    const tmux = { createSession, killSession: async () => ({ ok: true }), listPanes: async () => [], hasSession: async () => false } as unknown as TmuxAdapter;
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db), tmuxAdapter: tmux, sessionEnv: { HOME: "/h", CODEX_HOME: "/h/.codex" } });
    expect((await launcher.launchNode(rig.id, "dev.checker")).ok).toBe(true);
    expect((createSession.mock.calls[0] as unknown[])[2]).toMatchObject({ CODEX_HOME: "/accounts/tv" });
  });

  it("a handover respawns the pane with the seat's CODEX_HOME", async () => {
    const db = createFullTestDb();
    cleanup.push(() => db.close());
    const respawnPane = vi.fn(async () => ({ ok: true }));
    const tmux = { listPanes: async () => [{ id: "%7", active: true }], respawnPane, setRemainOnExit: async () => ({ ok: true }), signalPaneProcess: async () => ({ ok: true }),
      isPaneDead: async () => true, getDefaultShell: async () => "/bin/zsh", getPaneCommand: async () => "zsh", createSession: async () => ({ ok: true }) } as unknown as TmuxAdapter;
    const adapter = { runtime: "codex", launchHarness: async () => ({ ok: true }), checkReady: async () => ({ ready: true }) } as unknown as RuntimeAdapter;
    const launcher = new SuccessorSessionLauncher(tmux, new DiscoveryRepository(db), { sessionEnv: { HOME: "/h", CODEX_HOME: "/h/.codex" }, runtimeAdapters: { codex: adapter },
      readinessTimeoutMs: 50, sleep: async () => {}, exitPollMs: 1 });
    await launcher.createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w", runtimeHomes: { codex: "/accounts/tv" } }, departingSessionName: "checker@device-io" });
    expect((respawnPane.mock.calls[0] as unknown[])[2]).toMatchObject({ env: { CODEX_HOME: "/accounts/tv" } });
  });

  it.skipIf(process.platform === "win32")("the typed launch command runs codex on the seat's home over the daemon's and the pane rc's", async () => {
    const f = fixture();
    const ids: Record<string, string> = { OPENRIG_NODE_ID: "node-tv", OPENRIG_SESSION_NAME: "checker@device-io", OPENRIG_RUNTIME: "codex" };
    const tmux = { getPaneCommand: vi.fn(async () => "bash"), getSessionEnv: vi.fn(async (_s: string, k: string) => ids[k]) } as unknown as TmuxAdapter;
    const launch = (homes: Record<string, { codex?: string }>) => new SeatLaunchEnvironment(tmux, f.env, f.root, path.join(f.bin, "rig"), f.daemonHome, (nodeId) => homes[nodeId] ?? {});
    const target = { codexCwd: f.cwd, nodeId: "node-tv", runtime: "codex" };
    expect(await f.run(await launch({ "node-tv": { codex: f.tvHome } }).command("checker@device-io", "codex --versionless", target))).toBe(f.tvHome);
    expect(await f.run(await launch({}).command("checker@device-io", "codex --versionless", target))).toBe(f.daemonHome);
    vi.mocked(tmux.getSessionEnv).mockRejectedValue(new Error("unavailable"));
    expect(await f.run(await launch({ "node-tv": { codex: f.tvHome } }).command("checker@device-io", "codex --versionless", target))).toBe(f.tvHome);
  });

  it("a fresh launch captures the new thread id from the seat's home and prepares that home, not the daemon's", async () => {
    const f = fixture();
    seedThread(f.daemonHome, "daemon-thread");
    seedThread(f.tvHome, "tv-thread");
    const sendShellCommand = vi.fn(async (_s: string, _cmd: string) => ({ ok: true }));
    const tmux = { sendShellCommand, getPanePid: async () => 7 } as unknown as TmuxAdapter;
    const fsOps = { homedir: f.home, readFile: (p: string) => fs.readFileSync(p, "utf8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c), exists: fs.existsSync, mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); } };
    const seatRules = vi.fn(), daemonRules = vi.fn();
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps, codexHome: f.daemonHome, launchPath: f.env.PATH, projectRules: daemonRules, resolveGitAddDirs: async () => [],
      listProcesses: () => [{ pid: 42, ppid: 7, command: "codex" }],
      seatHomeServices: (nodeId) => nodeId === "node-tv" ? { codexHome: f.tvHome, projectRules: seatRules } : undefined });
    vi.spyOn(adapter as never, "dismissSkippableCodexUpdatePrompt").mockResolvedValue(undefined as never);
    adapter.ensureManagedBootstrap({ cwd: f.cwd, nodeId: "node-tv" });
    const result = await adapter.launchHarness({ nodeId: "node-tv", tmuxSession: "checker@device-io", cwd: f.cwd } as never, { name: "checker" });
    expect(result).toMatchObject({ ok: true, resumeToken: "tv-thread" });
    expect(await f.run(sendShellCommand.mock.calls[0]![1])).toBe(f.tvHome);
    expect(seatRules).toHaveBeenCalled();
    expect(daemonRules).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.tvHome, "config.toml"), "utf8")).toContain(f.cwd);
    expect(fs.existsSync(path.join(f.daemonHome, "config.toml"))).toBe(false);
  });

  it("the resume refresher reads a seat's thread id from its own home", async () => {
    const f = fixture();
    seedThread(f.daemonHome, "daemon-thread");
    seedThread(f.tvHome, "tv-thread");
    const db = createFullTestDb();
    cleanup.push(() => db.close());
    const refresher = new ResumeMetadataRefresher({ sessionRegistry: new SessionRegistry(db), tmuxAdapter: { getPanePid: async () => 7 } as unknown as TmuxAdapter,
      listProcesses: () => [{ pid: 42, ppid: 7, command: "codex", startedAt: "Sat Oct  3 00:00:00 2026" } as never], homeDir: f.home, codexHome: f.daemonHome, sleep: async () => {},
      seatCodexHome: (sessionName) => sessionName === "checker@device-io" ? f.tvHome : undefined });
    expect(await refresher.captureCodexThreadId("checker@device-io", { attempts: 1 })).toBe("tv-thread");
    expect(await refresher.captureCodexThreadId("other@kernel", { attempts: 1 })).toBe("daemon-thread");
  });

  it("restore resumes the seat's thread from its own home, keeping its recorded policy", async () => {
    const f = fixture();
    seedThread(f.tvHome, "tv-thread");
    const sendShellCommand = vi.fn(async (_s: string, _cmd: string) => ({ ok: true }));
    const tmux = { sendShellCommand } as unknown as TmuxAdapter;
    const resume = new CodexResumeAdapter(tmux, { codexHome: f.daemonHome, launchPath: f.env.PATH, readPriorPolicy: makeCodexPriorPolicyReader(f.daemonHome),
      seatHomeServices: (sessionName) => sessionName === "checker@device-io" ? { codexHome: f.tvHome, readPriorPolicy: makeCodexPriorPolicyReader(f.tvHome) } : undefined });
    vi.spyOn(resume as never, "verifyResume").mockResolvedValue({ ok: true } as never);
    const result = await resume.resume("checker@device-io", "codex_id", "tv-thread", f.cwd);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const cmd = sendShellCommand.mock.calls[0]![1];
    expect(cmd).toContain("-s workspace-write -a on-request");
    expect(cmd).toContain("tv-thread");
    expect(cmd).toContain(`CODEX_HOME=${shellQuote(f.tvHome)}`);
  });

  it.skipIf(process.platform === "win32")("restore stays on the seat's home when the typed launch falls back", async () => {
    const f = fixture();
    const sendShellCommand = vi.fn(async (_s: string, _cmd: string) => ({ ok: true }));
    const tmux = { sendShellCommand, getPaneCommand: vi.fn(async () => "bash"), getSessionEnv: vi.fn(async () => { throw new Error("unavailable"); }) } as unknown as TmuxAdapter;
    const launch = new SeatLaunchEnvironment(tmux, f.env, f.root, path.join(f.bin, "rig"), f.daemonHome);
    const resume = new CodexResumeAdapter(tmux, { seatLaunchEnvironment: launch, codexHome: f.daemonHome, launchPath: f.env.PATH,
      seatHomeServices: (sessionName) => sessionName === "checker@device-io" ? { codexHome: f.tvHome } : undefined });
    vi.spyOn(resume as never, "verifyResume").mockResolvedValue({ ok: true } as never);
    expect((await resume.resume("checker@device-io", "codex_id", "tv-thread", f.cwd)).ok).toBe(true);
    expect(await f.run(sendShellCommand.mock.calls[0]![1])).toBe(f.tvHome);
  });

  it("startup gives a seat's own home the shared rules and the activity hooks", async () => {
    const f = fixture();
    vi.spyOn(os, "homedir").mockReturnValue(f.home);
    for (const [k, v] of Object.entries(f.env)) vi.stubEnv(k, v);
    vi.stubEnv("CODEX_HOME", f.daemonHome);
    vi.stubEnv("OPENRIG_DB", path.join(f.root, "instance.sqlite")); vi.stubEnv("OPENRIG_NO_KERNEL", "1");
    vi.stubEnv("OPENRIG_RUNTIME_CODEX_HOOKS_ENABLED", "true"); vi.stubEnv("OPENRIG_URL", undefined); vi.stubEnv("OPENRIG_PORT", undefined);
    const { createDaemon } = await import("../src/startup.js");
    const daemon = await createDaemon({ dbPath: process.env.OPENRIG_DB!, tmuxExec: async () => "", cmuxFactory: async () => { throw Error("fixture: no cmux"); } });
    try {
      const rigRepo = new RigRepository(daemon.db);
      const node = rigRepo.addNode(rigRepo.createRig("device-io").id, "dev.checker", { runtime: "codex", cwd: f.cwd, runtimeHomes: { codex: f.tvHome } });
      const adapter = daemon.deps.runtimeAdapters!.codex as CodexRuntimeAdapter;
      (adapter as unknown as { homeServices(id: string): { codexHome?: string; projectRules?: () => void } }).homeServices(node.id).projectRules!();
      expect(fs.existsSync(path.join(f.tvHome, "rules", "openrig.rules"))).toBe(true);
      expect(fs.readFileSync(path.join(f.tvHome, "config.toml"), "utf8")).toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
      expect(fs.readdirSync(f.tvHome).sort()).toEqual(["config.toml", "rules"]);
      seedThread(f.tvHome, "tv-thread");
      expect((daemon.deps.contextUsageStore as unknown as { readCodexThread(id: string): { rollout_path: string } | null }).readCodexThread("tv-thread")?.rollout_path)
        .toBe(path.join(f.tvHome, "rollout-tv-thread.jsonl"));
    } finally { daemon.db.close(); }
  }, 60000);
});
