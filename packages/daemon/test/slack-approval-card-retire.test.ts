// An expired or canceled request's card loses its buttons: the original Slack message is rewritten
// with the outcome (answers kept), through the same chat.update path a click uses. A failed rewrite is
// recorded on the row and retried by the request sweep.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeApprovalService } from "../src/domain/approvals.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { ThreadSeatMap } from "../src/domain/gateway/slack/thread-seat-map.js";
import { buildOutboundMessage } from "../src/domain/gateway/slack/message.js";

const founder = { entityId: "reco", class: "human" as const, displayName: "reco", address: "reco@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } };
const registry = { ok: true as const, entities: [founder] };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("an expired or canceled approval card loses its buttons", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let posts: Array<Record<string, unknown>>;
  let updates: Array<Record<string, unknown>>;
  let failUpdates: number;
  let failWith: string;
  const stops: Array<() => void> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "card-retire-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env"); writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-MAIN", secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE" }, home);
    posts = []; updates = []; failUpdates = 0; failWith = "ratelimited";
    const wire = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, requestSweepIntervalMs: 50,
      fetchImpl: async (url, init) => {
        if (url.endsWith("chat.update")) {
          if (failUpdates > 0) { failUpdates--; return reply({ ok: false, error: failWith }); }
          updates.push(JSON.parse(String(init?.body))); return reply({ ok: true });
        }
        if (url.endsWith("chat.postMessage")) { posts.push(JSON.parse(String(init?.body))); return reply({ ok: true, ts: `${posts.length}.1` }); }
        return reply({ ok: true });
      },
    });
    stops.push(() => wire.stop()); wire.startServices?.();
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  async function postedApproval(t: { now: number }) {
    const service = makeApprovalService({ queueRepo: repo, optedIn: () => ["dev@rig"], approver: () => "reco@external", verifySeat: () => true, timeoutMs: () => 1_800_000, now: () => t.now, pollMs: 5 });
    const id = (await service.start({ sessionName: "dev@rig", toolName: "Bash", toolInput: { command: "rm -rf build" } }))!;
    await vi.waitFor(() => expect(posts.some((p) => String(p.text).includes("rm -rf build"))).toBe(true));
    const card = posts.find((p) => String(p.text).includes("rm -rf build"))!;
    expect(JSON.stringify(card.blocks)).toContain('"type":"actions"');
    return { service, id, ts: `${posts.indexOf(card) + 1}.1` };
  }
  const actionable = (message: Record<string, unknown>) => JSON.stringify(message.blocks).includes('"type":"actions"');

  it("the abandoned-hook expiry rewrites the card: no buttons, the outcome shown, the thread told", async () => {
    const t = { now: Date.now() };
    const { service, id, ts } = await postedApproval(t);
    t.now += 130_000; await service.sweep();
    await vi.waitFor(() => expect(updates.some((u) => u.ts === ts)).toBe(true));
    const card = updates.find((u) => u.ts === ts)!;
    expect(actionable(card)).toBe(false);
    expect(String(card.text)).toContain("Closed: expired, the seat stopped waiting for it.");
    expect(String(card.text)).toContain("rm -rf build");
    await vi.waitFor(() => expect(posts.some((p) => p.thread_ts === ts && String(p.text).includes("Closed: expired") && String(p.text).includes("tmux attach -t dev@rig"))).toBe(true));
    // The explanation lives in the card's own thread: nothing about it is posted as a new top-level message.
    await new Promise((r) => setTimeout(r, 150));
    expect(posts.filter((p) => p.thread_ts === undefined && /Expired|Not used|no longer does anything/.test(String(p.text)))).toEqual([]);
    expect(repo.transitionLog.listForQitem(id).some((x) => x.transitionNote?.startsWith(`slack-card-closed channel=C-MAIN message_ts=${ts}`))).toBe(true);
  });

  it("the deadline expiry rewrites the card too, and a failed rewrite is retried until it lands", async () => {
    const t = { now: Date.now() };
    const { service, id, ts } = await postedApproval(t);
    failUpdates = 1;
    t.now += 1_800_001;
    expect(await service.wait(id, "dev@rig", 1)).toBe("expired");
    await vi.waitFor(() => expect(repo.transitionLog.listForQitem(id).some((x) => x.transitionNote?.startsWith("slack-card-close-failed"))).toBe(true));
    await vi.waitFor(() => expect(updates.some((u) => u.ts === ts && !actionable(u) && String(u.text).includes("Closed: expired, no answer in time."))).toBe(true));
    expect(repo.transitionLog.listForQitem(id).at(-1)?.transitionNote).toMatch(/^slack-card-closed /);
  });

  it("an answered approval is never shown as expired", async () => {
    const t = { now: Date.now() };
    const { service, id, ts } = await postedApproval(t);
    repo.recordHumanAnswer({ qitemId: id, actorSession: "reco@external", questionId: "approval", optionId: "allow" });
    t.now += 1_900_000; await service.sweep();
    await new Promise((r) => setTimeout(r, 150));
    expect(repo.getById(id)?.state).toBe("pending");
    expect(updates.filter((u) => u.ts === ts && String(u.text).includes("expired"))).toEqual([]);
  });

  it("a permanent Slack error is recorded once and not retried", async () => {
    const t = { now: Date.now() };
    const { service, id } = await postedApproval(t);
    failUpdates = 99; failWith = "message_not_found";
    t.now += 130_000; await service.sweep();
    await vi.waitFor(() => expect(repo.transitionLog.listForQitem(id).some((x) => x.transitionNote?.startsWith("slack-card-close-failed"))).toBe(true));
    await new Promise((r) => setTimeout(r, 300));
    const failed = repo.transitionLog.listForQitem(id).filter((x) => x.transitionNote?.startsWith("slack-card-close-failed"));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.transitionNote).toContain("retry=false");
  });

  it("rewrites the card, never a later resolved notice posted for the same row", async () => {
    const t = { now: Date.now() };
    const { service, id, ts } = await postedApproval(t);
    repo.update({ qitemId: id, actorSession: "daemon@kernel", transitionNote: "slack-owner-notification-posted notification_key=x level=NOTICE kind=human-decision-resolved message_ts=99.1 thread_ts=" + ts });
    t.now += 130_000; await service.sweep();
    await vi.waitFor(() => expect(updates.some((u) => u.ts === ts)).toBe(true));
    expect(updates.some((u) => u.ts === "99.1")).toBe(false);
  });

  it("a thread the human started is not closed when its row is canceled", async () => {
    const row = await repo.create({ sourceSession: "reco@external", destinationSession: "dev@rig", body: "hi there", nudge: false });
    new ThreadSeatMap(db).open({ threadTs: "50.1", channel: "C-MAIN", human: "reco@external", seat: "dev@rig", conversationId: row.qitemId });
    repo.update({ qitemId: row.qitemId, actorSession: "dev@rig", state: "canceled", transitionNote: "not for me" });
    await new Promise((r) => setTimeout(r, 200));
    expect(posts.some((p) => p.thread_ts === "50.1")).toBe(false);
    expect(new ThreadSeatMap(db).resolveByThread("50.1")?.state).toBe("open");
  });
});

describe("a closed card's rendering", () => {
  const offer = { qitemId: "q1", summary: "Ship it?", body: "Merge #12", humanIntent: "decision", humanConfirm: "Ship", destinationSession: "reco@external" };
  it("keeps a Confirm that decided the request, with no button", () => {
    const m = buildOutboundMessage(offer, { sourceLabel: "x", closedNote: "Closed: the linked work is finished.", confirmOutcome: "confirmed" });
    expect(String(m.text)).toContain("Decided: *Ship*");
    expect(JSON.stringify(m.blocks)).not.toContain('"type":"actions"');
  });
  it("drops a Confirm nobody used", () => {
    const m = buildOutboundMessage(offer, { sourceLabel: "x", closedNote: "Closed: canceled." });
    expect(JSON.stringify(m.blocks)).not.toContain('"type":"actions"');
    expect(String(m.text)).toContain("Closed: canceled.");
  });
});

