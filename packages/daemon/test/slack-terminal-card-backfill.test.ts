// The terminal-resolution backfill selects only cards whose own ledger says they closed as answered in the
// terminal, and applies the compact shape by rewriting the bot's own messages only, details reply first.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { applyTerminalResolvedCard, planTerminalResolvedCards, type SlackThreadOps } from "../src/domain/gateway/slack/terminal-card-backfill.js";

const card = (session: string, tags: string[] = []) => ({ sourceSession: session, destinationSession: "reco@external", humanIntent: "decision" as const,
  summary: `${session} is waiting at a permission prompt`, body: `\`\`\`\ngh run view ${session}\n\`\`\`\n\nAttach: \`tmux attach -t ${session}\``, tags: ["stuck-prompt", ...tags], nudge: false,
  humanQuestions: [{ id: "answer", question: "Answer?", options: [{ id: "allow", label: "Approve" }, { id: "deny", label: "Deny" }] }] });

describe("terminal-resolved card backfill", () => {
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); repo = new QueueRepository(db, new EventBus(db)); });
  afterEach(() => db.close());

  async function closed(n: number, session: string, closeNote: string, opts: { tags?: string[]; body?: string; before?: (id: string) => void } = {}) {
    const row = await repo.create({ ...card(session, opts.tags), ...(opts.body ? { body: opts.body } : {}) });
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: `slack-posted thread_ts=${n}.1 message_ts=${n}.1 channel=C-MAIN human=reco@external seat=${session} conversation=${row.qitemId}` });
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: `slack-owner-notification-posted notification_key=k level=ALERT kind=human-required message_ts=${n}.1 thread_ts=${n}.1` });
    opts.before?.(row.qitemId);
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", state: "canceled", transitionNote: "stuck-prompt cleared: answered in the terminal" });
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: closeNote });
    return row.qitemId;
  }
  const STUCK = "request-closed reason=prompt-cleared: answered in the terminal";

  it("plans only cards closed as answered in the terminal, unanswered and not yet compact", async () => {
    const stuck = await closed(1, "cfo@finance", STUCK, { tags: ["prompt-title:Check GitHub Actions status"] });
    const approval = await closed(2, "dev@rig", "request-closed reason=approval-expired: answered in the terminal", { body: "Reason: Run the tests\n```\nnpm test\n```" });
    await closed(3, "ops@rig", "request-closed reason=approval-expired: no answer in time");
    await closed(4, "ops@rig", "request-closed reason=prompt-cleared: replaced by a newer card for this seat");
    await closed(5, "ops@rig", STUCK, { before: (id) => repo.recordHumanAnswer({ qitemId: id, actorSession: "reco@external", questionId: "answer", optionId: "allow" }) });
    const compacted = await closed(6, "ops@rig", STUCK);
    repo.update({ qitemId: compacted, actorSession: "daemon@kernel", transitionNote: 'slack-card-closed channel=C-MAIN message_ts=6.1 compact=true line="x"' });
    const open = (await repo.create(card("lead@rig"))).qitemId;
    repo.update({ qitemId: open, actorSession: "daemon@kernel", state: "canceled", transitionNote: "stuck-prompt cleared: answered in the terminal" });

    const plan = planTerminalResolvedCards(db);
    expect(plan.map((c) => c.qitemId)).toEqual([stuck, approval]);
    expect(plan[0]).toMatchObject({ channel: "C-MAIN", messageTs: "1.1", provenance: "stuck-prompt", line: "Resolved in Terminal · Check GitHub Actions status" });
    expect(plan[0]!.receipt).toContain("```\ngh run view cfo@finance\n```");
    expect(plan[0]!.receipt).not.toContain("tmux attach");
    expect(plan[1]).toMatchObject({ provenance: "approval", line: "Resolved in Terminal · Run the tests" });
    expect(planTerminalResolvedCards(db, [approval]).map((c) => c.qitemId)).toEqual([approval]);
  });

  it("an older card without a title tag is titled by the description line of the Claude dialog it shows, only when a command line follows", async () => {
    const dialog = (lines: string[]) => `\`\`\`\nBash command\nTip: auto mode handles these prompts for you\n${lines.join("\n")}\nThis command requires approval\nDo you want to proceed?\n\`\`\`\n\nAttach: x`;
    const gutter = await closed(1, "a@rig", STUCK, { body: dialog(["Inspect the pending Linear check run", "│ gh run view 38645788786 --json status", "│ --jq .status"]) });
    const plain = await closed(2, "b@rig", STUCK, { body: dialog(["Create empty file x.txt", "touch x.txt"]) });
    const bare = await closed(3, "c@rig", STUCK, { body: dialog(["touch x.txt"]) });
    const wrapped = await closed(4, "d@rig", STUCK, { body: dialog(["│ npm run test --", "│ --reporter verbose"]) });
    const lines = Object.fromEntries(planTerminalResolvedCards(db).map((c) => [c.qitemId, c.line]));
    expect(lines).toEqual({
      [gutter]: "Resolved in Terminal · Inspect the pending Linear check run",
      [plain]: "Resolved in Terminal · Create empty file x.txt",
      [bare]: "Resolved in Terminal · c@rig's prompt",
      [wrapped]: "Resolved in Terminal · d@rig's prompt",
    });
  });

  function fakeSlack(messages: Array<{ ts: string; user?: string; text?: string }>, fail: { update?: string } = {}) {
    const calls: Array<{ op: string; ts: string; text: string; blocks?: unknown[] }> = [];
    const ops: SlackThreadOps = {
      botUser: "UBOT",
      replies: async () => ({ ok: true, messages: messages.map((m) => ({ ...m })) }),
      update: async (_c, ts, m) => {
        if (fail.update === ts) return { ok: false, error: "ratelimited" };
        calls.push({ op: "update", ts, text: m.text, blocks: m.blocks });
        const target = messages.find((x) => x.ts === ts)!; target.text = m.text;
        return { ok: true };
      },
      post: async (_c, threadTs, text) => { calls.push({ op: "post", ts: threadTs, text }); messages.push({ ts: `9.${messages.length}`, user: "UBOT", text }); return { ok: true, ts: `9.${messages.length - 1}` }; },
    };
    return { ops, calls, messages };
  }

  it("rewrites the bot's old closing reply into the details, then the card into one bold line; a rerun writes nothing", async () => {
    const id = await closed(1, "cfo@finance", STUCK, { tags: ["prompt-title:Check GitHub Actions status"] });
    const [plan] = planTerminalResolvedCards(db);
    const slack = fakeSlack([
      { ts: "1.1", user: "UBOT", text: "*cfo@finance is waiting at a permission prompt*" },
      { ts: "1.2", user: "UHUMAN", text: "looking" },
      { ts: "1.3", user: "UBOT", text: "Closed: answered in the terminal." },
    ]);
    const r = await applyTerminalResolvedCard(plan!, slack.ops);
    expect(r).toMatchObject({ qitemId: id, ok: true, card: "rewritten", reply: "updated" });
    expect(slack.calls.map((c) => `${c.op}:${c.ts}`)).toEqual(["update:1.3", "update:1.1"]);
    expect(slack.calls[0]!.text).toContain("*What:* The prompt for `cfo@finance` was answered in the terminal.");
    expect(slack.calls[0]!.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: slack.calls[0]!.text } }]);
    expect(slack.calls[1]!.text).toBe("Resolved in Terminal · Check GitHub Actions status");
    expect(slack.messages.find((m) => m.ts === "1.2")!.text).toBe("looking");
    expect(r.note).toBe('slack-card-closed channel=C-MAIN message_ts=1.1 compact=true line="Resolved in Terminal · Check GitHub Actions status" backfill=true reply=updated reply_ts=1.3');
    const again = await applyTerminalResolvedCard(plan!, slack.ops);
    expect(again).toMatchObject({ ok: true, card: "kept", reply: "kept" });
    expect(slack.calls).toHaveLength(2);
  });

  it("of several closing lines of the bot's, the last becomes the details reply; an existing details reply is kept", async () => {
    await closed(1, "cfo@finance", STUCK);
    const [plan] = planTerminalResolvedCards(db);
    const twice = fakeSlack([{ ts: "1.1", user: "UBOT", text: "*card*" }, { ts: "1.2", user: "UBOT", text: "Closed: finished or answered earlier." }, { ts: "1.3", user: "UBOT", text: "Closed: answered in the terminal." }]);
    expect(await applyTerminalResolvedCard(plan!, twice.ops)).toMatchObject({ ok: true, reply: "updated" });
    expect(twice.calls.map((c) => `${c.op}:${c.ts}`)).toEqual(["update:1.3", "update:1.1"]);
    const done = fakeSlack([{ ts: "1.1", user: "UBOT", text: "*card*" }, { ts: "1.2", user: "UBOT", text: "*What:* earlier" }, { ts: "1.3", user: "UBOT", text: "Closed: answered in the terminal." }]);
    expect(await applyTerminalResolvedCard(plan!, done.ops)).toMatchObject({ ok: true, reply: "kept", card: "rewritten" });
    expect(done.calls.map((c) => `${c.op}:${c.ts}`)).toEqual(["update:1.1"]);
  });

  it("posts the details reply when the thread has no closing reply of the bot's", async () => {
    await closed(1, "cfo@finance", STUCK);
    const [plan] = planTerminalResolvedCards(db);
    const slack = fakeSlack([{ ts: "1.1", user: "UBOT", text: "*card*" }, { ts: "1.2", user: "UHUMAN", text: "Closed: by me" }]);
    expect(await applyTerminalResolvedCard(plan!, slack.ops)).toMatchObject({ ok: true, card: "rewritten", reply: "posted" });
    expect(slack.calls.map((c) => `${c.op}:${c.ts}`)).toEqual(["post:1.1", "update:1.1"]);
    expect(slack.calls[1]!.text).toBe("Resolved in Terminal · cfo@finance's prompt");
  });

  it("keeps a card and reply already in the compact shape (the hand-edited sample), and never touches another user's card", async () => {
    await closed(1, "cfo@finance", STUCK);
    const [plan] = planTerminalResolvedCards(db);
    const sample = fakeSlack([{ ts: "1.1", user: "UBOT", text: "Resolved in Terminal · GitHub Actions status check" }, { ts: "1.3", user: "UBOT", text: "*What:* hand-written" }]);
    expect(await applyTerminalResolvedCard(plan!, sample.ops)).toMatchObject({ ok: true, card: "kept", reply: "kept" });
    expect(sample.calls).toEqual([]);
    const foreign = fakeSlack([{ ts: "1.1", user: "UHUMAN", text: "mine" }]);
    expect(await applyTerminalResolvedCard(plan!, foreign.ops)).toMatchObject({ ok: false, card: "untouched", reply: "untouched" });
    expect(foreign.calls).toEqual([]);
  });

  it("a failed details reply stops before the card, so the card keeps its details", async () => {
    await closed(1, "cfo@finance", STUCK);
    const [plan] = planTerminalResolvedCards(db);
    const slack = fakeSlack([{ ts: "1.1", user: "UBOT", text: "*card*" }, { ts: "1.3", user: "UBOT", text: "Closed: answered in the terminal." }], { update: "1.3" });
    const r = await applyTerminalResolvedCard(plan!, slack.ops);
    expect(r).toMatchObject({ ok: false, card: "untouched", reply: "untouched", error: "details reply: ratelimited" });
    expect(r.note).toBeUndefined();
    expect(slack.calls).toEqual([]);
  });
});
