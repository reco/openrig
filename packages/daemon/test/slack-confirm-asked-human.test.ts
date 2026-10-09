// The Confirm button in explicit-answers mode: only on a post that waits on a human, and a click
// by that human replaces it with the confirmed state, also for a park on the human's own address.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { buildSlackGatewayWire, makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import type { WsLike } from "../src/domain/gateway/slack/socket-inbound.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { ThreadSeatMap } from "../src/domain/gateway/slack/thread-seat-map.js";

const founder = { entityId: "reco", class: "human" as const, displayName: "reco", address: "reco@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } };
const registry = { ok: true as const, entities: [founder] };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("Confirm in explicit-answers mode", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let posts: Array<Record<string, unknown>>;
  let updates: Array<Record<string, unknown>>;
  let socket: WsLike;
  let wire: ReturnType<typeof buildSlackGatewayWire>;
  const stops: Array<() => void> = [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "confirm-asked-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\nSLACK_APP_TOKEN=xapp-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-MAIN", inboundDestination: "lead@rig", secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE", explicitAnswersOnly: true }, home);
    posts = []; updates = [];
    const sockets: WsLike[] = [];
    const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    wire = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      resolveHumanReply: makeHumanReplyResolver(repo, contract),
      wsFactory: () => { const ws: WsLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }; sockets.push(ws); return ws; },
      inboundMaxConnects: 1,
      fetchImpl: async (url, init) => {
        if (url.endsWith("apps.connections.open")) return reply({ ok: true, url: "wss://fake-slack/ws" });
        if (url.endsWith("auth.test")) return reply({ ok: true, user_id: "UBOT" });
        if (url.includes("conversations.members")) return reply({ ok: true, members: ["UFOUNDER", "UBOT"] });
        if (url.endsWith("chat.update")) { updates.push(JSON.parse(String(init?.body))); return reply({ ok: true }); }
        if (url.endsWith("chat.postMessage")) { posts.push(JSON.parse(String(init?.body))); return reply({ ok: true, ts: `${posts.length}.1` }); }
        return reply({ ok: true, messages: [] });
      },
    });
    stops.push(() => wire.stop()); wire.startServices?.();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    socket = sockets[0]!;
    socket.onopen?.();
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  const postWith = (text: string) => posts.find((p) => String(p.text).includes(text));
  const click = async (blockId: string, messageTs: string) => {
    socket.onmessage?.({ data: JSON.stringify({ envelope_id: `e-click-${messageTs}`, type: "interactive", payload: {
      type: "block_actions", user: { id: "UFOUNDER" }, channel: { id: "C-MAIN" },
      container: { type: "message", message_ts: messageTs, channel_id: "C-MAIN" }, message: { ts: messageTs },
      actions: [{ type: "button", block_id: blockId, action_id: "or-confirm", action_ts: `${Date.now()}` }],
    } }) });
    await new Promise((r) => setTimeout(r, 80));
  };

  it("a park on the human's own address: Confirm unparks it and the button becomes the confirmed state", async () => {
    const work = await repo.create({ sourceSession: "lead@rig", destinationSession: "lead@rig", summary: "Slack enabled; verify", body: "Verify inbound/outbound.", evidenceRef: "/proof/report.md", nudge: false });
    repo.update({ qitemId: work.qitemId, actorSession: "lead@rig", state: "blocked", blockedOn: "reco@external", transitionNote: "continuation: on reco's next message" });
    await vi.waitFor(() => expect(postWith("Slack enabled; verify")).toBeDefined());
    const ts = `${posts.indexOf(postWith("Slack enabled; verify")!) + 1}.1`;
    expect(JSON.stringify(postWith("Slack enabled; verify")!.blocks)).toContain("or-confirm");
    await click(`or-confirm:${work.qitemId}`, ts);
    await vi.waitFor(() => expect(repo.getById(work.qitemId)?.state).toBe("in-progress"));
    await vi.waitFor(() => expect(updates.some((u) => u.ts === ts)).toBe(true));
    const replaced = updates.find((u) => u.ts === ts)!;
    expect(JSON.stringify(replaced.blocks)).not.toContain("or-confirm");
    expect(String(replaced.text)).toContain("Decided");

    repo.update({ qitemId: work.qitemId, actorSession: "lead@rig", state: "blocked", blockedOn: "reco@external", transitionNote: "parked again" });
    await vi.waitFor(() => expect(posts.filter((p) => String(p.text).includes("Slack enabled; verify")).length).toBeGreaterThan(1));
    const again = posts.findLast((p) => String(p.text).includes("Slack enabled; verify"))!;
    const againTs = `${posts.lastIndexOf(again) + 1}.1`;
    await click(`or-confirm:${work.qitemId}`, againTs);
    await vi.waitFor(() => expect(repo.getById(work.qitemId)?.state).toBe("in-progress"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM mission_control_actions WHERE qitem_id = ? AND action_verb = 'resolve'").get(work.qitemId)).toEqual({ n: 2 });
  });

  it("a notice that waits on no human carries no Confirm button", async () => {
    const escalation = await repo.create({ sourceSession: "lead@rig", destinationSession: "lead@rig", summary: "Wake escalation: batons stuck", body: "Escalated to the operator.", nudge: false });
    wire.dispatcher.dispatch("post_message", "reco@external", { qitemId: escalation.qitemId, sourceSession: "lead@rig", destinationSession: "lead@rig",
      summary: "Wake escalation: batons stuck", body: "Escalated to the operator.", ownerNotificationKind: "human-required", ownerNotificationLevel: "ALERT" });
    await vi.waitFor(() => expect(postWith("Escalated to the operator.")).toBeDefined());
    expect(JSON.stringify(postWith("Escalated to the operator.")!.blocks)).not.toContain("or-confirm");
  });

  it("a row the human addressed to themselves is never posted", async () => {
    await repo.create({ sourceSession: "reco@external", destinationSession: "reco@external", summary: "Stuck sweep: undelivered-wake", body: "self-addressed finding", nudge: false });
    await repo.create({ sourceSession: "lead@rig", destinationSession: "reco@external", summary: "Real ask", body: "a real ask", nudge: false });
    await vi.waitFor(() => expect(postWith("a real ask")).toBeDefined());
    await new Promise((r) => setTimeout(r, 200));
    expect(postWith("self-addressed finding")).toBeUndefined();
  });

  it("a Confirm in a thread whose seat is the clicking human creates no row back to them", async () => {
    const offer = await repo.create({ sourceSession: "lead@rig", destinationSession: "reco@external", summary: "Loop?", body: "offer in a self-seated thread", nudge: false });
    await vi.waitFor(() => expect(postWith("offer in a self-seated thread")).toBeDefined());
    new ThreadSeatMap(db).open({ threadTs: "77.1", channel: "C-MAIN", human: "reco@external", seat: "reco@external", conversationId: offer.qitemId });
    await click(`or-confirm:${offer.qitemId}`, "77.1");
    expect(repo.list({ limit: 100 }).filter((q) => q.sourceSession === "reco@external" && q.destinationSession === "reco@external")).toEqual([]);
  });

  it("a reply in a thread whose seat is its own human reaches the channel's inbound seat, not the human", async () => {
    const offer = await repo.create({ sourceSession: "lead@rig", destinationSession: "reco@external", summary: "x", body: "self-seated thread fixture", nudge: false });
    new ThreadSeatMap(db).open({ threadTs: "88.1", channel: "C-MAIN", human: "reco@external", seat: "reco@external", conversationId: offer.qitemId });
    socket.onmessage?.({ data: JSON.stringify({ envelope_id: "e-self-reply", type: "events_api", payload: { event: { type: "message", user: "UFOUNDER", text: "is this thing on", ts: "88.2", thread_ts: "88.1", channel: "C-MAIN" } } }) });
    await vi.waitFor(() => expect(repo.list({ limit: 100 }).find((q) => q.body.includes("is this thing on"))?.destinationSession).toBe("lead@rig"));
  });

  it("a reply to the daemon's own alert thread reaches the channel's inbound seat; an agent's thread still routes to the agent", async () => {
    const alert = await repo.create({ sourceSession: "daemon@kernel", destinationSession: "reco@external", humanIntent: "update", summary: "dev@rig is waiting at a prompt", body: "daemon alert fixture", nudge: false });
    new ThreadSeatMap(db).open({ threadTs: "91.1", channel: "C-MAIN", human: "reco@external", seat: "daemon@kernel", conversationId: alert.qitemId });
    const usage = await repo.create({ sourceSession: "codex-usage@host", destinationSession: "reco@external", humanIntent: "update", summary: "usage", body: "usage fixture", nudge: false });
    new ThreadSeatMap(db).open({ threadTs: "93.1", channel: "C-MAIN", human: "reco@external", seat: "codex-usage@host", conversationId: usage.qitemId });
    socket.onmessage?.({ data: JSON.stringify({ envelope_id: "e-93.1", type: "events_api", payload: { event: { type: "message", user: "UFOUNDER", text: "thanks usage", ts: "93.15", thread_ts: "93.1", channel: "C-MAIN" } } }) });
    await vi.waitFor(() => expect(repo.list({ limit: 100 }).find((q) => q.body.includes("thanks usage"))?.destinationSession).toBe("lead@rig"));
    const work = await repo.create({ sourceSession: "worker@rig", destinationSession: "reco@external", summary: "agent ask", body: "agent thread fixture", nudge: false });
    new ThreadSeatMap(db).open({ threadTs: "92.1", channel: "C-MAIN", human: "reco@external", seat: "worker@rig", conversationId: work.qitemId });
    for (const [ts, text] of [["91.1", "Yes"], ["92.1", "go ahead"]]) {
      socket.onmessage?.({ data: JSON.stringify({ envelope_id: `e-${ts}`, type: "events_api", payload: { event: { type: "message", user: "UFOUNDER", text, ts: `${ts}5`, thread_ts: ts, channel: "C-MAIN" } } }) });
    }
    await vi.waitFor(() => expect(repo.list({ limit: 100 }).find((q) => q.body.includes("Yes") && q.sourceSession === "reco@external")?.destinationSession).toBe("lead@rig"));
    await vi.waitFor(() => expect(repo.list({ limit: 100 }).find((q) => q.body.includes("go ahead"))?.destinationSession).toBe("worker@rig"));
    expect(repo.list({ limit: 100 }).some((q) => q.destinationSession === "daemon@kernel")).toBe(false);
  });
});

