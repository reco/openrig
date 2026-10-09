// The one-off backfill selects only expired, unanswered approval cards that still show buttons, and
// rewrites them through the same render + chat.update a live close uses.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { planClosedApprovalCards, retireClosedApprovalCards } from "../src/domain/gateway/slack/closed-card-backfill.js";

const approval = { sourceSession: "dev2-owner@Imago", destinationSession: "reco@external", humanIntent: "decision" as const, summary: "Approve Bash for dev2-owner@Imago?",
  body: "```\nrm -rf /tmp/x\n```", tags: ["approval-request"], nudge: false,
  humanQuestions: [{ id: "approval", question: "Allow dev2-owner@Imago to run this Bash?", options: [{ id: "allow", label: "Approve" }, { id: "deny", label: "Deny" }] }] };

describe("closed approval card backfill", () => {
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); repo = new QueueRepository(db, new EventBus(db)); });
  afterEach(() => db.close());

  async function closed(n: number, extra: (id: string) => void = () => {}) {
    const row = await repo.create(approval);
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: `slack-posted thread_ts=${n}.1 message_ts=${n}.1 channel=C0AVBD2PAMC human=reco@external seat=dev2-owner@Imago conversation=${row.qitemId}` });
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: `slack-owner-notification-posted notification_key=k level=ALERT kind=human-required message_ts=${n}.1 thread_ts=${n}.1` });
    extra(row.qitemId);
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", state: "canceled", transitionNote: "approval expired: the prompt is in the terminal" });
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: "request-closed reason=canceled-by-seat" });
    return row.qitemId;
  }

  it("plans only expired, unanswered cards not yet rewritten, and the rewrite has no buttons", async () => {
    const expired = await closed(1);
    const answered = await closed(2, (id) => repo.recordHumanAnswer({ qitemId: id, actorSession: "reco@external", questionId: "approval", optionId: "allow" }));
    const rewritten = await closed(3);
    repo.update({ qitemId: rewritten, actorSession: "daemon@kernel", transitionNote: 'slack-card-closed channel=C0AVBD2PAMC message_ts=3.1 line="x"' });
    const plan = planClosedApprovalCards(db, "openrig");
    expect(plan.map((c) => c.qitemId)).toEqual([expired]);
    expect(plan[0]).toMatchObject({ channel: "C0AVBD2PAMC", messageTs: "1.1", line: "Closed: expired, the prompt is in the terminal." });
    expect(JSON.stringify(plan[0]!.message.blocks)).not.toContain('"type":"actions"');
    expect(plan[0]!.message.text).toContain("rm -rf /tmp/x");
    expect(planClosedApprovalCards(db, "openrig", [answered])).toEqual([]);
    const stillOpen = (await repo.create(approval)).qitemId;
    repo.update({ qitemId: stillOpen, actorSession: "daemon@kernel", transitionNote: "slack-owner-notification-posted notification_key=k level=ALERT kind=human-required message_ts=4.1 thread_ts=4.1" });
    repo.update({ qitemId: stillOpen, actorSession: "daemon@kernel", state: "canceled", transitionNote: "approval expired: the seat stopped waiting for it" });
    expect(planClosedApprovalCards(db, "openrig", [stillOpen])).toEqual([]);
  });

  it("applies through chat.update on the planned message and returns the note to record", async () => {
    const expired = await closed(1);
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const results = await retireClosedApprovalCards(planClosedApprovalCards(db, "openrig", [expired]), "xoxb-EXAMPLE-fake",
      async (url, init) => { calls.push({ url, body: JSON.parse(String(init?.body)) }); return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }); });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/chat\.update$/);
    expect(calls[0]!.body).toMatchObject({ channel: "C0AVBD2PAMC", ts: "1.1" });
    expect(results[0]).toMatchObject({ qitemId: expired, ok: true });
    expect(results[0]!.note).toMatch(/^slack-card-closed channel=C0AVBD2PAMC message_ts=1\.1 .* backfill=true$/);
  });
});
