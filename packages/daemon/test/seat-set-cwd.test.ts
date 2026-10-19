import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import nodePath from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const screen = "Restored conversation\n────────────────\n❯ \n────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle)\n";
const token = "00000000-0000-4000-8000-000000000042";
const name = "review-a@cwd-rig";

function fixture() {
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const snapshotRepo = new SnapshotRepository(db);
  const checkpointStore = new CheckpointStore(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "seat-set-cwd-"));
  const oldCwd = nodePath.join(root, "old"), newCwd = nodePath.join(root, "new");
  fs.mkdirSync(oldCwd); fs.mkdirSync(newCwd);
  const rig = rigRepo.createRig("cwd-rig");
  db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("review-pod", rig.id, "Review");
  const node = rigRepo.addNode(rig.id, "review.a", { runtime: "claude-code", podId: "review-pod", cwd: oldCwd, model: "claude-opus-5-5" });
  const sibling = rigRepo.addNode(rig.id, "review.b", { runtime: "claude-code", podId: "review-pod", cwd: oldCwd });
  const session = sessionRegistry.registerSession(node.id, name);
  sessionRegistry.updateStatus(session.id, "running");
  sessionRegistry.updateResumeToken(session.id, "claude_id", token, "hook");
  sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%old" });
  db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");

  let live = true;
  const tmux = {
    hasSession: vi.fn(async () => live),
    probeSession: vi.fn(async () => ({ state: live ? "present" : "absent" })),
    killSession: vi.fn(async () => { live = false; return { ok: true }; }),
    createSession: vi.fn(async () => { live = true; return { ok: true }; }),
    listSessions: vi.fn(async () => live ? [{ name }] : []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => [{ id: "%new", index: 0, cwd: "/", width: 80, height: 24, active: true }]),
    getPanePid: vi.fn(async () => 100),
    getPaneCommand: vi.fn(async () => "sh"),
    capturePaneContent: vi.fn(async () => screen),
    sendText: vi.fn(async () => ({ ok: true })),
    sendShellCommand: vi.fn(async () => ({ ok: true })),
    sendKeys: vi.fn(async () => ({ ok: true })),
  } as unknown as TmuxAdapter;
  const startedAt = "Thu Oct  1 05:53:16 2026";
  const listProcesses = async () => [
    { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt },
    { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "sh", command: "/bin/sh /tmp/fixture-launch.txt", startedAt },
    { pid: 102, ppid: 101, pgid: 101, tpgid: 101, executableName: "claude", command: `/opt/claude.exe --resume ${token} --name ${name}`, startedAt },
  ];
  new NativePermissionStore(db).write(node.id, { runtime: "claude-code", mode: "auto" }, "fixture", "managed posture");
  const prepared: string[] = [];
  const prepare = async (request: { nodeId: string; cwd?: string }) => {
    const live = (db.prepare("SELECT cwd FROM nodes WHERE id = ?").get(request.nodeId) as { cwd: string }).cwd;
    if (request.cwd !== undefined && request.cwd !== live) throw new Error("Claude managed launch target disagrees with the current binding; no input or selection changed.");
    prepared.push(live);
    return { command: (args: readonly string[]) => `claude ${args.join(" ")}`, assertCurrent: () => {}, configDir: "/fixture", executable: "/opt/claude.exe" };
  };
  const adapter = new ClaudeCodeAdapter({ tmux, listProcesses, sleep: async () => {},
    claudeManagedLaunch: { prepare } as unknown as ClaudeManagedLaunch,
    fsOps: { exists: () => false, readFile: () => "", writeFile: () => {}, mkdirp: () => {}, copyFile: () => {} } });
  const restore = new RestoreOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
    checkpointStore, nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
    tmuxAdapter: tmux, claudeResume: new ClaudeResumeAdapter(tmux), codexResume: new CodexResumeAdapter(tmux), listProcesses });
  const lifecycle = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const move = async (cwd: string) => {
    const changed = lifecycle.setCwd({ seatRef: name, cwd, reason: "move" });
    if (!changed.ok) throw new Error(changed.message);
    const snapshot = snapshotCapture.captureSnapshot(rig.id, "manual");
    const stopped = await lifecycle.stopSeat({ seatRef: name, reason: "move" });
    if (!stopped.ok) throw new Error(stopped.message);
    const launched = await restore.launchSingleNode(rig.id, "review.a", { snapshotId: snapshot.id, adapters: { "claude-code": adapter } });
    if (!launched.ok) throw new Error(launched.message);
    const latest = db.prepare("SELECT id FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(node.id) as { id: string };
    sessionRegistry.updateResumeToken(latest.id, "claude_id", token, "hook");
    return launched.launched?.[0];
  };
  return { db, rig, node, sibling, root, oldCwd, newCwd, tmux, prepared, move, lifecycle };
}

