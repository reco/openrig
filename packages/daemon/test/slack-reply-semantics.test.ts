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
const registry = { ok: true as const, entities: [person("human-founder", "UFOUNDER"), person("human-other", "UOTHER"), { ...person("lee", "ULEE"), role: "requester" as const }] };
const request = { sourceSession: "author@rig", destinationSession: human, summary: "Ship the migration?", body: "Tell me whether to ship it this week.", evidenceRef: "/private/proof.md", nudge: false };

describe("phase 1 reply semantics through the real Slack wire", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let socket: WsLike;
  let posts: Array<Record<string, unknown>>;
  let decisionId: string;
  let decisions: string[];
  let bus: EventBus;
  let updates: Array<Record<string, unknown>>;
  let seen: Array<Record<string, unknown>>;
  let unseen: Array<Record<string, unknown>>;
  let marks: Map<string, Set<string>>;
  let statuses: Array<Record<string, unknown>>;
  let statusSupported = true;
  let statusError: string | undefined;
  const marksOn = (ts: string) => { if (!marks.has(ts)) marks.set(ts, new Set()); return marks.get(ts)!; };
  const holding = (name: string) => ({ has: (ts: string) => marks.get(ts)?.has(name) === true });
  const eyes = holding("eyes");
  const thinking = holding("thinking_face");
  let wire: ReturnType<typeof buildSlackGatewayWire>;
  const stops: Array<() => void> = [];
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  async function start(explicitAnswersOnly: boolean, receipts?: Record<string, string>, extra: Record<string, unknown> = {}): Promise<void> {
    home = mkdtempSync(join(tmpdir(), "reply-semantics-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { loadHumanRegistry: () => registry });
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state", "slack-request-lifecycle-floor"), "0\n");
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\nSLACK_APP_TOKEN=xapp-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE", explicitAnswersOnly, ...(receipts ? { receipts: receipts as never } : {}), ...extra }, home);
    posts = [];
    const sockets: WsLike[] = [];
    decisions = [];
    updates = [];
    seen = [];
    unseen = [];
    marks = new Map();
    statuses = [];
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
      statusRefreshMs: 60,
      linkState: async () => "merged",
      fetchImpl: async (url, init) => {
        if (url.endsWith("apps.connections.open")) return reply({ ok: true, url: "wss://fake-slack/ws" });
        if (url.endsWith("chat.update")) { updates.push(JSON.parse(String(init?.body))); return reply({ ok: true }); }
        if (url.endsWith("assistant.threads.setStatus")) { statuses.push(JSON.parse(String(init?.body))); return reply(statusError ? { ok: false, error: statusError } : statusSupported ? { ok: true } : { ok: false, error: "channel_not_found" }); }
        if (url.endsWith("reactions.add")) { const b = JSON.parse(String(init?.body)); seen.push(b); marksOn(b.timestamp).add(b.name); return reply({ ok: true }); }
        if (url.endsWith("reactions.remove")) { const b = JSON.parse(String(init?.body)); unseen.push(b); marksOn(b.timestamp).delete(b.name); return reply({ ok: true }); }
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

    it("gives a plain decision one Confirm button and no footer", () => {
      const blocks = JSON.stringify(posts[0]?.blocks);
      expect(blocks).toContain(`or-confirm:${decisionId}`);
      expect(blocks).toContain('"text":"Confirm"');
      expect(blocks).not.toContain("Not now");
      expect(String(posts[0]?.text)).not.toContain("answer:");
    });

    it("Confirm records confirmed, then shows the decision", async () => {
      expect(await click(`or-confirm:${decisionId}`, "or-confirm", "1.1", "UFOUNDER", "3600.1")).toMatchObject({ status: "accepted" });
      expect(decisions).toEqual(["confirmed"]);
      expect(String(updates.find((u) => u.ts === "1.1")?.text)).toContain("Decided: *Confirm*");
      expect(JSON.stringify(updates.find((u) => u.ts === "1.1")?.blocks)).not.toContain("or-confirm");
    });

    it("refuses an acknowledgement request: information needs no acknowledgement", async () => {
      await expect(repo.create({ ...request, humanIntent: "decision", humanAck: true })).rejects.toMatchObject({ code: "invalid_human_ack" });
    });

    it("the workspace's own rating emoji count as 👍/👎 when configured, skin tones ignored", async () => {
      for (const stop of stops.splice(0)) stop();
      await start(true, undefined, { feedbackReactions: { up: ["rr-thumbsup", "rr-plus1"], down: ["rr-thumbsdown", "rr-minus1"] } });
      expect(await react("1.1", { reaction: "rr-plus1" })).toMatchObject({ status: "accepted", reason: "feedback-+1" });
      expect(await react("1.1", { reaction: "rr-minus1::skin-tone-3" })).toMatchObject({ status: "accepted", reason: "feedback--1" });
      expect(await react("1.1", { reaction: "+1" })).not.toMatchObject({ status: "accepted" });
      expect(toSeat().filter((q) => q.tags?.includes("human-feedback"))).toHaveLength(1);
    });

    it("👍 and 👎 are recorded as feedback and never decide; 👎 asks the seat for an alternative", async () => {
      expect(await react("1.1", { reaction: "+1" })).toMatchObject({ status: "accepted" });
      expect(await react("1.1", { reaction: "-1" })).toMatchObject({ status: "accepted" });
      await react("1.1", { reaction: "-1" });
      expect(repo.getById(decisionId)?.state).toBe("pending");
      expect(decisions).toEqual([]);
      const notes = repo.transitionLog.listForQitem(decisionId).map((t) => t.transitionNote ?? "").filter((n) => n.startsWith("human-feedback "));
      expect(notes).toHaveLength(2);
      const asks = toSeat().filter((q) => q.tags?.includes("human-feedback"));
      expect(asks).toHaveLength(1);
      expect(asks[0]?.summary).toContain("👎");
      expect(asks[0]?.body).toContain("Record ONE short lesson");
      expect(asks[0]?.body).toContain(`--reply-to ${decisionId}`);
      expect(await react("1.1", { reaction: "-1", user: "UOTHER" })).not.toMatchObject({ status: "accepted" });
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
      expect(String(posts.at(-1)?.text)).toContain(`My reading:* ${reading}`);

      await say("yes", "2020.1");
      expect(repo.getById(decisionId)?.state).toBe("pending");

      expect(await click(`or-confirm:${offer.qitemId}`, "or-confirm", offer.messageTs)).toMatchObject({ status: "accepted" });
      expect(await click(`or-confirm:${offer.qitemId}`, "or-confirm", offer.messageTs)).not.toMatchObject({ status: "handler-failed" });
      expect(repo.getById(decisionId)?.state).toBe("done");
      expect(resolutions()).toHaveLength(1);
      expect(decisions).toEqual([reading]);
      expect(toSeat().filter((q) => q.tags?.includes("human-answer"))).toHaveLength(1);
    });

    it("replaces the Confirm button with the confirmed reading after the first click", async () => {
      const offer = await offerConfirm("Ship widget A this week.");
      await click(`or-confirm:${offer.qitemId}`, "or-confirm", offer.messageTs);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ channel: "C-TEST", ts: offer.messageTs });
      expect(JSON.stringify(updates[0]?.blocks)).not.toContain("or-confirm");
      expect(String(updates[0]?.text)).toContain("Confirmed: Ship widget A this week.");
      expect(String(updates[0]?.text)).toContain("Is this right?");
    });

    it("a click on an offer after a different answer says Not used, never Confirmed", async () => {
      const offer = await offerConfirm("Ship widget A this week.");
      await say("answer: No, do not ship", "2200.1");
      expect(await click(`or-confirm:${offer.qitemId}`, "or-confirm", offer.messageTs)).not.toMatchObject({ status: "accepted" });
      expect(decisions).toEqual(["No, do not ship"]);
      const edit = updates.find((u) => u.ts === offer.messageTs);
      expect(String(edit?.text)).toContain("Not used");
      expect(String(edit?.text)).not.toContain("Confirmed");
      expect(toSeat().some((q) => q.summary?.includes("confirmed your reading"))).toBe(false);
    });

    it("two overlapping clicks on one offer leave it Confirmed", async () => {
      const offer = await offerConfirm("Ship widget A.");
      await Promise.all([
        click(`or-confirm:${offer.qitemId}`, "or-confirm", offer.messageTs, "UFOUNDER", "3400.1"),
        click(`or-confirm:${offer.qitemId}`, "or-confirm", offer.messageTs, "UFOUNDER", "3400.2"),
      ]);
      expect(decisions).toEqual(["Ship widget A."]);
      const edits = updates.filter((u) => u.ts === offer.messageTs);
      expect(String(edits.at(-1)?.text)).toContain("Confirmed: Ship widget A.");
      expect(edits.some((u) => String(u.text).includes("Not used"))).toBe(false);
    });

    it("two offers clicked at once: one wins, the other is Not used and sends nothing", async () => {
      const a = await offerConfirm("Ship widget A.");
      const b = await offerConfirm("Ship widget B.");
      await Promise.all([
        click(`or-confirm:${a.qitemId}`, "or-confirm", a.messageTs, "UFOUNDER", "3500.1"),
        click(`or-confirm:${b.qitemId}`, "or-confirm", b.messageTs, "UFOUNDER", "3500.2"),
      ]);
      expect(decisions).toHaveLength(1);
      expect(toSeat().filter((q) => q.summary?.includes("confirmed your reading"))).toHaveLength(1);
      const texts = [a, b].map((o) => String(updates.filter((u) => u.ts === o.messageTs).at(-1)?.text));
      expect(texts.filter((t) => t.includes("Confirmed")).length).toBe(1);
      expect(texts.filter((t) => t.includes("Not used")).length).toBe(1);
    });

    it("of two offers only the clicked winner says Confirmed", async () => {
      const a = await offerConfirm("Ship widget A.");
      const b = await offerConfirm("Ship widget B.");
      await click(`or-confirm:${a.qitemId}`, "or-confirm", a.messageTs);
      await click(`or-confirm:${b.qitemId}`, "or-confirm", b.messageTs);
      expect(decisions).toEqual(["Ship widget A."]);
      expect(String(updates.find((u) => u.ts === a.messageTs)?.text)).toContain("Confirmed: Ship widget A.");
      expect(String(updates.find((u) => u.ts === b.messageTs)?.text)).toContain("Not used");
    });

    it("keeps the evidence link when it replaces a button", async () => {
      const cta = await repo.create({ ...request, summary: "Approve the spec?", evidenceRef: "https://example.com/widget-spec", humanIntent: "decision", humanConfirm: "Build it" });
      await deliver(cta.qitemId);
      const root = `${posts.length}.1`;
      expect(String(posts.at(-1)?.text)).toContain("https://example.com/widget-spec");
      await click(`or-confirm:${cta.qitemId}`, "or-confirm", root, "UFOUNDER", "3300.1", root);
      const edit = updates.find((u) => u.ts === root);
      expect(String(edit?.text)).toContain("https://example.com/widget-spec");
      expect(JSON.stringify(edit?.blocks)).toContain("https://example.com/widget-spec");
    });

    it("replaces the Confirm button after a ✅ on the offer too", async () => {
      const offer = await offerConfirm("Ship widget A this week.");
      await react(offer.messageTs);
      expect(updates.map((u) => u.ts)).toEqual([offer.messageTs]);
    });

    it("refuses a Confirm click from anyone but the addressed human", async () => {
      const offer = await offerConfirm("Ship it.");
      expect(await click(`or-confirm:${offer.qitemId}`, "or-confirm", offer.messageTs, "USTRANGER")).toMatchObject({ status: "refused" });
      expect(repo.getById(decisionId)?.state).toBe("pending");
    });

    it("an approve button on a decision carries the seat's call to action and approves with it", async () => {
      const cta = await repo.create({ ...request, summary: "Approve the widget?", humanIntent: "decision", humanConfirm: "🚀 Build it" });
      await deliver(cta.qitemId);
      const root = `${posts.length}.1`;
      expect(JSON.stringify(posts.at(-1)?.blocks)).toContain(`or-confirm:${cta.qitemId}`);
      expect(JSON.stringify(posts.at(-1)?.blocks)).toContain("🚀 Build it");
      expect(String(posts.at(-1)?.text)).not.toContain("react ✅");
      expect(String(posts.at(-1)?.text)).not.toContain("answer:");
      expect(await react(root)).toMatchObject({ status: "ignored" });
      expect(repo.getById(cta.qitemId)?.state).toBe("pending");
      expect(await click(`or-confirm:${cta.qitemId}`, "or-confirm", root, "UFOUNDER", "3200.1", root)).toMatchObject({ status: "accepted" });
      expect(repo.getById(cta.qitemId)?.state).toBe("done");
      expect(decisions).toEqual(["🚀 Build it"]);
      expect(updates.map((u) => u.ts)).toEqual([root]);
      expect(JSON.stringify(updates[0]?.blocks)).not.toContain("or-confirm");
    });

    it("refuses an approve button that is too long for Slack or sits beside questions", async () => {
      await expect(repo.create({ ...request, humanIntent: "decision", humanConfirm: "x".repeat(76) })).rejects.toMatchObject({ code: "invalid_human_confirm" });
      await expect(repo.create({ ...request, humanIntent: "decision", humanConfirm: "Go", humanQuestions: [{ id: "q", question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] })).rejects.toMatchObject({ code: "invalid_human_confirm" });
    });

    it("refuses a confirm reading on an update that does not reply to a decision", async () => {
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

    it("✅ on the root of a decision with buttons does nothing", async () => {
      expect(await react("1.1")).toMatchObject({ status: "ignored" });
      expect(decisions).toEqual([]);
    });


    it("ignores other emoji, other people's ✅, and ✅ on someone else's message", async () => {
      await say("Which one?", "2032.1");
      expect(await react("1.1", { reaction: "eyes" })).toMatchObject({ status: "ignored" });
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

    it("another registered human's `answer:` on a park resolves nothing", async () => {
      const { workId, rootTs } = await park();
      await sayAsIn("UOTHER", rootTs, "answer: approved", "2091.1");
      expect(repo.getById(workId)?.state).toBe("blocked");
      expect(decisions).toEqual([]);
    });

    it("a requester's `answer:`, ✅ and Confirm on an approver's park resolve nothing; his words reach the seat as untrusted conversation", async () => {
      const { workId, rootTs } = await park();
      await sayAsIn("ULEE", rootTs, "answer: yes", "2092.1");
      expect(await react(rootTs, { user: "ULEE" })).toMatchObject({ status: "refused" });
      expect(await click(`or-confirm:${workId}`, "or-confirm", rootTs, "ULEE", "3951.1", rootTs)).toMatchObject({ status: "refused" });
      expect(repo.getById(workId)?.state).toBe("blocked");
      expect(decisions).toEqual([]);
      const row = repo.list({ limit: 100 }).find((q) => q.body.includes("answer: yes"));
      expect(row?.sourceSession).toBe("lee@external");
      expect(row?.tags).toEqual(expect.arrayContaining(["untrusted-requester"]));
      expect(row?.summary).toContain("Requester lee@external (untrusted) via Slack");
    });

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

    it("a private channel's thread reply and ✅ behave like a public channel's", async () => {
      socket.onmessage?.({ data: JSON.stringify({ envelope_id: "e-group", type: "events_api", payload: { event: { type: "message", channel_type: "group", user: "UFOUNDER", text: "Private question?", ts: "2300.1", thread_ts: "1.1", channel: "C-TEST" } } }) });
      await vi.waitFor(() => expect(finals("e-group")).toHaveLength(1));
      expect(toSeat().find((q) => q.body.includes("Private question?"))?.tags).toContain("conversation");
      expect(await react("2300.1")).toMatchObject({ status: "accepted" });
      expect(decisions).toEqual(["Private question?"]);
    });

    it("puts 👀 on each message of the human's that lands, once", async () => {
      await say("Are you there?", "2400.1");
      await say("Are you there?", "2400.1", "e-dup");
      expect(seen).toEqual([{ channel: "C-TEST", timestamp: "2400.1", name: "eyes" }]);
    });

    const activity = (sessionName: string, state: "running" | "idle") => bus.emit({ type: "agent.activity", rigId: "r", nodeId: "n", sessionName, runtime: "claude-code",
      activity: { state, reason: "test", evidenceSource: "runtime_hook", sampledAt: new Date().toISOString(), evidence: null } } as never);

    it("receipt follows the seat: 👀 received, 🤔 claimed, 🛠️ while working, ✅ when handled", async () => {
      await say("Please check the build", "2700.1");
      const row = toSeat().find((q) => q.body.includes("Please check the build"))!;
      expect([...marksOn("2700.1")]).toEqual(["eyes"]);
      repo.claim({ qitemId: row.qitemId, destinationSession: "author@rig" });
      await vi.waitFor(() => expect([...marksOn("2700.1")]).toEqual(["thinking_face"]));
      activity("author@rig", "running");
      await vi.waitFor(() => expect([...marksOn("2700.1")]).toEqual(["hammer_and_wrench"]));
      activity("author@rig", "idle");
      await vi.waitFor(() => expect([...marksOn("2700.1")]).toEqual(["thinking_face"]));
      repo.update({ qitemId: row.qitemId, actorSession: "author@rig", state: "done", closureReason: "no-follow-on", transitionNote: "done" });
      await vi.waitFor(() => expect([...marksOn("2700.1")]).toEqual(["white_check_mark"]));
    });

    it("while the seat works, Slack's status line shows it in the message's thread, refreshed, and cleared after", async () => {
      statusSupported = true;
      await say("Run the tests please", "2900.1");
      const row = toSeat().find((q) => q.body.includes("Run the tests please"))!;
      repo.claim({ qitemId: row.qitemId, destinationSession: "author@rig" });
      activity("author@rig", "running");
      await vi.waitFor(() => expect(statuses.some((s) => s.thread_ts === "1.1" && String(s.status).length > 0)).toBe(true));
      const first = statuses.length;
      await vi.waitFor(() => expect(statuses.length).toBeGreaterThan(first));
      expect(posts.some((p) => /Working/.test(String(p.text)))).toBe(false);
      repo.update({ qitemId: row.qitemId, actorSession: "author@rig", state: "done", closureReason: "no-follow-on", transitionNote: "done" });
      await vi.waitFor(() => expect(statuses.at(-1)).toMatchObject({ thread_ts: "1.1", status: "" }));
    });

    it("where the status line is unsupported, one live reply in the thread shows the step and ends as done", async () => {
      statusSupported = false;
      try {
        await say("Deploy the preview", "2950.1");
        const row = toSeat().find((q) => q.body.includes("Deploy the preview"))!;
        repo.claim({ qitemId: row.qitemId, destinationSession: "author@rig" });
        activity("author@rig", "running");
        await vi.waitFor(() => expect(posts.filter((p) => p.thread_ts === "1.1" && /Working/.test(String(p.text)))).toHaveLength(1));
        repo.update({ qitemId: row.qitemId, actorSession: "author@rig", state: "done", closureReason: "no-follow-on", transitionNote: "done" });
        await vi.waitFor(() => expect(updates.some((u) => /done/i.test(String(u.text)))).toBe(true));
        expect(posts.filter((p) => /Working/.test(String(p.text)))).toHaveLength(1);
      } finally { statusSupported = true; }
    });

    it("a rate-limited status line stays a status line, and an unchanged step is not resent per event", async () => {
      await say("Refactor the parser", "2960.1");
      const row = toSeat().find((q) => q.body.includes("Refactor the parser"))!;
      repo.claim({ qitemId: row.qitemId, destinationSession: "author@rig" });
      statusError = "ratelimited";
      try {
        activity("author@rig", "running");
        await vi.waitFor(() => expect(statuses.filter((s) => s.thread_ts === "1.1").length).toBeGreaterThan(1));
      } finally { statusError = undefined; }
      await vi.waitFor(() => expect(statuses.at(-1)).toMatchObject({ thread_ts: "1.1" }));
      expect(posts.some((p) => /Working/.test(String(p.text)))).toBe(false);
      await new Promise((r) => setTimeout(r, 80));
      const before = statuses.length;
      for (let i = 0; i < 20; i++) activity("author@rig", "running");
      await new Promise((r) => setTimeout(r, 30));
      expect(statuses.length - before).toBeLessThanOrEqual(1);
    });

    const toolUse = (sessionName: string, runtime: string, rawSubtype: string, target?: string) => bus.emit({ type: "agent.activity", rigId: "r", nodeId: "n", sessionName, runtime,
      activity: { state: "running", reason: "pre_tool_use", evidenceSource: "runtime_hook", sampledAt: new Date().toISOString(), evidence: null, rawEvent: "PreToolUse", rawSubtype, runtime, ...(target ? { target } : {}) } } as never);

    it("a claimed message shows coding while the seat edits files and typing while it writes to the human", async () => {
      await say("Fix the bug please", "3000.1");
      const row = toSeat().find((q) => q.body.includes("Fix the bug please"))!;
      repo.claim({ qitemId: row.qitemId, destinationSession: "author@rig" });
      toolUse("author@rig", "claude-code", "Edit");
      await vi.waitFor(() => expect([...marksOn("3000.1")]).toEqual(["keyboard"]));
      toolUse("author@rig", "claude-code", "rig-queue-create", "human-founder@external");
      await vi.waitFor(() => expect([...marksOn("3000.1")]).toEqual(["writing_hand"]));
      toolUse("author@rig", "claude-code", "rig-queue-create", "worker@rig");
      await vi.waitFor(() => expect([...marksOn("3000.1")]).toEqual(["hammer_and_wrench"]));
      toolUse("author@rig", "codex", "Edit");
      await new Promise((r) => setTimeout(r, 100));
      expect([...marksOn("3000.1")]).toEqual(["hammer_and_wrench"]);
    });

    it("tool use on a seat with no claimed message changes nothing", async () => {
      await say("Unclaimed", "3010.1");
      toolUse("author@rig", "claude-code", "Edit");
      await new Promise((r) => setTimeout(r, 100));
      expect([...marksOn("3010.1")]).toEqual(["eyes"]);
    });

    it("swaps 👀 for 🤔 when the seat claims the message, and clears it when done", async () => {
      await say("Can you look into this?", "2405.1");
      const row = toSeat().find((q) => q.body.includes("Can you look into this?"))!;
      expect(eyes.has("2405.1")).toBe(true);
      repo.claim({ qitemId: row.qitemId, destinationSession: "author@rig" });
      await vi.waitFor(() => expect(thinking.has("2405.1")).toBe(true));
      expect(eyes.has("2405.1")).toBe(false);
      repo.update({ qitemId: row.qitemId, actorSession: "author@rig", state: "done", closureReason: "no-follow-on", transitionNote: "done" });
      await vi.waitFor(() => expect(thinking.has("2405.1")).toBe(false));
      expect(eyes.has("2405.1")).toBe(false);
    });

    it("a claim that lands before the 👀 shows 🤔, not 👀", async () => {
      const original = repo.create.bind(repo);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const spy = vi.spyOn(repo, "create").mockImplementation(async (input) => {
        const row = await original(input);
        if (input.tags?.includes("conversation")) await gate;
        return row;
      });
      const pending = say("Fast claim", "2406.1");
      try {
        await vi.waitFor(() => expect(toSeat()).toHaveLength(1));
        repo.claim({ qitemId: toSeat()[0]!.qitemId, destinationSession: "author@rig" });
        release();
        await pending;
        await vi.waitFor(() => expect(thinking.has("2406.1")).toBe(true));
        expect(eyes.has("2406.1")).toBe(false);
      } finally { release(); await pending; spy.mockRestore(); }
    });

    it("takes the 👀 off once the seat closes the received message", async () => {
      await say("Can you check the logs?", "2410.1");
      const row = toSeat().find((q) => q.body.includes("Can you check the logs?"))!;
      expect(eyes.has("2410.1")).toBe(true);
      repo.update({ qitemId: row.qitemId, actorSession: "author@rig", state: "done", closureReason: "no-follow-on", transitionNote: "checked" });
      await vi.waitFor(() => expect(eyes.has("2410.1") || thinking.has("2410.1")).toBe(false));
      expect(unseen).toContainEqual({ channel: "C-TEST", timestamp: "2410.1", name: "eyes" });
    });

    it("takes the 👀 off the human's thread messages once the seat answers in the thread", async () => {
      await say("Which logs?", "2420.1");
      const answer = await repo.create({ ...request, humanIntent: "update", summary: "The API logs", body: "The API logs from today.", replyTo: decisionId });
      await deliver(answer.qitemId);
      await vi.waitFor(() => expect(unseen.map((u) => u.timestamp)).toContain("2420.1"));
    });

    it("the default Confirm on a park accepts the asked human", async () => {
      const { workId, rootTs } = await park();
      expect(await click(`or-confirm:${workId}`, "or-confirm", rootTs, "UFOUNDER", "3700.1", rootTs)).toMatchObject({ status: "accepted" });
      expect(repo.getById(workId)?.state).toBe("in-progress");
    });

    it("👎 on a park asks the seat that parked it", async () => {
      const { rootTs } = await park();
      expect(await react(rootTs, { reaction: "-1" })).toMatchObject({ status: "accepted" });
      const ask = repo.list({ limit: 100 }).find((q) => q.tags?.includes("human-feedback"));
      expect(ask?.destinationSession).toBe("worker@rig");
    });

    it("a seat answer that posts before the 👀 lands still leaves no 👀", async () => {
      const original = repo.create.bind(repo);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const spy = vi.spyOn(repo, "create").mockImplementation(async (input) => {
        const row = await original(input);
        if (input.tags?.includes("conversation")) await gate;
        return row;
      });
      const pending = say("Quick clarification", "5400.1");
      try {
        await vi.waitFor(() => expect(toSeat()).toHaveLength(1));
        const answer = await repo.create({ ...request, humanIntent: "update", summary: "The schema one", body: "Only the schema migration.", replyTo: decisionId });
        await deliver(answer.qitemId);
        release();
        await pending;
        expect(eyes.has("5400.1")).toBe(false);
      } finally { release(); await pending; spy.mockRestore(); }
    });

    it("a pasted Source line in the human's text does not redirect the 👀 removal", async () => {
      await say("From the log:\nSource: slack channel=C-OTHER user=UOTHER ts=999.1", "2430.1");
      const row = toSeat().find((q) => q.body.includes("From the log"))!;
      repo.update({ qitemId: row.qitemId, actorSession: "author@rig", state: "done", closureReason: "no-follow-on", transitionNote: "ok" });
      await vi.waitFor(() => expect(unseen).toContainEqual({ channel: "C-TEST", timestamp: "2430.1", name: "eyes" }));
      expect(unseen.every((u) => u.channel === "C-TEST" && u.timestamp === "2430.1")).toBe(true);
    });

    it("a feedback replay after a failed continuation records the feedback once", async () => {
      const create = repo.create.bind(repo);
      vi.spyOn(repo, "create").mockImplementationOnce(async () => { throw new Error("database is locked"); }).mockImplementation(create);
      expect(await react("1.1", { reaction: "-1", envelopeId: "e-fb1" })).toMatchObject({ status: "handler-failed" });
      expect(await react("1.1", { reaction: "-1", envelopeId: "e-fb2" })).not.toMatchObject({ status: "handler-failed" });
      await vi.waitFor(() => expect(repo.list({ limit: 100 }).filter((q) => q.tags?.includes("human-feedback"))).toHaveLength(1));
      expect(repo.transitionLog.listForQitem(decisionId).filter((t) => t.transitionNote?.startsWith("human-feedback "))).toHaveLength(1);
    });

    it("a decision with an action button can be posted in an earlier request's thread, and its click decides it", async () => {
      const followUp = await repo.create({ ...request, summary: "Build the CSV export now?", body: "Spec is done.", humanIntent: "decision", replyTo: decisionId, humanConfirm: "Build it" });
      await deliver(followUp.qitemId);
      const ts = `${posts.length}.1`;
      expect(posts.at(-1)?.thread_ts).toBe("1.1");
      expect(JSON.stringify(posts.at(-1)?.blocks)).toContain(`or-confirm:${followUp.qitemId}`);
      expect(await click(`or-confirm:${followUp.qitemId}`, "or-confirm", ts, "UFOUNDER", "3800.1", "1.1")).toMatchObject({ status: "accepted" });
      expect(decisions).toEqual(["Build it"]);
      expect(repo.getById(followUp.qitemId)?.state).toBe("done");
      expect(repo.getById(decisionId)?.state).toBe("pending");
    });

    it("option buttons in a thread record their answers on the decision they belong to", async () => {
      const followUp = await repo.create({ ...request, summary: "Which day?", body: "Pick one.", humanIntent: "decision", replyTo: decisionId,
        humanQuestions: [{ id: "day", question: "Launch day?", options: [{ id: "mon", label: "Mon" }, { id: "tue", label: "Tue" }] }] });
      await deliver(followUp.qitemId);
      const ts = `${posts.length}.1`;
      expect(posts.at(-1)?.thread_ts).toBe("1.1");
      expect(await click("or-q:day", "or-opt:tue", ts, "UFOUNDER", "3810.1", "1.1")).toMatchObject({ status: "accepted" });
      expect(repo.getById(followUp.qitemId)).toMatchObject({ state: "done", humanAnswers: { day: "tue" } });
      expect(toSeat().find((q) => q.tags?.includes("human-answer"))?.tags).toEqual(expect.arrayContaining([`reply-to:${followUp.qitemId}`]));
      expect(toSeat().find((q) => q.tags?.includes("human-answer"))?.tags).not.toContain(`reply-to:${decisionId}`);
      expect(repo.getById(decisionId)?.state).toBe("pending");
    });

    it("refuses a thread-reply decision without buttons of its own", async () => {
      await expect(repo.create({ ...request, humanIntent: "decision", replyTo: decisionId })).rejects.toMatchObject({ code: "reply_to_requires_update" });
    });

    it("--reply-to a human-started message answers in its thread, and the thread routes back to the seat", async () => {
      socket.onmessage?.({ data: JSON.stringify({ envelope_id: "e-top", type: "events_api", payload: { event: { type: "message", user: "UFOUNDER", text: "Any open items?", ts: "2500.1", channel: "C-TEST" } } }) });
      await vi.waitFor(() => expect(finals("e-top")).toHaveLength(1));
      const inbound = repo.list({ limit: 100 }).find((q) => q.body.includes("Any open items?"))!;
      expect(eyes.has("2500.1")).toBe(true);
      const answer = await repo.create({ ...request, humanIntent: "update", summary: "Two open items", body: "1. Review 2. Merge", replyTo: inbound.qitemId });
      await deliver(answer.qitemId);
      expect(posts.at(-1)?.thread_ts).toBe("2500.1");
      expect(repo.getById(answer.qitemId)?.replyToFallback).toBeNull();
      await vi.waitFor(() => expect(eyes.has("2500.1")).toBe(false));
      await sayIn("2500.1", "And the third one?", "2501.1");
      const followUp = repo.list({ limit: 100 }).find((q) => q.body.includes("And the third one?"));
      expect(followUp?.destinationSession).toBe("author@rig");
      expect(followUp?.tags).toContain(`reply-to:${inbound.qitemId}`);
    });

    it("--reply-to a human's reply inside a thread answers in that thread", async () => {
      socket.onmessage?.({ data: JSON.stringify({ envelope_id: "e-top4", type: "events_api", payload: { event: { type: "message", user: "UFOUNDER", text: "Set up Lee", ts: "2800.1", channel: "C-TEST" } } }) });
      await vi.waitFor(() => expect(finals("e-top4")).toHaveLength(1));
      const inbound = repo.list({ limit: 100 }).find((q) => q.body.includes("Set up Lee"))!;
      const first = await repo.create({ ...request, humanIntent: "update", summary: "Plan", body: "Three steps.", replyTo: inbound.qitemId });
      await deliver(first.qitemId);
      await sayIn("2800.1", "What about his accounts?", "2801.1");
      const reply = repo.list({ limit: 100 }).find((q) => q.body.includes("What about his accounts?"))!;
      const answer = await repo.create({ ...request, humanIntent: "update", summary: "Accounts", body: "Own Codex and Claude.", replyTo: reply.qitemId });
      await deliver(answer.qitemId);
      expect(posts.at(-1)?.thread_ts).toBe("2800.1");
      expect(repo.getById(answer.qitemId)?.replyToFallback).toBeNull();
    });

    it("a human-started thread is routing-only: answer: and cancel there resolve or close nothing", async () => {
      socket.onmessage?.({ data: JSON.stringify({ envelope_id: "e-top2", type: "events_api", payload: { event: { type: "message", user: "UFOUNDER", text: "Status please", ts: "2600.1", channel: "C-TEST" } } }) });
      await vi.waitFor(() => expect(finals("e-top2")).toHaveLength(1));
      const inbound = repo.list({ limit: 100 }).find((q) => q.body.includes("Status please"))!;
      const answer = await repo.create({ ...request, humanIntent: "update", summary: "All green", body: "Nothing open.", replyTo: inbound.qitemId });
      await deliver(answer.qitemId);
      await sayIn("2600.1", "answer: thanks", "2601.1");
      await sayIn("2600.1", "cancel", "2602.1");
      expect(decisions).toEqual([]);
      expect(new ThreadSeatMap(db).resolveByThread("2600.1")?.state).toBe("open");
      expect(repo.transitionLog.listForQitem(inbound.qitemId).some((t) => t.transitionNote?.startsWith("request-closed"))).toBe(false);
      expect(repo.transitionLog.listForQitem(inbound.qitemId).some((t) => t.transitionNote?.startsWith("slack-posted thread_ts=2600.1"))).toBe(true);
    });

    it("a Confirm button on a decision posted into a human-started thread resolves that decision", async () => {
      socket.onmessage?.({ data: JSON.stringify({ envelope_id: "e-top3", type: "events_api", payload: { event: { type: "message", user: "UFOUNDER", text: "Plan the PSA rig", ts: "2700.1", channel: "C-TEST" } } }) });
      await vi.waitFor(() => expect(finals("e-top3")).toHaveLength(1));
      const inbound = repo.list({ limit: 100 }).find((q) => q.body.includes("Plan the PSA rig"))!;
      const plan = await repo.create({ ...request, humanIntent: "decision", summary: "PSA rig plan", body: "Dedicated rig, Lee as requester.", replyTo: inbound.qitemId, humanConfirm: "Build the PSA rig" });
      await deliver(plan.qitemId);
      expect(posts.at(-1)?.thread_ts).toBe("2700.1");
      const ts = `${posts.length}.1`;
      expect(await click(`or-confirm:${plan.qitemId}`, "or-confirm", ts, "UFOUNDER", "3900.1", "2700.1")).toMatchObject({ status: "accepted" });
      expect(repo.getById(plan.qitemId)?.state).toBe("done");
      expect(decisions).toEqual(["Build the PSA rig"]);
      expect(updates.map((u) => u.ts)).toEqual([ts]);
    });

    it("an empty `answer:` is conversation, not a resolution", async () => {
      await say("answer:   ", "2005.1");
      expect(repo.getById(decisionId)?.state).toBe("pending");
      expect(toSeat()[0]?.tags).toContain("conversation");
    });
  });

  describe("configured receipt emoji", () => {
    beforeEach(() => start(true, { received: "openrig-received", picked: "openrig-picked", working: "openrig-working", done: "openrig-done" }));

    it("uses the configured names", async () => {
      await say("Hello", "2800.1");
      expect([...marksOn("2800.1")]).toEqual(["openrig-received"]);
      const row = toSeat().find((q) => q.body.includes("Hello"))!;
      repo.update({ qitemId: row.qitemId, actorSession: "author@rig", state: "done", closureReason: "no-follow-on", transitionNote: "ok" });
      await vi.waitFor(() => expect([...marksOn("2800.1")]).toEqual(["openrig-done"]));
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
