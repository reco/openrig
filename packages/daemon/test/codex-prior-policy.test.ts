import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { ROLLOUT_CHUNK, makeCodexPriorPolicyReader, readCodexPriorPolicy, type CodexPriorPolicyResult } from "../src/domain/codex-prior-policy.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const turn = (sandbox: object, approval: string, effort: string) => JSON.stringify({ type: "turn_context", payload: { approval_policy: approval, sandbox_policy: sandbox, effort, model: "gpt-6.1-sol" } });
const QUEUE_WORKER = { ok: true as const, policy: { sandbox: "workspace-write", approval: "on-request", effort: "high", writableRoots: ["/state/queue"], networkAccess: true } };

function tmux() {
  return mockShellCommand({
    sendText: vi.fn(async () => ({ ok: true as const })), sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "codex"), capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything"),
    capturePaneScreen: vi.fn(async () => "› Ask Codex to do anything"), getPanePid: vi.fn(async () => null),
    createSession: async () => ({ ok: true as const }), killSession: async () => ({ ok: true as const }),
    listSessions: async () => [], listWindows: async () => [], listPanes: async () => [], hasSession: async () => false,
  } as unknown as TmuxAdapter);
}
const sent = (t: TmuxAdapter) => (t.sendText as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as string);

describe("same-conversation Codex resume keeps the conversation's own policy", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const dir = () => { const d = mkdtempSync(join(tmpdir(), "codex-prior-")); dirs.push(d); return d; };

  it("reads the newest turn_context's sandbox, approval, effort, writable roots and network", () => {
    const d = dir(), rollout = join(d, "rollout.jsonl");
    writeFileSync(rollout, [
      turn({ type: "danger-full-access" }, "never", "medium"),
      JSON.stringify({ type: "event_msg", payload: {} }),
      turn({ type: "workspace-write", writable_roots: ["/state/queue"], network_access: true }, "on-request", "high"),
      JSON.stringify({ type: "response_item", payload: {} }), "",
    ].join("\n"));
    expect(readCodexPriorPolicy(rollout)).toEqual(QUEUE_WORKER);
    writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: {} }));
    expect(readCodexPriorPolicy(rollout)).toMatchObject({ ok: false, reason: "the rollout has no turn_context" });
    writeFileSync(rollout, turn({ type: "something-new" }, "on-request", "high"));
    expect(readCodexPriorPolicy(rollout).ok).toBe(false);
  });

  it("reads a turn_context that straddles chunk boundaries, multi-byte path intact", () => {
    const d = dir(), rollout = join(d, "rollout.jsonl");
    const line = turn({ type: "workspace-write", writable_roots: ["/state/ümlaut-ü"], network_access: false }, "on-request", "xhigh");
    for (let shift = 0; shift < 12; shift++) {
      const padding = JSON.stringify({ type: "event_msg", payload: { pad: "x".repeat(ROLLOUT_CHUNK - line.length + shift) } });
      writeFileSync(rollout, `${line}\n${padding}\n`);
      expect(readCodexPriorPolicy(rollout), `shift ${shift}`).toEqual({ ok: true, policy: { sandbox: "workspace-write", approval: "on-request", effort: "xhigh", writableRoots: ["/state/ümlaut-ü"], networkAccess: false } });
    }
  });

  it("finds the rollout through Codex's own state database", () => {
    const home = dir(), rollout = join(home, "sessions", "r.jsonl");
    mkdirSync(join(home, "sessions"));
    writeFileSync(rollout, turn({ type: "workspace-write", writable_roots: ["/state/queue"], network_access: true }, "on-request", "high"));
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT)");
    db.prepare("INSERT INTO threads VALUES (?, ?)").run("thread-1", rollout);
    db.close();
    const read = makeCodexPriorPolicyReader(home);
    expect(read("thread-1")).toEqual(QUEUE_WORKER);
    expect(read("thread-2")).toMatchObject({ ok: false, reason: "no rollout recorded for thread thread-2" });
  });

  it("a kernel seat's legacy resume reproduces workspace-write/on-request/high and its roots instead of full access", async () => {
    const t = tmux();
    const adapter = new CodexResumeAdapter(t, { readPriorPolicy: () => QUEUE_WORKER });
    const result = await adapter.resume("queue-worker@kernel", "codex_id", "thread-1", "/ws", null, "full_bypass", "gpt-6.1-sol", null, true, true);
    expect(result).toMatchObject({ ok: true, appliedLaunch: { value: "workspace-write", approvalPolicy: null } });
    const [cmd] = sent(t);
    expect(cmd).toContain(" -s workspace-write -a on-request -c 'sandbox_workspace_write.network_access=true' --add-dir '/state/queue'");
    expect(cmd).toContain(`model_reasoning_effort="high"`);
    expect(cmd).not.toContain("danger-full-access");
    expect(cmd).not.toContain("-a never");
  });

  it("an explicitly chosen effort still wins over the prior one", async () => {
    const t = tmux();
    await new CodexResumeAdapter(t, { readPriorPolicy: () => QUEUE_WORKER }).resume("s@r", "codex_id", "thread-1", "/ws", null, "floor", null, "low");
    expect(sent(t)[0]).toContain(`model_reasoning_effort="low"`);
  });

  it("a blank effort setting does not drop the prior effort", async () => {
    const t = tmux();
    await new CodexResumeAdapter(t, { readPriorPolicy: () => QUEUE_WORKER }).resume("s@r", "codex_id", "thread-1", "/ws", null, "floor", null, "  ");
    expect(sent(t)[0]).toContain(`model_reasoning_effort="high"`);
  });

  it("refuses rather than apply defaults when the prior policy cannot be established", async () => {
    const t = tmux();
    const unknown: CodexPriorPolicyResult = { ok: false, reason: "the rollout has no turn_context" };
    const result = await new CodexResumeAdapter(t, { readPriorPolicy: () => unknown }).resume("s@r", "codex_id", "thread-1", "/ws", null, "full_bypass");
    expect(result).toMatchObject({ ok: false, code: "resume_failed" });
    expect((result as { message: string }).message).toContain("prior sandbox/approval/effort cannot be established");
    expect(sent(t)).toEqual([]);
  });

  it("the pod-aware resume path does the same, and refuses the same way", async () => {
    const binding = { id: "b", nodeId: "n", tmuxSession: "queue-worker@kernel", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/ws", kernelAuthority: true, launchPosture: "full_bypass", nonInterruptive: true } as NodeBinding;
    const fsOps = { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, listFiles: () => [], homedir: "/h" };
    const t = tmux();
    await new CodexRuntimeAdapter({ tmux: t, fsOps, readPriorPolicy: () => QUEUE_WORKER, sleep: async () => {} } as never).launchHarness(binding, { name: "queue-worker@kernel", resumeToken: "thread-1" });
    expect(sent(t)[0]).toContain(" -s workspace-write -a on-request");
    expect(sent(t)[0]).toContain(`model_reasoning_effort="high"`);
    expect(sent(t)[0]).not.toContain("danger-full-access");
    const t2 = tmux();
    const refused = await new CodexRuntimeAdapter({ tmux: t2, fsOps, readPriorPolicy: () => ({ ok: false, reason: "no rollout recorded for thread thread-1" }), sleep: async () => {} } as never).launchHarness(binding, { name: "queue-worker@kernel", resumeToken: "thread-1" });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("prior sandbox/approval/effort cannot be established") });
    expect(sent(t2)).toEqual([]);
  });
});
