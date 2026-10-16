// device-io audit 2026-10-16 (26 lead alerts): a seat waiting at a prompt whose card already
// reached its human, a seat running an auto-approved tool, and a seat whose background CI watch
// will resume it each raised lead stall or wake alerts. These cases pin the repaired rules, and
// the cases that must stay visible: an unknown owner, a new occupant, an undelivered card.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { derivePickup, PERMISSION_REQUEST_TELEMETRY } from "../src/domain/queue-pickup.js";
import { createStuckSweepStatus, runStuckSweep, STUCK_SWEEP_FINDING_TAG } from "../src/domain/queue-stuck-sweep.js";
import { makeParkedOwnerConsumerPolicy, makeRigAnchor, PARKED_OWNER_POLICY_NAME } from "../src/domain/policies/parked-owner-consumer.js";
import { runWakeLadderTick, queueRecoveryOwnsWake } from "../src/domain/queue-wake-ladder.js";
import { readClaudeSelfReportEvidence } from "../src/adapters/claude-code-adapter.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { CLAUDE_ACTIVITY_RUNG_INVENTORY } from "../src/domain/activity-taxonomy.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";
import type { PolicyJob } from "../src/domain/policies/types.js";
import type { WatchdogHistoryEntry } from "../src/domain/watchdog-history-log.js";

const SEAT = "dev2-owner@device-io";
const LEAD = "product-lead@device-io";
const HUMAN = { entityId: "human-owner", class: "human", displayName: "Owner", address: "human-owner@external",
  connectorBindings: [{ connector: "slack", ref: "U0OWNER", primary: true }], prefs: {} } as unknown as HumanFragment;

type Owner = { activity: "working" | "idle-at-prompt" | "unknown"; needsInput?: { count: number; reason: string | null }; backgroundShell?: boolean; generation?: string };

describe("pickup derivation: liveness versus a person's prompt", () => {
  const claimed = new Date(Date.now() - 30 * 60_000).toISOString();
  const base = { state: "in-progress", claimedAt: claimed, lastHeartbeat: null, postClaimMotionCount: 0, lastMeaningfulAt: claimed, thresholdMinutes: 3 };

  it("a running tool with only PermissionRequest telemetry is working, not stalled", () => {
    expect(derivePickup({ ...base, activity: "working", needsInput: 1, needsInputReason: PERMISSION_REQUEST_TELEMETRY }).state).toBe("working");
  });

  it("a dialog actually shown, with no delivered card, still ages into a stall", () => {
    expect(derivePickup({ ...base, activity: "working", needsInput: 1, needsInputReason: "permission_prompt" }).state).toBe("stalled-after-claim");
  });

  it("a delivered prompt card parks the row with the human", () => {
    expect(derivePickup({ ...base, activity: "working", needsInput: 1, needsInputReason: "permission_prompt", promptCardDelivered: true }))
      .toEqual({ state: "parked", evidence: "owner waits at a native prompt whose card was delivered to its human" });
  });

  it("an unknown owner stays a stall even with a delivered card", () => {
    expect(derivePickup({ ...base, activity: "unknown", promptCardDelivered: true }).state).toBe("stalled-after-claim");
  });

  it("idle at the prompt with a background shell (a CI watch) is working; without one it is a stall", () => {
    expect(derivePickup({ ...base, activity: "idle-at-prompt", backgroundShell: true }).state).toBe("working");
    expect(derivePickup({ ...base, activity: "idle-at-prompt" }).state).toBe("stalled-after-claim");
  });

  it("a background shell that never resumes the seat (a dev server) still ages into a stall after the grace", () => {
    const old = new Date(Date.now() - 61 * 60_000).toISOString();
    expect(derivePickup({ ...base, claimedAt: old, lastMeaningfulAt: old, activity: "idle-at-prompt", backgroundShell: true }).state).toBe("stalled-after-claim");
  });
});