describe("rig seat set-cwd", () => {
  const roots: string[] = [];
  const dbs: Array<{ close(): void }> = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  function setup() {
    const f = fixture();
    dbs.push(f.db); roots.push(f.root);
    return f;
  }

  it("persists only the target seat's cwd, with one audited event", () => {
    const f = setup();
    const before = f.db.prepare("SELECT * FROM nodes ORDER BY id").all() as Array<Record<string, unknown>>;
    const sessionsBefore = f.db.prepare("SELECT * FROM sessions ORDER BY id").all();

    const result = f.lifecycle.setCwd({ seatRef: name, cwd: `${f.newCwd}/`, reason: "move to own worktree", operator: "operator-agent@kernel" });

    expect(result).toMatchObject({ ok: true, from: f.oldCwd, to: f.newCwd, changed: true });
    const after = f.db.prepare("SELECT * FROM nodes ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(after).toEqual(before.map(row => row["id"] === f.node.id ? { ...row, cwd: f.newCwd } : row));
    expect(f.db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(sessionsBefore);
    const events = f.db.prepare("SELECT payload FROM events WHERE type = 'node.cwd_changed'").all() as Array<{ payload: string }>;
    expect(events.map(e => JSON.parse(e.payload))).toEqual([expect.objectContaining({
      nodeId: f.node.id, logicalId: "review.a", from: f.oldCwd, to: f.newCwd, reason: "move to own worktree", operator: "operator-agent@kernel",
    })]);
    expect(f.lifecycle.setCwd({ seatRef: name, cwd: f.newCwd, reason: "again" })).toMatchObject({ ok: true, changed: false });
  });

  it("refuses a relative, missing or file path and a missing reason without changing anything", () => {
    const f = setup();
    const file = nodePath.join(f.root, "file");
    fs.writeFileSync(file, "");
    for (const cwd of ["new", nodePath.join(f.root, "absent"), file, ""]) {
      expect(f.lifecycle.setCwd({ seatRef: name, cwd, reason: "x" })).toMatchObject({ ok: false, code: "invalid_cwd" });
    }
    expect(f.lifecycle.setCwd({ seatRef: name, cwd: f.newCwd, reason: " " })).toMatchObject({ ok: false, code: "missing_reason" });
    expect(f.lifecycle.setCwd({ seatRef: "ghost@cwd-rig", cwd: f.newCwd, reason: "x" })).toMatchObject({ ok: false, code: "seat_not_found" });
    expect(f.db.prepare("SELECT cwd FROM nodes WHERE id = ?").get(f.node.id)).toEqual({ cwd: f.oldCwd });
    expect(f.db.prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'node.cwd_changed'").get()).toEqual({ c: 0 });
  });

  it("set-cwd, snapshot, seat stop, launch --snapshot-id resumes the same native session in the new cwd, and the same steps move it back", async () => {
    const f = setup();

    expect(await f.move(f.newCwd)).toMatchObject({ logicalId: "review.a", status: "resumed" });
    expect(f.tmux.createSession).toHaveBeenLastCalledWith(name, f.newCwd, expect.anything());
    expect(f.prepared).toEqual([f.newCwd]);
    expect(f.tmux.sendShellCommand).toHaveBeenLastCalledWith(name, expect.stringContaining(`--resume ${token} --name ${name}`), expect.any(Function));

    expect(await f.move(f.oldCwd)).toMatchObject({ status: "resumed" });
    expect(f.tmux.createSession).toHaveBeenLastCalledWith(name, f.oldCwd, expect.anything());
    expect(f.prepared).toEqual([f.newCwd, f.oldCwd]);
    expect(f.db.prepare("SELECT cwd FROM nodes WHERE id = ?").get(f.sibling.id)).toEqual({ cwd: f.oldCwd });
  });
});
