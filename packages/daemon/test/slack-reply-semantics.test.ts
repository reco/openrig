// Phase 1 reply semantics: a typed reply in a decision's thread is conversation. It reaches the
// owning seat and resolves nothing. Only an explicit `answer:` reply resolves, exactly once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { ThreadSeatMap } from "../src/domain/gateway/slack/thread-seat-map.js";

const human = "human-founder@external";
const person = (entityId: string, handle: string) => ({ entityId, class: "human" as const, displayName: entityId, address: `${entityId}@external`, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle }], prefs: { deliveryClass: "A" as const } });
const registry = { ok: true as const, entities: [person("human-founder", "UFOUNDER"), person("human-other", "UOTHER")] };
const request = { sourceSession: "author@rig", destinationSession: human, summary: "Ship the migration?", body: "Tell me whether to ship it this week.", evidenceRef: "/private/proof.md", nudge: false };

describe("phase 1 reply semantics through the real Slack wire", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let socket: WsLike;
  let posts: Array<Record<string, unknown>>;
  let decisionId: string;
  let decisions: string[];
  let wire: ReturnType<typeof buildSlackGatewayWire>;
  const stops: Array<() => void> = [];
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  async function start(explicitAnswersOnly: boolean): Promise<void> {
    home = mkdtempSync(join(tmpdir(), "reply-semantics-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { loadHumanRegistry: () => registry });
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state", "slack-request-lifecycle-floor"), "0\n");
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\nSLACK_APP_TOKEN=xapp-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE", explicitAnswersOnly }, home);
    posts = [];
    const sockets: WsLike[] = [];
    decisions = [];
    const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    const realResolve = makeHumanReplyResolver(repo, contract);
    wire = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      resolveHumanReply: async (input) => {
        const outcome = await realResolve(input);
        if (outcome === "resolved") decisions.push(input.decision);
        return outcome;
      },
      wsFactory: () => { const ws: WsLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }; sockets.push(ws); return ws; },
      inboundMaxConnects: 1,
      inboundRetryIntervalMs: 50,
      requestSweepIntervalMs: 50,
      linkState: async () => "merged",
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
  async function sayAs(user: string, text: string, ts: string, envelopeId = `e-${ts}`): Promise<void> {
    const before = finals(envelopeId).length;
    socket.onmessage?.({ data: JSON.stringify({ envelope_id: envelopeId, type: "events_api", payload: { event: { type: "message", user, text, ts, thread_ts: "1.1", channel: "C-TEST" } } }) });
    await vi.waitFor(() => expect(finals(envelopeId).length).toBe(before + 1));
  }
  const say = (text: string, ts: string, envelopeId?: string) => sayAs("UFOUNDER", text, ts, envelopeId);
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

    it("is on by default, with 3-day stale reminders", () => {
      expect(DEFAULT_CONFIG.explicitAnswersOnly).toBe(true);
      expect(DEFAULT_CONFIG.staleReminderDays).toBe(3);
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
      expect(decisions).toEqual(["ship the schema migration only"]);
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
      expect(decisions).toEqual(["ship the schema migration"]);
    });

    it("tells the seat that a conversation reply resolves nothing and how to answer in the thread", async () => {
      await say("Which one?", "2012.1");
      expect(toSeat()[0]?.body).toContain(`--reply-to ${decisionId}`);
    });

    async function click(blockId: string, actionId: string, messageTs: string, user = "UFOUNDER", actionTs = `${Date.now()}.${Math.random()}`, rootTs = "1.1"): Promise<{ status: string; reason?: string }> {
      const envelopeId = `e-click-${actionTs}`;
      socket.onmessage?.({ data: JSON.stringify({
        envelope_id: envelopeId, type: "interactive",
        payload: {
          type: "block_actions", user: { id: user }, channel: { id: "C-TEST" },
          container: { type: "message", message_ts: messageTs, thread_ts: rootTs, channel_id: "C-TEST" },
          message: { ts: messageTs, thread_ts: rootTs },
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
      expect(decisions).toEqual([reading]);
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

    async function react(messageTs: string, opts: { user?: string; reaction?: string; envelopeId?: string } = {}): Promise<{ status: string; reason?: string }> {
      const envelopeId = opts.envelopeId ?? `e-react-${messageTs}-${opts.user ?? "UFOUNDER"}-${Math.random()}`;
      socket.onmessage?.({ data: JSON.stringify({ envelope_id: envelopeId, type: "events_api", payload: { event: {
        type: "reaction_added", user: opts.user ?? "UFOUNDER", reaction: opts.reaction ?? "white_check_mark",
        item: { type: "message", channel: "C-TEST", ts: messageTs }, event_ts: `${Date.now() / 1000}`,
      } } }) });
      await vi.waitFor(() => expect(finals(envelopeId)).toHaveLength(1));
      return finals(envelopeId)[0]!;
    }

    it("✅ on a Confirm offer resolves with the offer's reading", async () => {
      const offer = await offerConfirm("Ship only the schema migration.");
      expect(await react(offer.messageTs)).toMatchObject({ status: "accepted" });
      expect(resolutions()).toHaveLength(1);
      expect(decisions).toEqual(["Ship only the schema migration."]);
    });

    it("✅ on the human's own reply resolves with that reply's text", async () => {
      await say("Ship the schema migration, hold the data one.", "2030.1");
      expect(repo.getById(decisionId)?.state).toBe("pending");
      expect(await react("2030.1")).toMatchObject({ status: "accepted" });
      expect(resolutions()).toHaveLength(1);
      expect(decisions).toEqual(["Ship the schema migration, hold the data one."]);
    });

    it("✅ on the root of a plain decision resolves it as approved", async () => {
      expect(await react("1.1")).toMatchObject({ status: "accepted" });
      expect(decisions).toEqual(["approved"]);
    });

    it("resolves once across a replayed ✅, a second ✅ and an `answer:`", async () => {
      expect(await react("1.1", { envelopeId: "e-r1" })).toMatchObject({ status: "accepted" });
      socket.onmessage?.({ data: JSON.stringify({ envelope_id: "e-r1", type: "events_api", payload: { event: { type: "reaction_added", user: "UFOUNDER", reaction: "white_check_mark", item: { type: "message", channel: "C-TEST", ts: "1.1" } } } }) });
      await react("1.1");
      await say("answer: something else", "2031.1");
      expect(resolutions()).toHaveLength(1);
      expect(toSeat().filter((q) => q.tags?.includes("human-answer") && q.summary?.includes("✅"))).toHaveLength(1);
    });

    it("ignores other emoji, other people's ✅, and ✅ on someone else's message", async () => {
      await say("Which one?", "2032.1");
      expect(await react("1.1", { reaction: "thumbsup" })).toMatchObject({ status: "ignored" });
      expect(await react("1.1", { user: "UOTHER" })).not.toMatchObject({ status: "accepted" });
      expect(await react("2032.1", { user: "UOTHER" })).not.toMatchObject({ status: "accepted" });
      expect(await react("9999.1")).toMatchObject({ status: "ignored" });
      expect(repo.getById(decisionId)?.state).toBe("pending");
    });

    it("`cancel` from the asked human closes the request; from anyone else it is conversation", async () => {
      await sayAs("UOTHER", "cancel", "2040.1");
      expect(repo.getById(decisionId)?.state).toBe("pending");
      await say("Cancel the data migration, keep the schema one", "2043.1");
      expect(repo.getById(decisionId)?.state).toBe("pending");
      await say("Cancel: we dropped this", "2041.1");
      expect(repo.getById(decisionId)?.state).toBe("canceled");
      expect(new ThreadSeatMap(db).resolveByThread("1.1")?.state).toBe("closed");
      expect(posts.some((p) => p.thread_ts === "1.1" && /closed/i.test(String(p.text)))).toBe(true);
      expect(resolutions()).toEqual([]);
    });

    it("the running wire closes a request once its linked PR merges", async () => {
      repo.addRequestLinks({ qitemId: decisionId, actorSession: "author@rig", links: ["pr:https://github.com/reco/openrig/pull/1"] });
      await vi.waitFor(() => expect(new ThreadSeatMap(db).resolveByThread("1.1")?.state).toBe("closed"));
      expect(repo.getById(decisionId)?.state).toBe("done");
    });

    it("escapes the human's cancel reason in the closing line", async () => {
      await say("cancel: <!channel> not needed", "2042.1");
      const closing = posts.find((p) => p.thread_ts === "1.1" && /closed/i.test(String(p.text)));
      expect(closing).toBeDefined();
      expect(String(closing?.text)).not.toContain("<!channel>");
      expect(String(closing?.text)).toContain("&lt;!channel&gt;");
    });

    const park = async () => {
      const work = await repo.create({ sourceSession: "author@rig", destinationSession: "worker@rig", body: "Ship the fix.", nudge: false });
      repo.update({ qitemId: work.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: "human-founder@kernel", summary: "Merge the fix?", evidenceRef: "/proof/PR.md", transitionNote: "parked for approval" });
      await deliver(work.qitemId);
      return { workId: work.qitemId, rootTs: `${posts.length}.1` };
    };
    const repark = async (workId: string, summary: string) => {
      repo.update({ qitemId: workId, actorSession: "worker@rig", state: "blocked", blockedOn: "human-founder@kernel", summary, evidenceRef: "/proof/PR2.md", transitionNote: "parked again" });
      const before = posts.length;
      const alert = async () => (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === workId);
      wire.dispatcher.dispatch("post_message", human, await alert());
      await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
      await vi.waitFor(async () => expect(await alert()).toBeUndefined());
    };
    const sayAsIn = async (user: string, threadTs: string, text: string, ts: string) => {
      const envelopeId = `e-${ts}`;
      socket.onmessage?.({ data: JSON.stringify({ envelope_id: envelopeId, type: "events_api", payload: { event: { type: "message", user, text, ts, thread_ts: threadTs, channel: "C-TEST" } } }) });
      await vi.waitFor(() => expect(finals(envelopeId)).toHaveLength(1));
    };
    const sayIn = (threadTs: string, text: string, ts: string) => sayAsIn("UFOUNDER", threadTs, text, ts);

    it("a canceled park's thread no longer answers its gate", async () => {
      const { workId, rootTs } = await park();
      await sayIn(rootTs, "cancel: not needed", "2050.1");
      expect(new ThreadSeatMap(db).resolveByThread(rootTs)?.state).toBe("closed");
      await sayIn(rootTs, "answer: approved after all", "2051.1");
      expect(repo.getById(workId)?.state).toBe("blocked");
      expect(decisions).toEqual([]);
      expect(repo.list({ limit: 100 }).some((q) => q.destinationSession === "worker@rig" && q.tags?.includes("request-closed"))).toBe(true);
    });

    it("notes on a parked row do not start a new gate: ✅ on a reply and a Confirm offer still answer it", async () => {
      const { workId, rootTs } = await park();
      await sayIn(rootTs, "merge it once CI is green", "2090.1");
      repo.update({ qitemId: workId, actorSession: "worker@rig", transitionNote: "still waiting" });
      expect(await react("2090.1")).toMatchObject({ status: "accepted" });
      expect(decisions).toEqual(["merge it once CI is green"]);
    });

    it("a note on a parked row does not void a Confirm offer", async () => {
      const { workId, rootTs } = await park();
      const offer = await repo.create({ ...request, sourceSession: "worker@rig", humanIntent: "update", summary: "Reading", body: "Right?", replyTo: workId, humanConfirm: "Merge now." });
      await deliver(offer.qitemId);
      repo.addRequestLinks({ qitemId: workId, actorSession: "worker@rig", links: ["pr:https://github.com/reco/openrig/pull/7"] });
      expect(await click(`or-confirm:${offer.qitemId}`, "or-confirm", `${posts.length}.1`, "UFOUNDER", "3100.1", rootTs)).toMatchObject({ status: "accepted" });
      expect(decisions).toEqual(["Merge now."]);
    });

    it("another registered human's ✅ on their own reply does not answer a park", async () => {
      const { workId, rootTs } = await park();
      await sayAsIn("UOTHER", rootTs, "looks fine to me", "2070.1");
      expect(await react("2070.1", { user: "UOTHER" })).not.toMatchObject({ status: "accepted" });
      expect(repo.getById(workId)?.state).toBe("blocked");
    });

    it("the asked human can still cancel a park after answering it", async () => {
      const { workId, rootTs } = await park();
      await sayIn(rootTs, "answer: merge it", "2080.1");
      expect(repo.getById(workId)?.state).toBe("in-progress");
      await sayIn(rootTs, "cancel", "2081.1");
      expect(new ThreadSeatMap(db).resolveByThread(rootTs)?.state).toBe("closed");
    });

    it("✅ on a reply from an earlier gate episode does not answer the re-parked gate", async () => {
      const { workId, rootTs } = await park();
      await sayIn(rootTs, "old thought about the first question", "2060.1");
      await sayIn(rootTs, "answer: merge it", "2061.1");
      expect(repo.getById(workId)?.state).toBe("in-progress");
      await repark(workId, "Deploy it too?");
      expect(await react("2060.1")).not.toMatchObject({ status: "accepted" });
      expect(repo.getById(workId)?.state).toBe("blocked");
      expect(decisions).toEqual(["merge it"]);
    });

    it("✅ on a Confirm offer from an earlier gate episode does not answer the re-parked gate", async () => {
      const { workId, rootTs } = await park();
      const offer = await repo.create({ ...request, sourceSession: "worker@rig", humanIntent: "update", summary: "Reading", body: "Right?", replyTo: workId, humanConfirm: "Merge the fix now." });
      await deliver(offer.qitemId);
      const offerTs = `${posts.length}.1`;
      expect(await click(`or-confirm:${offer.qitemId}`, "or-confirm", offerTs, "UFOUNDER", "3000.1", rootTs)).toMatchObject({ status: "accepted" });
      await repark(workId, "Deploy it too?");
      expect(await react(offerTs)).not.toMatchObject({ status: "accepted" });
      expect(repo.getById(workId)?.state).toBe("blocked");
      expect(decisions).toEqual(["Merge the fix now."]);
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
      expect(decisions).toEqual(["yes"]);
    });
  });
});
