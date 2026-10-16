import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { createFullTestDb, createTestApp, migrationsForFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { seatGuidance, restoreMissingGuidance } from "../src/domain/restore-guidance.js";
import { CODEX_REPOSITORY_COPY_BLOCK } from "../src/domain/managed-blocks.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { NodeStartupSnapshot } from "../src/domain/types.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// managed_blocks: { codex: AGENTS.override.md } keeps OpenRig's managed guidance out of a tracked
// AGENTS.md. Codex reads one instruction file per directory and AGENTS.override.md wins, so the
// override also carries a copy of AGENTS.md; the native check asks a real Codex what it would read.

const BEGIN = "<!-- BEGIN OpenRig MANAGED BLOCK:";
const OVERRIDE = "managed_blocks:\n  codex: AGENTS.override.md";
const REPO_AGENTS_MD = "# Repository rules\n\nREPO-AGENTS-MARKER: run the tests before committing.\n";

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "codex"),
    capturePaneContent: vi.fn(async () => ">"),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
  } as unknown as TmuxAdapter;
}

function noopAdapter(runtime: string): RuntimeAdapter {
  return {
    runtime,
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fixture(managedBlocksYaml: string, files: Record<string, string> = {}) {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-codex-local-"));
  tmpDirs.push(root);
  const rigRoot = nodePath.join(root, "rig");
  const cwd = nodePath.join(root, "repo");
  const home = nodePath.join(root, "home");
  fs.mkdirSync(nodePath.join(rigRoot, "agents", "impl"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(nodePath.join(rigRoot, "agents", "impl", "agent.yaml"),
    `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(nodePath.join(cwd, name), content);

  const db = createDb(nodePath.join(root, "openrig.sqlite"));
  migrate(db, migrationsForFullTestDb);
  const rigRepo = new RigRepository(db);
  const podRepo = new PodRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const tmux = mockTmux();
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const resolverFs: AgentResolverFsOps = { readFile: (p) => fs.readFileSync(p, "utf-8"), exists: (p) => fs.existsSync(p) };
  const inst = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
    fsOps: resolverFs, tmuxAdapter: tmux,
    adapters: { "claude-code": noopAdapter("claude-code"), codex: noopAdapter("codex"), terminal: noopAdapter("terminal") },
  } as never);
  const codex = new CodexRuntimeAdapter({
    tmux, sleep: async () => {}, codexHome: nodePath.join(home, ".codex"),
    fsOps: {
      readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c),
      exists: (p: string) => fs.existsSync(p),
      mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
      listFiles: (dir: string) => (fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir) : []),
      homedir: home,
    },
  } as never);
  const yaml = [
    `version: "0.2"`, `name: codex-local`, managedBlocksYaml, `pods:`, `  - id: dev`, `    label: Dev`, `    members:`,
    `      - id: check`, `        agent_ref: "local:agents/impl"`, `        profile: default`, `        runtime: codex`, `        cwd: "${cwd}"`,
    `    edges: []`, `edges: []`,
  ].filter(Boolean).join("\n") + "\n";
  const read = (name: string) => {
    const p = nodePath.join(cwd, name);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
  };
  return { db, rigRepo, podRepo, sessionRegistry, eventBus, tmux, startupOrchestrator, inst, codex, yaml, rigRoot, cwd, home, read };
}

type Fixture = ReturnType<typeof fixture>;

function startupContext(f: Fixture, nodeId: string) {
  return f.db.prepare("SELECT projection_entries_json, resolved_files_json, startup_actions_json FROM node_startup_context WHERE node_id = ?")
    .get(nodeId) as { projection_entries_json: string; resolved_files_json: string; startup_actions_json: string };
}

async function instantiate(f: Fixture): Promise<{ rigId: string; nodeId: string }> {
  const result = await f.inst.instantiate(f.yaml, f.rigRoot);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const rigId = (result as { ok: true; result: { rigId: string } }).result.rigId;
  return { rigId, nodeId: f.rigRepo.getRig(rigId)!.nodes[0]!.id };
}

/** Instantiate the rig, then project and deliver the seat's saved startup through the real Codex
 *  adapter, bound as startNode binds it (the rig row's selection; proven separately below). */
async function launch(f: Fixture): Promise<{ rigId: string; nodeId: string }> {
  const ids = await instantiate(f);
  const ctx = startupContext(f, ids.nodeId);
  const selected = f.rigRepo.getRigCodexManagedBlockFile(ids.rigId);
  const binding = { cwd: f.cwd, ...(selected ? { codexManagedBlockFile: selected } : {}) } as NodeBinding;
  const plan = { runtime: "codex", cwd: f.cwd, entries: JSON.parse(ctx.projection_entries_json), startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] };
  expect((await f.codex.project(plan, binding)).failed).toEqual([]);
  expect((await f.codex.deliverStartup(JSON.parse(ctx.resolved_files_json), binding)).failed).toEqual([]);
  return ids;
}

const blockCount = (text: string | null) => (text ?? "").split(BEGIN).length - 1;

describe("managed_blocks.codex selects where a Codex seat's managed guidance goes", () => {
  it("AGENTS.override.md receives the blocks and a copy of AGENTS.md; AGENTS.md stays byte-identical", async () => {
    const f = fixture(OVERRIDE, { "AGENTS.md": REPO_AGENTS_MD });
    await launch(f);
    const override = f.read("AGENTS.override.md")!;
    expect(f.read("AGENTS.md")).toBe(REPO_AGENTS_MD);
    expect(override).toContain(`${BEGIN} ${CODEX_REPOSITORY_COPY_BLOCK} -->\n${REPO_AGENTS_MD.trim()}\n`);
    expect(override).toContain(`${BEGIN} openrig-start.md -->`);
    expect(override.indexOf(CODEX_REPOSITORY_COPY_BLOCK)).toBeLessThan(override.indexOf("openrig-start.md"));
    f.db.close();
  });

  it("startNode (launch, restore replay, relaunch, added member) binds the rig row's selection for the adapter", async () => {
    const f = fixture(OVERRIDE);
    const { rigId, nodeId } = await instantiate(f);
    const session = f.sessionRegistry.getSessionsForRig(rigId).find((s) => s.nodeId === nodeId)!;
    const bindings: NodeBinding[] = [];
    const recording: RuntimeAdapter = {
      ...noopAdapter("codex"),
      project: vi.fn(async (_plan, binding: NodeBinding) => { bindings.push(binding); return { projected: [], skipped: [], failed: [] }; }),
    };
    await f.startupOrchestrator.startNode({
      rigId, nodeId, sessionId: session.id, binding: { cwd: f.cwd, tmuxSession: session.sessionName } as NodeBinding, adapter: recording,
      plan: { runtime: "codex", cwd: f.cwd, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: session.sessionName, skipHarnessLaunch: true,
    });
    expect(bindings[0]?.codexManagedBlockFile).toBe("AGENTS.override.md");
    f.db.close();
  });

  it("absent managed_blocks keeps AGENTS.md and writes no override", async () => {
    const f = fixture("", { "AGENTS.md": REPO_AGENTS_MD });
    await launch(f);
    expect(f.read("AGENTS.md")).toContain(`${BEGIN} openrig-start.md -->`);
    expect(f.read("AGENTS.override.md")).toBeNull();
    f.db.close();
  });

  it("without an AGENTS.md the override holds only the blocks", async () => {
    const f = fixture(OVERRIDE);
    await launch(f);
    expect(f.read("AGENTS.override.md")).not.toContain(CODEX_REPOSITORY_COPY_BLOCK);
    expect(blockCount(f.read("AGENTS.override.md"))).toBeGreaterThan(0);
    expect(f.read("AGENTS.md")).toBeNull();
    f.db.close();
  });

  it("the copy leaves out AGENTS.md's own managed blocks and repeated projection is idempotent; user override text stays", async () => {
    const tracked = `${REPO_AGENTS_MD}\n<!-- BEGIN OpenRig MANAGED BLOCK: openrig-start.md -->\nold\n<!-- END OpenRig MANAGED BLOCK: openrig-start.md -->\n`;
    const f = fixture(OVERRIDE, { "AGENTS.md": tracked, "AGENTS.override.md": "my local note\n" });
    const { nodeId } = await launch(f);
    const first = f.read("AGENTS.override.md")!;
    expect(first.startsWith("my local note")).toBe(true);
    expect(first).not.toContain("\nold\n");
    expect(f.read("AGENTS.md")).toBe(tracked);
    const files = JSON.parse(startupContext(f, nodeId).resolved_files_json);
    await f.codex.deliverStartup(files, { cwd: f.cwd, codexManagedBlockFile: "AGENTS.override.md" } as NodeBinding);
    expect(blockCount(f.read("AGENTS.override.md"))).toBe(blockCount(first));
    expect(f.read("AGENTS.override.md")!.trimEnd()).toBe(first.trimEnd());
    f.db.close();
  });

  it("teardown strips the override (removed when only managed text) and leaves AGENTS.md alone", async () => {
    const f = fixture(OVERRIDE, { "AGENTS.md": REPO_AGENTS_MD });
    const { rigId } = await launch(f);
    await new RigTeardownOrchestrator({
      db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, tmuxAdapter: f.tmux, eventBus: f.eventBus,
      snapshotCapture: { db: f.db, captureSnapshot: vi.fn(() => ({ id: "snap" })) } as never,
    }).teardown(rigId);
    expect(f.read("AGENTS.override.md")).toBeNull();
    expect(f.read("AGENTS.md")).toBe(REPO_AGENTS_MD);
    f.db.close();
  });

  it("an exact-resume restore puts the copy and the blocks back into the override, never AGENTS.md", async () => {
    const f = fixture(OVERRIDE, { "AGENTS.md": REPO_AGENTS_MD });
    const { nodeId } = await launch(f);
    const expected = f.read("AGENTS.override.md")!;
    fs.rmSync(nodePath.join(f.cwd, "AGENTS.override.md"));
    const ctx = startupContext(f, nodeId);
    const snapshot = { runtime: "codex", projectionEntries: JSON.parse(ctx.projection_entries_json), resolvedStartupFiles: JSON.parse(ctx.resolved_files_json) } as NodeStartupSnapshot;
    const guidance = seatGuidance(snapshot, f.cwd, { codex: "AGENTS.override.md" }, fs.existsSync, (p) => fs.readFileSync(p, "utf-8"))!;
    expect(guidance.targetPath).toBe(nodePath.join(f.cwd, "AGENTS.override.md"));
    const repair = restoreMissingGuidance(guidance, { exists: fs.existsSync, readFile: (p) => fs.readFileSync(p, "utf-8"), writeFile: (p, c) => fs.writeFileSync(p, c) });
    expect(repair.gaps).toEqual([]);
    expect(repair.restored[0]).toBe(CODEX_REPOSITORY_COPY_BLOCK);
    expect(blockCount(f.read("AGENTS.override.md"))).toBe(blockCount(expected));
    expect(f.read("AGENTS.md")).toBe(REPO_AGENTS_MD);
    f.db.close();
  });

  it("export → YAML → parse keeps the codex selection", async () => {
    const f = fixture(OVERRIDE);
    const { rigId } = await launch(f);
    const yaml = RigSpecCodec.serialize(new RigSpecExporter({ rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, podRepo: f.podRepo }).exportRig(rigId) as never);
    expect(RigSpecSchema.normalize(RigSpecCodec.parse(yaml) as Record<string, unknown>).managedBlocks).toEqual({ codex: "AGENTS.override.md" });
    f.db.close();
  });
});

describe("managed_blocks schema", () => {
  const base = (managedBlocks: unknown) => ({
    version: "0.2", name: "r", managed_blocks: managedBlocks,
    pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "codex", cwd: "." }], edges: [] }],
    edges: [],
  });

  it("accepts both Codex files alongside a Claude selection", () => {
    expect(RigSpecSchema.validate(base({ codex: "AGENTS.md" })).errors).toEqual([]);
    expect(RigSpecSchema.validate(base({ codex: "AGENTS.override.md", "claude-code": "CLAUDE.local.md" })).errors).toEqual([]);
  });

  it("rejects any other Codex file, naming the supported ones", () => {
    for (const bad of ["CLAUDE.local.md", "AGENTS.local.md", "docs/AGENTS.md", "", null]) {
      expect(RigSpecSchema.validate(base({ codex: bad })).errors).toEqual([
        `managed_blocks.codex: must be one of AGENTS.md, AGENTS.override.md (got ${JSON.stringify(bad)})`,
      ]);
    }
  });
});

describe("POST /api/rigs/import/managed-blocks (rig import --managed-blocks-only)", () => {
  const post = (app: ReturnType<typeof createTestApp>["app"], body: string, rigId?: string) => app.request("/api/rigs/import/managed-blocks", {
    method: "POST", headers: { "Content-Type": "text/yaml", ...(rigId ? { "X-Target-Rig-Id": rigId } : {}) }, body,
  });

  it("sets both selections on an existing rig, is idempotent, and {} restores the defaults", async () => {
    const db = createFullTestDb();
    const { app, rigRepo } = createTestApp(db);
    const rig = rigRepo.createRig("Imago");
    const nodesBefore = db.prepare("SELECT * FROM nodes WHERE rig_id = ?").all(rig.id);

    const first = await post(app, "managed_blocks:\n  claude-code: CLAUDE.local.md\n  codex: AGENTS.override.md\n", rig.id);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ changed: true, before: { "claude-code": null, codex: null }, managedBlocks: { "claude-code": "CLAUDE.local.md", codex: "AGENTS.override.md" } });
    expect(rigRepo.getRigClaudeManagedBlockFile(rig.id)).toBe("CLAUDE.local.md");
    expect(rigRepo.getRigCodexManagedBlockFile(rig.id)).toBe("AGENTS.override.md");

    const again = await post(app, "managed_blocks:\n  claude-code: CLAUDE.local.md\n  codex: AGENTS.override.md\n", rig.id);
    expect(await again.json()).toMatchObject({ changed: false });

    const reset = await post(app, "managed_blocks: {}\n", rig.id);
    expect(await reset.json()).toMatchObject({ changed: true, managedBlocks: { "claude-code": null, codex: null } });
    expect(rigRepo.getRigCodexManagedBlockFile(rig.id)).toBeNull();
    expect(db.prepare("SELECT * FROM nodes WHERE rig_id = ?").all(rig.id)).toEqual(nodesBefore);
    db.close();
  });

  it("refuses a switch while a member's previously selected file still holds blocks, naming it; a rollback the same", async () => {
    const db = createFullTestDb();
    const { app, rigRepo } = createTestApp(db);
    const cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-codex-local-switch-"));
    tmpDirs.push(cwd);
    const rig = rigRepo.createRig("Imago");
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Dev");
    rigRepo.addNode(rig.id, "dev.owner", { runtime: "claude-code", podId: pod.id, agentRef: "local:a", profile: "default", cwd });
    rigRepo.addNode(rig.id, "dev.check", { runtime: "codex", podId: pod.id, agentRef: "local:a", profile: "default", cwd });
    const block = "\n<!-- BEGIN OpenRig MANAGED BLOCK: openrig-start.md -->\nx\n<!-- END OpenRig MANAGED BLOCK: openrig-start.md -->\n";
    fs.writeFileSync(nodePath.join(cwd, "CLAUDE.md"), `# rules\n${block}`);
    fs.writeFileSync(nodePath.join(cwd, "AGENTS.md"), `# rules\n${block}`);
    const forward = "managed_blocks:\n  claude-code: CLAUDE.local.md\n  codex: AGENTS.override.md\n";

    const refused = await post(app, forward, rig.id);
    expect(refused.status).toBe(409);
    const body = await refused.json() as { errors: string[] };
    expect(body.errors.map((e) => e.split(" ")[0])).toEqual([nodePath.join(cwd, "CLAUDE.md"), nodePath.join(cwd, "AGENTS.md")]);
    expect(rigRepo.getRigCodexManagedBlockFile(rig.id)).toBeNull();

    fs.writeFileSync(nodePath.join(cwd, "CLAUDE.md"), "# rules\n");
    fs.writeFileSync(nodePath.join(cwd, "AGENTS.md"), "# rules\n");
    expect((await post(app, forward, rig.id)).status).toBe(200);

    fs.writeFileSync(nodePath.join(cwd, "AGENTS.override.md"), `# rules\n${block}`);
    const rollback = await post(app, "managed_blocks:\n  claude-code: CLAUDE.local.md\n", rig.id);
    expect(rollback.status).toBe(409);
    expect((await rollback.json() as { errors: string[] }).errors).toHaveLength(1);
    expect(rigRepo.getRigCodexManagedBlockFile(rig.id)).toBe("AGENTS.override.md");
    db.close();
  });

  it("refuses invalid input or target before changing anything", async () => {
    const db = createFullTestDb();
    const { app, rigRepo } = createTestApp(db);
    const rig = rigRepo.createRig("Imago");
    rigRepo.setRigCodexManagedBlockFile(rig.id, "AGENTS.override.md");
    expect((await post(app, "managed_blocks:\n  codex: AGENTS.local.md\n", rig.id)).status).toBe(400);
    expect((await post(app, "name: x\n", rig.id)).status).toBe(400);
    expect((await post(app, "managed_blocks: {}\n")).status).toBe(400);
    expect((await post(app, "managed_blocks: {}\n", "no-such-rig")).status).toBe(404);
    expect(rigRepo.getRigCodexManagedBlockFile(rig.id)).toBe("AGENTS.override.md");
    db.close();
  });
});

function codexBinary(): string | null {
  const bin = process.env.CODEX_NATIVE_BIN ?? "codex";
  try {
    execFileSync(bin, ["debug", "prompt-input", "--help"], { encoding: "utf8", stdio: "pipe" });
    return bin;
  } catch { return null; }
}

const bin = codexBinary();
describe.skipIf(!bin)("native Codex reads the projected instructions", () => {
  it("with AGENTS.override.md selected, the model-visible input holds both the repository AGENTS.md and the managed guidance", async () => {
    const f = fixture(OVERRIDE, { "AGENTS.md": REPO_AGENTS_MD });
    await launch(f);
    const codexHome = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-codex-local-home-"));
    tmpDirs.push(codexHome);
    const input = execFileSync(bin!, ["debug", "prompt-input", "hi"], { cwd: f.cwd, env: { ...process.env, CODEX_HOME: codexHome }, encoding: "utf8" });
    expect(input).toContain("REPO-AGENTS-MARKER");
    const lastEnd = f.read("AGENTS.override.md")!.trimEnd().split("\n").at(-1)!;
    expect(lastEnd).toMatch(/^<!-- END OpenRig MANAGED BLOCK: /);
    expect(input).toContain(lastEnd);
    f.db.close();
  }, 30_000);
});