describe("Claude self-report: status shell is a background shell, carried to the arbitrated state", () => {
  const read = (status: string) => ({ listFiles: () => ["1.json"], readFile: () => JSON.stringify({ name: SEAT, status, statusUpdatedAt: Date.now() }) });

  it("maps shell to idle-at-prompt with backgroundShell, idle without it", () => {
    expect(readClaudeSelfReportEvidence({ sessionsDir: "/x", sessionName: SEAT, seatNodeId: "n1", read: read("shell") }))
      .toMatchObject({ activity: "idle-at-prompt", backgroundShell: true });
    expect(readClaudeSelfReportEvidence({ sessionsDir: "/x", sessionName: SEAT, seatNodeId: "n1", read: read("idle") })?.backgroundShell).toBeUndefined();
  });

  it("the arbitrated state reports backgroundShell only while the self-report says shell", () => {
    const service = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3, now: () => new Date() });
    service.declareRungInventory({ seatNodeId: "n1", sessionName: SEAT }, CLAUDE_ACTIVITY_RUNG_INVENTORY);
    service.reportEvidence(readClaudeSelfReportEvidence({ sessionsDir: "/x", sessionName: SEAT, seatNodeId: "n1", read: read("shell") })!);
    expect(service.getSeatState("n1")).toMatchObject({ activity: "idle-at-prompt", backgroundShell: true });
    service.reportEvidence({ ...readClaudeSelfReportEvidence({ sessionsDir: "/x", sessionName: SEAT, seatNodeId: "n1", read: read("idle") })!, seq: Date.now() + 1 });
    expect(service.getSeatState("n1")?.backgroundShell).toBe(false);
  });
});

