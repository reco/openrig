import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { runHumanFeedbackReport } from "../src/domain/policies/human-feedback-report.js";

const human = { entityId: "reco", class: "human" as const, displayName: "Reco", address: "reco@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } };
const registry = { ok: true as const, entities: [human] };
const monday10 = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7)); d.setHours(10, 0, 0, 0); return d; };

describe("weekly 👍/👎 report", () => {
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
  });
  afterEach(() => db.close());

  const message = async (seat: string, summary: string, reactions: string[]) => {
    const row = await repo.create({ sourceSession: seat, destinationSession: "reco@external", humanIntent: "update", summary, body: summary, nudge: false });
    reactions.forEach((reaction, i) => repo.update({ qitemId: row.qitemId, actorSession: "reco@external", transitionNote: `human-feedback reaction=${reaction} message_ts=${row.qitemId.slice(-6)}.1 channel=C1 key=k${i}` }));
    return row.qitemId;
  };
  const run = (now: Date) => runHumanFeedbackReport({ queueRepo: repo, registry: { loadHumanRegistry: () => registry }, home: "/unused", now: () => now,
    permalink: async (channel, ts) => `https://example.slack.com/archives/${channel}/p${ts.replace(".", "")}` });

  it("posts one update per week: per-seat counts and the lowest rated messages with links", async () => {
    await message("dev@rig", "Good plan", ["+1", "+1"]);
    await message("dev@rig", "Bad plan", ["-1"]);
    await message("ops@rig", "Worse plan", ["-1", "-1"]);
    const started = await repo.create({ sourceSession: "reco@external", destinationSession: "ops@rig", summary: "Human-started", body: "hi", nudge: false });
    repo.update({ qitemId: started.qitemId, actorSession: "reco@external", transitionNote: "human-feedback reaction=+1 message_ts=9.1 channel=C1 key=kh" });
    const r = await run(monday10());
    expect(r.posted).toMatch(/^qitem-feedback-report-/);
    const report = repo.getById(r.posted!)!;
    expect(report).toMatchObject({ destinationSession: "reco@external", humanIntent: "update", summary: "Weekly feedback, last 7 days: 👍 3 · 👎 3" });
    expect(report.body).toContain("1. *`dev@rig`:* 👍 2 · 👎 1");
    expect(report.body).toContain("2. *`ops@rig`:* 👍 1 · 👎 2");
    expect(report.body).toMatch(/3\. \*Lowest rated:\* Worse plan \(score -2\) https:\/\/example\.slack\.com\/archives\/C1\/p/);
    expect(report.body).toContain("4. *Lowest rated:* Bad plan (score -1)");
    expect(report.body).not.toMatch(/^\*[^`]/m);
    expect(report.body).not.toContain("Good plan");
    expect((await run(monday10())).posted).toBeNull();
  });

  it("waits for Monday 09:00 and stays quiet without feedback", async () => {
    const early = monday10(); early.setHours(8);
    await message("dev@rig", "Bad plan", ["-1"]);
    expect((await run(early)).posted).toBeNull();
    const tuesday = monday10(); tuesday.setDate(tuesday.getDate() + 1);
    expect((await run(tuesday)).posted).toBeNull();
    db.prepare("DELETE FROM queue_transitions WHERE transition_note LIKE 'human-feedback %'").run();
    expect(await run(monday10())).toMatchObject({ posted: null, reason: "no feedback this week" });
  });
});
