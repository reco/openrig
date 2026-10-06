// Phase 1 reply semantics: a typed reply in a decision's thread is conversation. It reaches the
// owning seat and resolves nothing. Only an explicit `answer:` reply resolves, exactly once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { buildSlackGatewayWire, makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import type { WsLike } from "../src/domain/gateway/slack/socket-inbound.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { InboundReceiptStore } from "../src/domain/gateway/slack/state-store.js";

const human = "human-founder@external";
const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: human, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } }] };
const request = { sourceSession: "author@rig", destinationSession: human, summary: "Ship the migration?", body: "Tell me whether to ship it this week.", evidenceRef: "/private/proof.md", nudge: false };

describe("phase 1 reply semantics through the real Slack wire", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let socket: WsLike;
  let posts: Array<Record<string, unknown>>;
  let decisionId: string;
  let wire: ReturnType<typeof buildSlackGatewayWire>;
  const stops: Array<() => void> = [];
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  async function start(explicitAnswersOnly: boolean): Promise<void> {
    home = mkdtempSync(join(tmpdir(), "reply-semantics-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\nSLACK_APP_TOKEN=xapp-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE", explicitAnswersOnly }, home);
    posts = [];
    const sockets: WsLike[] = [];
    const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    wire = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      resolveHumanReply: makeHumanReplyResolver(repo, contract),
      wsFactory: () => { const ws: WsLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }; sockets.push(ws); return ws; },
      inboundMaxConnects: 1,
      inboundRetryIntervalMs: 50,
      fetchImpl: async (url, init) => {
        if (url.endsWith("apps.connections.open")) return reply({ ok: true, url: "wss://fake-slack/ws" });
        posts.push(JSON.parse(String(init?.body))); return reply({ ok: true, ts: `${posts.length}.1` });
      },
    });
    stops.push(() => wire.stop()); wire.startServices?.();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    socket = sockets[0]!;
    socket.onopen?.();
    const alert = async () => (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({}))[0];
    decisionId = (await repo.create({ ...request, humanIntent: "decision" })).qitemId;
    wire.dispatcher.dispatch("post_message", human, await alert());
    await vi.waitFor(async () => expect(await alert()).toBeUndefined());
  }
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  const finals = (envelopeId: string) => new InboundReceiptStore(join(home, "state", "slack-inbound-receipts.jsonl")).readAll()
    .filter((r) => r.envelopeId === envelopeId && r.status !== "received");
  async function say(text: string, ts: string, envelopeId = `e-${ts}`): Promise<void> {
    const before = finals(envelopeId).length;
    socket.onmessage?.({ data: JSON.stringify({ envelope_id: envelopeId, type: "events_api", payload: { event: { type: "message", user: "UFOUNDER", text, ts, thread_ts: "1.1", channel: "C-TEST" } } }) });
    await vi.waitFor(() => expect(finals(envelopeId).length).toBe(before + 1));
  }
  async function deliver(qitemId: string): Promise<void> {
    const alert = (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === qitemId);
    expect(alert).toBeDefined();
    wire.dispatcher.dispatch("post_message", human, alert);
    await vi.waitFor(() => expect(repo.getById(qitemId)?.deliveryOutcome).toBe("posted"));
  }
  const toSeat = () => repo.list({ limit: 100 }).filter((q) => q.destinationSession === "author@rig");
  const resolutions = () => repo.transitionLog.listForQitem(decisionId).filter((t) => t.ownerNotificationKind === "human-decision-resolved");

  describe("explicitAnswersOnly (the default)", () => {
    beforeEach(() => start(true));

    it("is on by default", () => {
      expect(DEFAULT_CONFIG.explicitAnswersOnly).toBe(true);
    });

    it("tells the human how to decide in the decision post", () => {
      expect(String(posts[0]?.text)).toContain("answer:");
      expect(JSON.stringify(posts[0]?.blocks)).toContain("answer:");
    });

    it("a clarifying question reaches the owning seat and leaves the decision open", async () => {
      await say("Which migration, the schema one or the data one?", "2000.1");
      expect(repo.getById(decisionId)?.state).toBe("pending");
      expect(resolutions()).toEqual([]);
      expect(toSeat()).toHaveLength(1);
      expect(toSeat()[0]?.body).toContain("Which migration, the schema one or the data one?");
      expect(toSeat()[0]?.tags).toEqual(expect.arrayContaining([`reply-to:${decisionId}`, "conversation"]));
    });

    it("prose that sounds like approval still resolves nothing", async () => {
      await say("yes", "2001.1");
      await say("approved, ship it", "2002.1");
      expect(repo.getById(decisionId)?.state).toBe("pending");
      expect(resolutions()).toEqual([]);
    });

    it("an `answer:` reply resolves the decision with the text after the prefix, exactly once across replays", async () => {
      await say("Answer:  ship the schema migration only ", "2003.1");
      await say("Answer:  ship the schema migration only ", "2003.1", "e-replay");
      await say("answer: actually wait", "2004.1");
      expect(repo.getById(decisionId)?.state).toBe("done");
      expect(resolutions()).toHaveLength(1);
      expect(resolutions()[0]?.transitionNote).toContain("ship the schema migration only");
      const answers = toSeat().filter((q) => q.tags?.includes("human-answer"));
      expect(answers).toHaveLength(2);
      expect(answers.map((q) => q.body).join("\n")).toContain("ship the schema migration only");
    });

    it("clarifying question, the seat's answer in the same thread, then an explicit approval", async () => {
      await say("Which migration, the schema one or the data one?", "2010.1");
      const seatReply = await repo.create({ ...request, humanIntent: "update", summary: "The schema one", body: "Only the schema migration; data follows next week.", replyTo: decisionId });
      await deliver(seatReply.qitemId);
      expect(posts.at(-1)?.thread_ts).toBe("1.1");
      expect(repo.getById(seatReply.qitemId)?.replyToFallback).toBeNull();
      expect(repo.getById(decisionId)?.state).toBe("pending");

      await say("answer: ship the schema migration", "2011.1");
      expect(repo.getById(decisionId)?.state).toBe("done");
      expect(resolutions()).toHaveLength(1);
      expect(resolutions()[0]?.transitionNote).toContain("ship the schema migration");
    });

    it("tells the seat that a conversation reply resolves nothing and how to answer in the thread", async () => {
      await say("Which one?", "2012.1");
      expect(toSeat()[0]?.body).toContain(`--reply-to ${decisionId}`);
    });

    async function click(blockId: string, actionId: string, messageTs: string, user = "UFOUNDER", actionTs = `${Date.now()}.${Math.random()}`): Promise<{ status: string; reason?: string }> {
      const envelopeId = `e-click-${actionTs}`;
      socket.onmessage?.({ data: JSON.stringify({
        envelope_id: envelopeId, type: "interactive",
        payload: {
          type: "block_actions", user: { id: user }, channel: { id: "C-TEST" },
          container: { type: "message", message_ts: messageTs, thread_ts: "1.1", channel_id: "C-TEST" },
          message: { ts: messageTs, thread_ts: "1.1" },
          actions: [{ type: "button", block_id: blockId, action_id: actionId, action_ts: actionTs }],
        },
      }) });
      await vi.waitFor(() => expect(finals(envelopeId)).toHaveLength(1));
      return finals(envelopeId)[0]!;
    }
    async function offerConfirm(reading: string): Promise<{ qitemId: string; messageTs: string }> {
      const offer = await repo.create({ ...request, humanIntent: "update", summary: "My reading", body: "Is this right?", replyTo: decisionId, humanConfirm: reading });
      await deliver(offer.qitemId);
      return { qitemId: offer.qitemId, messageTs: `${posts.length}.1` };
    }

    it("a Confirm button resolves the decision with exactly the stated reading, once", async () => {
      const reading = "Ship only the schema migration this week; data migration next week.";
      const offer = await offerConfirm(reading);
      const blocks = JSON.stringify(posts.at(-1)?.blocks);
      expect(posts.at(-1)?.thread_ts).toBe("1.1");
      expect(blocks).toContain(`or-confirm:${offer.qitemId}`);
      expect(String(posts.at(-1)?.text)).toContain(`Confirm: ${reading}`);

      await say("yes", "2020.1");
      expect(repo.getById(decisionId)?.state).toBe("pending");

      expect(await click(`or-confirm:${offer.qitemId}`, "or-confirm", offer.messageTs)).toMatchObject({ status: "accepted" });
      expect(await click(`or-confirm:${offer.qitemId}`, "or-confirm", offer.messageTs)).not.toMatchObject({ status: "handler-failed" });
      expect(repo.getById(decisionId)?.state).toBe("done");
      expect(resolutions()).toHaveLength(1);
      expect(resolutions()[0]?.transitionNote).toBe(`direct human reply received: ${reading}`);
      expect(toSeat().filter((q) => q.tags?.includes("human-answer"))).toHaveLength(1);
    });

    it("refuses a Confirm click from anyone but the addressed human", async () => {
      const offer = await offerConfirm("Ship it.");
      expect(await click(`or-confirm:${offer.qitemId}`, "or-confirm", offer.messageTs, "USTRANGER")).toMatchObject({ status: "refused" });
      expect(repo.getById(decisionId)?.state).toBe("pending");
    });

    it("refuses a confirm reading on anything but an update replying to a decision", async () => {
      await expect(repo.create({ ...request, humanIntent: "decision", humanConfirm: "x" })).rejects.toMatchObject({ code: "invalid_human_confirm" });
      await expect(repo.create({ ...request, humanIntent: "update", humanConfirm: "x" })).rejects.toMatchObject({ code: "invalid_human_confirm" });
      await expect(repo.create({ ...request, humanIntent: "update", replyTo: decisionId, humanConfirm: "  " })).rejects.toMatchObject({ code: "invalid_human_confirm" });
    });

    it("an empty `answer:` is conversation, not a resolution", async () => {
      await say("answer:   ", "2005.1");
      expect(repo.getById(decisionId)?.state).toBe("pending");
      expect(toSeat()[0]?.tags).toContain("conversation");
    });
  });

  describe("explicitAnswersOnly off keeps the #96 contract", () => {
    beforeEach(() => start(false));

    it("posts the decision without the `answer:` hint", () => {
      expect(String(posts[0]?.text)).not.toContain("answer:");
    });

    it("any typed reply answers the decision", async () => {
      await say("yes", "2100.1");
      expect(repo.getById(decisionId)?.state).toBe("done");
      expect(resolutions()).toHaveLength(1);
      expect(resolutions()[0]?.transitionNote).toContain("yes");
    });
  });
});