describe("stuck sweep and wake ladder against the prompt card's custody", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let owner: Owner;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      loadHumanRegistry: () => ({ ok: true as const, entities: [HUMAN] }),
      transport: { send: async () => ({ ok: true, verified: true }) },
    });
    owner = { activity: "idle-at-prompt" };
    repo.attachActivityReader(() => ({ activity: owner.activity, needsInput: owner.needsInput ?? { count: 0, reason: null }, decidedBy: "self-report",
      backgroundShell: owner.backgroundShell, lastSwap: owner.generation ? { generation: owner.generation, at: new Date().toISOString() } : null }));
  });
  afterEach(() => { db.close(); });

  async function claimedRow(): Promise<QueueItem> {
    const row = await repo.create({ sourceSession: LEAD, destinationSession: SEAT, body: "fix the SSO gap", nudge: false });
    repo.claim({ qitemId: row.qitemId, destinationSession: SEAT });
    quiet(row.qitemId);
    return repo.getById(row.qitemId)!;
  }
  /** Move the row's own history back 30 minutes: claimed, then no meaningful change. */
  function quiet(qitemId: string): void {
    const past = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ?, claimed_at = ? WHERE qitem_id = ?").run(past(31), past(30), qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(past(30), qitemId);
  }
  async function promptCard(posted: boolean): Promise<string> {
    const card = await repo.create({ sourceSession: SEAT, destinationSession: "human-owner@external", body: "Bash command\nDo you want to proceed?",
      summary: `${SEAT} is waiting at a permission prompt`, humanIntent: "decision", evidenceRef: "rig capture",
      tags: ["stuck-prompt", `stuck-prompt-session:${SEAT}`, "stuck-prompt-key:k1"] } as never);
    if (posted) {
      const key = `${card.qitemId}:${repo.transitionLog.latestOwnerNotificationForQitem(card.qitemId)!.transitionId}`;
      repo.update({ qitemId: card.qitemId, actorSession: "daemon@kernel", transitionNote: `slack-owner-notification-posted notification_key=${key} level=ALERT message_ts=1.2` });
    }
    return card.qitemId;
  }
  const sweep = () => runStuckSweep({ db, queueRepo: repo, status: createStuckSweepStatus(), resolveOrchestrator: () => LEAD,
    unclaimedAgeMinutes: 60, log: () => {}, isRegisteredHost: () => false });
  const tagged = (tag: string) => (db.prepare("SELECT qitem_id, state, tags FROM queue_items ORDER BY ts_created").all() as Array<{ qitem_id: string; state: string; tags: string | null }>)
    .map((r) => ({ qitemId: r.qitem_id, state: r.state, tags: JSON.parse(r.tags ?? "[]") as string[] }))
    .filter((r) => r.tags.includes(tag));
  const findings = (qitemId: string) => tagged(STUCK_SWEEP_FINDING_TAG).filter((f) => f.tags.some((t) => t.endsWith(`:${qitemId}`)));
  const openFindings = (qitemId: string) => findings(qitemId).filter((f) => ["pending", "in-progress", "blocked"].includes(f.state));

  it("posted human prompt: no lead stall while the delivered card holds the wait, and an open one closes", async () => {
    const row = await claimedRow();
    owner = { activity: "working", needsInput: { count: 1, reason: "permission_prompt" } };
    await sweep();
    expect(openFindings(row.qitemId)).toHaveLength(1);
    await promptCard(true);
    await sweep();
    expect(openFindings(row.qitemId)).toEqual([]);
    expect(repo.getById(row.qitemId)?.pickup?.state).toBe("parked");
  });

  it("failed or unposted human card: the stall stays visible", async () => {
    const row = await claimedRow();
    owner = { activity: "working", needsInput: { count: 1, reason: "permission_prompt" } };
    await promptCard(false);
    await sweep();
    expect(openFindings(row.qitemId)).toHaveLength(1);
  });

  it("working tool with unrelated needsInput telemetry raises no stall", async () => {
    const row = await claimedRow();
    owner = { activity: "working", needsInput: { count: 1, reason: PERMISSION_REQUEST_TELEMETRY } };
    await sweep();
    expect(findings(row.qitemId)).toEqual([]);
  });

  it("background CI watch: idle at the prompt with a live background shell raises no stall", async () => {
    const row = await claimedRow();
    owner = { activity: "idle-at-prompt", backgroundShell: true };
    await sweep();
    expect(findings(row.qitemId)).toEqual([]);
  });

  /** The owner writes a note (the open finding closes), then goes quiet again for 10 minutes,
   *  newer than that closure: the evidence watermark alone would mint a new finding. */
  async function restall(qitemId: string, note: string): Promise<void> {
    repo.update({ qitemId, actorSession: SEAT, transitionNote: note });
    await sweep();
    expect(openFindings(qitemId)).toEqual([]);
    const past = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    for (const f of findings(qitemId)) db.prepare("UPDATE queue_items SET ts_updated = ? WHERE qitem_id = ?").run(past(20), f.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note = ?").run(past(10), qitemId, note);
  }

  it("repeated scans and a re-stall after an owner note in the same claim collapse into the first finding", async () => {
    const row = await claimedRow();
    await sweep();
    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    await restall(row.qitemId, "Still waiting on CI");
    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
  });

  it("a new occupant generation, or an owner gone unknown, is a new episode and reports again", async () => {
    const row = await claimedRow();
    await sweep();
    await restall(row.qitemId, "progress 1");
    owner = { activity: "idle-at-prompt", generation: "gen-2" };
    await sweep();
    expect(findings(row.qitemId)).toHaveLength(2);
    await restall(row.qitemId, "progress 2");
    owner = { activity: "unknown", generation: "gen-2" };
    await sweep();
    expect(findings(row.qitemId)).toHaveLength(3);
  });

  it("a wake refused at an interactive prompt is the prompt path's, not an undelivered-wake finding; other failures still report", async () => {
    const refused = await repo.create({ sourceSession: LEAD, destinationSession: SEAT, body: "review", nudge: false });
    repo.recordNudgeAttempt(refused.qitemId, `failed:Refused: '${SEAT}' is at an interactive prompt (permission_request). No text was sent.`);
    const lost = await repo.create({ sourceSession: LEAD, destinationSession: SEAT, body: "review", nudge: false });
    repo.recordNudgeAttempt(lost.qitemId, "failed:tmux session not found");
    await sweep();
    expect(findings(refused.qitemId)).toEqual([]);
    expect(findings(lost.qitemId).map((f) => f.tags?.find((t) => t.startsWith("stuck-sweep:")))).toEqual([`stuck-sweep:undelivered-wake:${lost.qitemId}`]);
  });

  it("the unclaimed net still backs a prompt-refused wake that nobody picked up", async () => {
    const refused = await repo.create({ sourceSession: LEAD, destinationSession: SEAT, body: "review", nudge: false });
    repo.recordNudgeAttempt(refused.qitemId, `failed:Refused: '${SEAT}' is at an interactive prompt (selection_prompt). No text was sent.`);
    const past = new Date(Date.now() - 61 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(past, refused.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(past, refused.qitemId);
    await sweep();
    expect(findings(refused.qitemId).map((f) => f.tags?.find((t) => t.startsWith("stuck-sweep:")))).toEqual([`stuck-sweep:unclaimed-obligation:${refused.qitemId}`]);
  });

  async function promptRefusal(): Promise<void> {
    const row = await repo.create({ sourceSession: LEAD, destinationSession: SEAT, body: "finish the work", summary: "assigned work", nudge: false });
    repo.claim({ qitemId: row.qitemId, destinationSession: SEAT });
    const history: WatchdogHistoryEntry[] = [];
    const policy = makeParkedOwnerConsumerPolicy({
      diagnoseRig: () => ({ seats: [{ sessionName: SEAT, parked: true,
        activity: { value: "idle-at-prompt", needsInput: { count: 1, reason: "permission prompt" } },
        obligations: { items: [{ qitemId: row.qitemId, state: "in-progress", summary: "assigned work" }], held: [] } }] }),
      history: { listForJob: () => history, countForJob: () => history.length },
      rows: {
        listTransitions: (id) => repo.listTransitions(id),
        appendNote: (id, note) => { repo.update({ qitemId: id, actorSession: "watchdog@system", transitionNote: note }); return { ok: true }; },
        recordNudgeResult: (id, result) => repo.recordNudgeAttempt(id, result),
        listOpenIds: () => [row.qitemId],
        recoveryOwnsWake: (id) => queueRecoveryOwnsWake(db, repo.getById(id)),
      },
    });
    const job = { jobId: "fixture-job", policy: PARKED_OWNER_POLICY_NAME, target: { session: makeRigAnchor("device-io") }, context: {} } as PolicyJob;
    const wake = await policy.evaluate(job);
    history.push({ historyId: "h1", jobId: job.jobId, evaluatedAt: new Date().toISOString(), outcome: "sent", skipReason: null,
      deliveryTargetSession: SEAT, deliveryStatus: "failed", deliveryMessage: "wake",
      evaluationNotes: { ...wake.notes, deliveryReason: `Refused: '${SEAT}' is at an interactive prompt (permission_request). No text was sent.` } });
    await policy.evaluate(job);
  }
  async function ladderTick(): Promise<string[]> {
    const woken: string[] = [];
    await runWakeLadderTick({ db, queueRepo: repo, resolveOrchestrator: () => LEAD, readPromptState: () => "blocked", retryIntervalSeconds: 1,
      now: new Date(Date.now() + 60_000), attemptWake: async (_id, target) => { woken.push(target); return "ok"; }, log: () => {} });
    return woken;
  }
  const escalations = () => tagged("wake-escalation");

  it("posted human prompt: the ladder does not escalate the same prompt to the lead", async () => {
    await promptRefusal();
    await promptCard(true);
    expect(await ladderTick()).toEqual([]);
    expect(escalations()).toEqual([]);
  });

  it("unposted human card: the ladder still escalates the prompt to the lead", async () => {
    await promptRefusal();
    await promptCard(false);
    expect(await ladderTick()).toEqual([LEAD]);
    expect(escalations()).toHaveLength(1);
  });
});
