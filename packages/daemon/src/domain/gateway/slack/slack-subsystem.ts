// S10 — the SLACK gateway wiring: composes the in-process wire (shipped dispatcher + durable
// buffer), the chat.postMessage delivery path, the outbound queue-poll driver, and the Socket
// Mode inbound service into ONE GatewayWire the subsystem activates at daemon boot.
//
// Configuration honesty: an unconfigured/disabled connector yields an INERT wire — delivery
// refuses with a named class, no ops advertised, no drivers started — never a throw (boot
// proceeds; `rig slack status` names what is missing) and never a silent pretend-active
// delivery path.
//
// Durable-state continuity through the cutover: the SAME slice-11 state files carry over
// (slack-outbound-seen.jsonl, slack-inbound-seen.jsonl, slack-inbound-deadletter.jsonl), so
// the relay's history IS the subsystem's history — enabling the subsystem replays nothing the
// relay already delivered (the enable-time backlog rule survives the cutover by construction).

import { unansweredQuestions } from "../../human-questions.js";
import { ChannelRecovery } from "./channel-recovery.js";
import { channelStateDigest } from "../channel-operations.js";
import path from "node:path";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { buildInProcessWire, type GatewayWire, type SubsystemDeliverFn } from "../gateway-subsystem.js";
import { DispatchBuffer } from "../dispatch-buffer.js";
import { addReaction, callWebApi, countChannelHumans, downloadPrivateFile, isSlackHost, postChatMessage, removeReaction, updateChatMessage } from "./slack-api.js";
import { channelsOf, loadConfig } from "./config.js";
import { resolveSecret } from "./secrets.js";
import { SeenStore, DeadLetterStore, InboundReceiptStore } from "./state-store.js";
import { makeQueuePorts } from "./queue-access.js";
import { SlackOutboundDriver, OUTBOUND_OP, type OutboundPostPayload } from "./outbound-driver.js";
import { abortableSleep, evidenceAttachment, subsystemSlackDeliver } from "./slack-delivery.js";
import { InboundRouter, inboundQitemIdFor, NOT_ADDRESSED_TAG, SLACK_MESSAGE_TAG, type ReactionTarget, type SlackEvent, type SlackBlockActions, type InboundFilePort, type InboundFileResult, type StoredInboundFile, type FailedInboundFile } from "./inbound.js";
import { makeInboundSenderResolver, type RegistrySurface } from "./inbound-admission.js";
import { ThreadSeatMap, formatPostedStamp } from "./thread-seat-map.js";
import { attributionFromSession, buildCompactClosedMessage, buildOutboundMessage, DEFAULT_CONFIRM_DECISION } from "./message.js";
import { makeThreadRouteResolver } from "./thread-routing.js";
import { closeRequest, isRequestToHuman, currentGateResolved, entityOf, gateOpenedAt, githubLinkState, isRequestHuman, sweepRequests, type LinkState, type RequestLifecycleDeps, type RequestLink } from "./request-lifecycle.js";
import { resolveOutboundChannel, unsupportedChannelMapFields } from "./channel-map.js";
import { startSocketInbound, type SocketInboundHandle, type WsLike } from "./socket-inbound.js";
import { loadHumanRegistry, resolveRegisteredHumanAddress, resolveSlackHandle } from "../human-registry.js";
import { hasLiveHumanGate, isBlockerLive, type QueueItem, type QueueRepository } from "../../queue-repository.js";
import { formatReplyToChoice, REPLY_TO_CHOICE_ACTOR, type ReplyToChoice } from "../../reply-to-choice.js";
import { isHumanSeatSessionRef, parseSessionName } from "../../session-name.js";
import type { FetchImpl } from "./slack-api.js";
import { ownerNotificationLevelAtLeast } from "../../queue-transition-log.js";
// OPR.0.5.6.1 — the delivery rules engine: ONE decision per message replaces
// the two dial-reads (the S14 default-decision stub). The legacy dial path
// survives ONLY as the stated degrade when the destination is not a
// registered human (no prefs -> no engine input).
import {
  decideDelivery,
  resolveAvailability,
  isEscalationClass,
  formatDeliveryTermination,
  DELIVERY_TERMINATION_PREFIX,
  type DeliveryDecision,
} from "../delivery-rules-engine.js";
import { armDeliveryDeferral } from "../../policies/delivery-deferral.js";
import { WatchdogJobsRepository } from "../../watchdog-jobs-repository.js";

const SECRET_BOT = "SLACK_BOT_TOKEN";
const SECRET_APP = "SLACK_APP_TOKEN";

export interface SlackWireOpts {
  home: string;
  queueRepo: QueueRepository;
  log?: (msg: string) => void;
  /** Injectable seams (tests): fetch, websocket factory, sweep cadence, registry surface. */
  fetchImpl?: FetchImpl;
  wsFactory?: (url: string) => WsLike;
  outboundIntervalMs?: number;
  /** Sweep outbound at once on a queue change that produced a human notification (default true); false = poll only. */
  outboundKick?: boolean;
  inboundRetryIntervalMs?: number;
  inboundMaxConnects?: number;
  registry?: RegistrySurface;
  /** Phase 1 request sweep cadence and PR/issue state source (tests inject both). */
  requestSweepIntervalMs?: number;
  /** How often top-level history and the recently active threads are read for missed messages. */
  fastRecoveryIntervalMs?: number;
  linkState?: (link: RequestLink) => Promise<LinkState>;
  resolveHumanReply?: (input: { qitemId: string; actorSession: string; decision: string }) => Promise<"resolved" | "already-resolved" | "not-applicable">;
}

interface HumanReplyActionPort {
  act(input: { verb: "resolve"; qitemId: string; actorSession: string; decision: string; parkedOnActor?: boolean }): Promise<unknown>;
}

const isResolvedNotice = (q: { ownerNotificationKind?: string | null }) => q.ownerNotificationKind === "human-decision-resolved";

/** Compose an inbound reply with Mission Control's existing human-park resolver.
 * A replay after the durable resolve but before inbound seen-mark is absorbed by
 * the typed transition, so the waiting owner is resumed exactly once. */
export function makeHumanReplyResolver(
  queueRepo: QueueRepository,
  contract: HumanReplyActionPort | undefined,
): NonNullable<SlackWireOpts["resolveHumanReply"]> {
  return async (input) => {
    if (queueRepo.getById(input.qitemId)?.humanIntent === "update") return "not-applicable";
    if (!contract) return "not-applicable";
    try {
      // Only reached behind the gateway's asked-human check, so a park on that human's own address counts.
      await contract.act({ verb: "resolve", ...input, parkedOnActor: true });
      return "resolved";
    } catch (error) {
      if ((error as { code?: string }).code !== "qitem_not_leg1_parked") throw error;
      const alreadyResolved = queueRepo.transitionLog.listForQitem(input.qitemId)
        .some((transition) => transition.ownerNotificationKind === "human-decision-resolved");
      if (alreadyResolved) return "already-resolved";

      // A direct human request is the inverse of the older park shape: the
      // human owns the pending row and the originating agent receives the
      // correlated inbound row. Closing the request here records the durable
      // disposition; the inbound create is already the one wake back to the
      // source, so a second nudge here would duplicate attention.
      return queueRepo.resolveDirectHumanReply(input) ? "resolved" : "not-applicable";
    }
  };
}

/**
 * OPR.0.5.6.2 — the inbound file port: Slack `url_private` → authenticated
 * download → workspace-local media file → LOCAL path for the reply row.
 * Slack owns nothing (design §2): the stored file is OUR copy of the human's
 * contribution to OUR work record; no Slack URL and no token ever leaves this
 * function toward a row. Failure is per-file and NAMED — a failed transfer
 * yields `{ name, error }`, never an exception that could cost the message.
 *
 * Safe-path discipline: filenames sanitize to a bounded [A-Za-z0-9._-] basename
 * prefixed with the event ts, a channel/message/file identity digest, and index,
 * so messages sharing a timestamp across channels cannot overwrite each other. The resolved path
 * is verified to stay inside `mediaDir` before any write.
 */
/** R1 F1 — the anchored Slack-host verdict now lives in slack-api.ts and is
 *  enforced inside `downloadPrivateFile`; the transfer-path check below keeps
 *  the per-file "missing or non-Slack url_private" failure honest before the
 *  download is even attempted. */
export function makeInboundFilePort(opts: {
  token: string;
  mediaDir: string;
  fetchImpl?: FetchImpl;
  mkdirp?: (dir: string) => void;
  writeFile?: (p: string, bytes: Uint8Array) => void;
  log?: (msg: string) => void;
  maxBytes?: number;
}): InboundFilePort {
  const log = opts.log ?? (() => {});
  const mkdirp = opts.mkdirp ?? ((dir: string) => { fs.mkdirSync(dir, { recursive: true }); });
  const writeFile = opts.writeFile ?? ((p: string, bytes: Uint8Array) => { fs.writeFileSync(p, bytes); });
  return {
    async transfer(files: unknown[], eventTs: string, eventChannel?: string): Promise<InboundFileResult> {
      const stored: StoredInboundFile[] = [];
      const failed: FailedInboundFile[] = [];
      mkdirp(opts.mediaDir);
      for (let i = 0; i < files.length; i++) {
        const meta = (files[i] ?? {}) as { id?: string; name?: string; mimetype?: string; url_private?: string };
        const name = String(meta.name ?? meta.id ?? `file-${i + 1}`);
        const url = meta.url_private;
        // R1 F1: ANCHORED host check — URL-parsed hostname, exact `slack.com`
        // or a dot-suffix subdomain. A substring/regex match admits lookalike
        // domains (evilslack.com) and would send the Bearer token to them.
        if (!url || !isSlackHost(url)) {
          failed.push({ name, error: "missing or non-Slack url_private" });
          continue;
        }
        const dl = await downloadPrivateFile(url, opts.token, opts.fetchImpl ?? fetch, 30_000, opts.maxBytes);
        if (!dl.ok) {
          log(`inbound file transfer FAILED name=${name} ts=${eventTs}: ${dl.error}`);
          failed.push({ name, error: dl.error });
          continue;
        }
        const safeBase = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || `file-${i + 1}`;
        const identity = createHash("sha256").update(JSON.stringify([eventChannel ?? "-", eventTs, meta.id ?? null])).digest("hex").slice(0, 20);
        const localPath = path.join(opts.mediaDir, `${eventTs.replace(/[^0-9.]/g, "")}-${identity}-${i + 1}-${safeBase}`);
        if (!path.resolve(localPath).startsWith(path.resolve(opts.mediaDir) + path.sep)) {
          failed.push({ name, error: "unsafe path refused" });
          continue;
        }
        try {
          writeFile(localPath, dl.bytes);
        } catch (e) {
          failed.push({ name, error: `local write failed: ${(e as Error).message}` });
          continue;
        }
        stored.push({ name, localPath, mimetype: meta.mimetype, bytes: dl.bytes.byteLength });
      }
      return { stored, failed };
    },
  };
}

const CONFIRM_WON_NOTE = "slack-confirm-won";

/** Phase 1 — classify the message a human added ✅ to, using only our own records: the
 *  decision's root (a plain decision only), a Confirm offer we posted, or the human's own
 *  reply in the decision's thread. The target keeps the reacted message's own root, so the
 *  router's current-root check applies, and anything from an earlier gate answers nothing.
 *  Only the request's asked human may answer. */
export function makeReactionTarget(queueRepo: QueueRepository, threadMap: ThreadSeatMap, explicitAnswersOnly = false, askedHuman?: (qitemId: string) => string | null): (input: { channel: string; messageTs: string; actorSession: string }) => ReactionTarget | null {
  const askedIn = (threadTs: string, actorSession: string) => {
    const root = threadMap.resolveByThread(threadTs);
    return root && isRequestHuman(root, actorSession) ? root : null;
  };
  return ({ channel, messageTs, actorSession }) => {
    const root = threadMap.resolveByThread(messageTs);
    if (root) {
      const decision = queueRepo.getById(root.conversationId);
      if (!decision || decision.humanIntent === "update" || !isRequestHuman(root, actorSession)) return null;
      // With explicit answers every decision carries buttons, and ✅ on it does nothing.
      if (explicitAnswersOnly || decision.humanQuestions?.length || decision.humanConfirm) return null;
      return { kind: "answer", decisionQitemId: decision.qitemId, threadTs: messageTs, text: "acknowledged and agreed" };
    }
    const offerId = queueRepo.postedQitemForMessage(messageTs);
    const offer = offerId ? queueRepo.getById(offerId) : null;
    if (offer?.humanConfirm && offer.replyTo) {
      const threadTs = queueRepo.postedThreadForMessage(messageTs);
      const asked = askedHuman ? askedHuman(offer.replyTo) === actorSession : !!(threadTs && askedIn(threadTs, actorSession));
      return threadTs && asked ? { kind: "confirm", offerQitemId: offer.qitemId, threadTs } : null;
    }
    const reply = queueRepo.getById(inboundQitemIdFor(channel, messageTs));
    const conversation = reply?.tags?.find((t) => t.startsWith("reply-to:"))?.slice("reply-to:".length);
    const threadTs = reply?.tags?.find((t) => t.startsWith("thread-ts:"))?.slice("thread-ts:".length);
    if (!reply || !conversation || !threadTs || reply.sourceSession !== actorSession || !askedIn(threadTs, actorSession)) return null;
    if (reply.tags?.includes(NOT_ADDRESSED_TAG)) return null;
    if (reply.tsCreated < gateOpenedAt(queueRepo, conversation)) return null;
    const text = reply.body.split("\n\n---\nSource: ")[0]?.trim();
    return text ? { kind: "answer", decisionQitemId: conversation, threadTs, text } : null;
  };
}

/** The instant this home first ran the request lifecycle, persisted so older threads are never
 *  reminded about or closed after an upgrade. */
function lifecycleFloorMs(home: string): number {
  const file = path.join(stateDir(home), "slack-request-lifecycle-floor");
  try {
    return Number(fs.readFileSync(file, "utf8").trim());
  } catch {
    const now = Date.now();
    fs.mkdirSync(stateDir(home), { recursive: true });
    fs.writeFileSync(file, `${now}\n`);
    return now;
  }
}

function stateDir(home: string): string {
  return path.join(home, "state");
}

/** The status fields for the retry pass's durable custody. Counts RECORDS across the
 *  inbound-event and click dead-letter files — the event file also carries reactions,
 *  and a message that left more than one record is counted once per record, so the
 *  retry pass owns exactly these records. When any file cannot be read the count is
 *  `null`, not 0: a number (or a zero) beside an unknown state still reads as "nothing
 *  stuck" to a consumer that only looks at the count, so the state and the reason tell
 *  the truth and the number says it does not know. Absent when inbound is not configured
 *  (no stores), keeping an inert connector silent. */
function deadLetterBacklogFields(
  dead: DeadLetterStore<SlackEvent> | undefined,
  deadActions: DeadLetterStore<SlackBlockActions> | undefined,
): Record<string, unknown> {
  if (!dead || !deadActions) return {};
  let records = 0;
  let reason: string | undefined;
  for (const store of [dead, deadActions] as DeadLetterStore<unknown>[]) {
    const result = store.readResult();
    if (result.ok) records += result.entries.length;
    else reason = reason ?? result.reason;
  }
  if (reason !== undefined) return { deadLetterBacklog: null, deadLetterBacklogState: "unknown", deadLetterBacklogReason: reason };
  return { deadLetterBacklog: records, deadLetterBacklogState: "ok" };
}

/** Build the production Slack gateway wire from config + secrets. Never throws on a missing
 *  configuration — that is an honest inert wire, not a boot failure. */
/** A message's Slack link (chat.getPermalink), or null when Slack cannot give one. */
export async function slackPermalink(home: string, channel: string, messageTs: string, fetchImpl?: FetchImpl): Promise<string | null> {
  const bot = resolveSecret(SECRET_BOT, { envFile: loadConfig(home).secretsEnvFile ?? undefined });
  if (!bot) return null;
  const r = await callWebApi("chat.getPermalink", bot, { channel, message_ts: messageTs }, fetchImpl, undefined, "get-query");
  return r.ok && typeof r.json.permalink === "string" ? r.json.permalink : null;
}

export function buildSlackGatewayWire(opts: SlackWireOpts): GatewayWire {
  const log = opts.log ?? (() => {});
  const cfg = loadConfig(opts.home);
  const ignored = unsupportedChannelMapFields(cfg);
  if (ignored.length) log(`slack channel map: IGNORING unsupported field(s) ${ignored.join(", ")} (written by a newer OpenRig?); \`rig slack status\` names them`);
  const envFile = cfg.secretsEnvFile ?? undefined;
  const bot = resolveSecret(SECRET_BOT, { envFile });
  const app = resolveSecret(SECRET_APP, { envFile });

  const outboundReady = cfg.enabled && bot !== null && cfg.channel !== null;
  const inboundReady = cfg.enabled && app !== null;

  if (!outboundReady && !inboundReady) {
    const missing = !cfg.enabled ? "connector disabled (rig slack enable)" : !bot ? "SLACK_BOT_TOKEN unresolved" : "channel unconfigured";
    log(`slack delivery not configured (${missing}) — wire is inert; dispatches would be refused honestly`);
    const inert = buildInProcessWire({
      home: opts.home,
      ops: [],
      deliver: async () => ({ ok: false, class: "slack-not-configured", detail: missing }),
      log,
    });
    return { ...inert, status: () => ({ platform: "slack", configurationDigest: channelStateDigest(cfg), outboundReady: false, inboundReady: false, recovery: { state: "unavailable", reason: "inbound-not-configured" }, inbound: { state: "not-configured" } }) };
  }

  const registrySurface: RegistrySurface = opts.registry ?? { loadHumanRegistry, resolveSlackHandle };
  const ports = makeQueuePorts(opts.queueRepo, {
    loadHumanRegistry: () => registrySurface.loadHumanRegistry(opts.home),
  });
  // OPR.0.5.6.1 — the one engine consult (AM-F5: the gateway consults the
  // engine BEFORE dispatch). Null = destination is not a registered human;
  // the caller keeps the pre-engine dial behavior (stated degrade).
  const decideForPayload = (p: OutboundPostPayload): DeliveryDecision | null => {
    const local = (p.destinationSession ?? "").split("@")[0] ?? "";
    if (!local) return null;
    const reg = registrySurface.loadHumanRegistry(opts.home);
    if (!reg.ok) return null;
    const human = reg.entities.find((e) => e.entityId === local);
    if (!human) return null;
    return decideDelivery({
      level: p.ownerNotificationLevel ?? null,
      escalation: p.humanIntent !== "update" && isEscalationClass(p.tags),
      human: {
        entityId: human.entityId,
        deliveryClass: human.prefs.deliveryClass,
        availability: resolveAvailability(human.prefs),
      },
      dials: {
        minimumLevelThatPosts: cfg.minimumLevelThatPosts,
        minimumLevelThatInterrupts: cfg.minimumLevelThatInterrupts,
      },
    });
  };
  const outboundSeen = new SeenStore(path.join(stateDir(opts.home), "slack-outbound-seen.jsonl"));
  const delivered = new SeenStore(path.join(stateDir(opts.home), "slack-delivered-decisions.jsonl"));
  const attempted = new SeenStore(path.join(stateDir(opts.home), "slack-attempted-decisions.jsonl"));

  // S10 thread routing — the map shares the daemon DB (queue rows carry the rebuild stamps).
  const threadMap = new ThreadSeatMap(opts.queueRepo.db);
  const channels = channelsOf(cfg);
  // The addressed-only rule: a channel with more than one human answers only messages that
  // @mention the app. A message waits for its channel's first count; later counts refresh every
  // 10 minutes in the background, and at once on member_joined/left_channel. When Slack cannot
  // give a count (cached as unknown for 10 minutes) every message counts as addressed.
  const HUMAN_COUNT_TTL_MS = 10 * 60_000;
  const humanCounts = new Map<string, { count: number | null; at: number }>();
  const counting = new Map<string, Promise<number | null>>();
  const userIsHuman = new Map<string, boolean>();
  const recount = (channel: string): Promise<number | null> => {
    const running = counting.get(channel);
    if (running) return running;
    const next = (bot ? countChannelHumans(bot, channel, userIsHuman, opts.fetchImpl) : Promise.resolve(null))
      .catch(() => null)
      .then((count) => {
        humanCounts.set(channel, { count, at: Date.now() });
        counting.delete(channel);
        if (count === null) log(`human count unavailable for ${channel}; every message counts as addressed for 10 minutes`);
        return count;
      });
    counting.set(channel, next);
    return next;
  };
  const humansIn = async (channel: string): Promise<number | null> => {
    const known = humanCounts.get(channel);
    if (!known) return recount(channel);
    if (Date.now() - known.at > HUMAN_COUNT_TTL_MS) void recount(channel);
    return known.count;
  };
  let appUser: Promise<string | undefined> | undefined;
  const appUserId = (): Promise<string | undefined> => appUser ??= bot
    ? callWebApi("auth.test", bot, {}, opts.fetchImpl).then((r) => (typeof r.json.user_id === "string" ? r.json.user_id : undefined)).catch(() => undefined)
    : Promise.resolve(undefined);
  const askedHumanOf = (qitemId: string): string | null => {
    const item = opts.queueRepo.getById(qitemId);
    const registry = registrySurface.loadHumanRegistry(opts.home);
    return item && registry.ok ? resolveRegisteredHumanAddress(item.blockedOn || item.destinationSession, registry.entities) : null;
  };
  const resolveSender = makeInboundSenderResolver(registrySurface, opts.home);
  const isConfiguredChannel = (channel: string) => channels.some((c) => c.id === channel) || (cfg.channelMap ?? []).some((e) => e.channel === channel);
  // A new root goes to the configured channel its row names, else to the channel whose seat is
  // posting; replies stay in their thread's channel.
  const SLACK_CHANNEL_TAG = "slack-channel:";
  const taggedChannel = (p: OutboundPostPayload): string | undefined => {
    const id = p.tags?.find((t) => t.startsWith(SLACK_CHANNEL_TAG))?.slice(SLACK_CHANNEL_TAG.length);
    if (!id || isConfiguredChannel(id)) return id || undefined;
    log(`qitem ${p.qitemId} names unconfigured channel ${id}; posting in the seat's channel`);
    return undefined;
  };
  const channelForPost = (p: OutboundPostPayload, threadTs: string | undefined): string =>
    (threadTs ? threadMap.resolveByThread(threadTs)?.channel : undefined)
      ?? taggedChannel(p)
      ?? channels.find((c) => c.inboundDestination === p.sourceSession)?.id ?? cfg.channel!;

  // OPR.0.5.6.14 — a failed post writes the transport-failed ledger transition so the
  // undelivered surface (and --verify) can name the gateway's error instead of guessing
  // from nudge telemetry. One receipt per episode.
  // #897 — an ask that can't be rendered fails the same way on every retry, so the person never
  // sees it. Tell the seat that asked, once: the notice's id derives from the ask's, so a replay
  // returns the same row instead of a second one.
  // A retry that can't post the rest of an ask some of which may already be in Slack says so.
  const notifySourceUndeliverable = (p: OutboundPostPayload, detail: string, partlyPosted = false): void => {
    const seat = p.sourceSession;
    if (!p.qitemId || !seat) return;
    const human = p.destinationSession ?? "the person";
    opts.queueRepo.create({
      qitemId: `${p.qitemId}-undeliverable`,
      sourceSession: seat,
      destinationSession: seat,
      summary: `Not delivered to ${human}: ${p.summary ?? p.qitemId}`,
      body: [
        partlyPosted
          ? `Part of your ask ${p.qitemId} may already be in Slack, but OpenRig could not post the rest, so ${human} has not seen all of it.`
          : `OpenRig could not post your ask ${p.qitemId} to Slack, so ${human} has not seen it.`,
        "",
        `Reason: ${detail}`,
        "",
        partlyPosted
          ? "Check the thread in Slack and send what's missing as a new ask. The original row stays open until you close it."
          : "Shorten it and send it as a new ask. The original row stays open until you close it.",
      ].join("\n"),
      evidenceRef: `rig queue show ${p.qitemId}`,
      tags: ["slack-undeliverable"],
    }).catch((e) => log(`undeliverable notice FAILED for ${p.qitemId}: ${(e as Error).message}`));
  };

  const recordTransportFailed = (p: OutboundPostPayload, failureClass: string, detail: string, partlyPosted?: boolean): void => {
    if (!p.qitemId) return;
    if (failureClass === "human-message-unrenderable") notifySourceUndeliverable(p, detail, partlyPosted);
    const key = p.notificationKey ?? p.qitemId;
    const alreadyRecorded = opts.queueRepo.transitionLog.listForQitem(p.qitemId).some((transition) =>
      transition.transitionNote?.startsWith("slack-owner-notification-transport-failed ")
        && transition.transitionNote.split(/\s+/).includes(`notification_key=${key}`));
    if (alreadyRecorded) return;
    opts.queueRepo.update({
      qitemId: p.qitemId,
      actorSession: "daemon@kernel",
      transitionNote: [
        "slack-owner-notification-transport-failed",
        `notification_key=${key}`,
        `class=${failureClass}`,
        `error=${detail}`,
      ].join(" "),
    });
  };

  // #822: a person's inbound reply records the item it answers as replyTo. If its seat parks
  // that row on the person, the park is a decision and opens its own root. A decision a seat
  // itself created with --reply-to (fork: an action button in an earlier request's thread) and
  // every update steer where the post goes.
  // A pure FYI post (an update with no buttons, not a reply in a thread, not pinned by tag) goes to
  // the notifications channel when one is set; anything the human answers stays on the default.
  // A seat with its own channel (channel map, extra channel) keeps its FYI there.
  const notificationsChannelFor = (p: OutboundPostPayload, replyTo: string | null, threadTs: string | undefined, otherwise: string): string | null =>
    cfg.notificationsChannel && otherwise === cfg.channel && p.humanIntent === "update" && !p.humanConfirm && !p.humanQuestions?.length && !replyTo && !threadTs && !taggedChannel(p)
      ? cfg.notificationsChannel : null;

  const threadReplyTo = (p: OutboundPostPayload): string | null => {
    if (!p.replyTo) return null;
    if (p.humanIntent === "update") return p.replyTo;
    const row = opts.queueRepo.getById(p.qitemId);
    return row && !isHumanSeatSessionRef(row.sourceSession) ? p.replyTo : null;
  };

  // #96 — where a replyTo update posts. Walks back through earlier threaded updates (which
  // open no root of their own) to the item that owns the root.
  const MAX_REPLY_TO_CHAIN = 32;
  // The human wrote there, so the bot can answer there even when the channel is not configured.
  // A tag alone is not proof (a seat can set tags); the gateway's own inbound record is.
  const inboundReceived = new SeenStore(path.join(stateDir(opts.home), "slack-inbound-seen.jsonl"));
  const isReceivedHere = (message: { channel: string; ts: string } | null): boolean =>
    !!message && inboundReceived.load().has(`${message.channel}:${message.ts}`);
  const isHumanStartedRoot = (root: { threadTs: string; channel: string; conversationId: string }) => {
    const message = receivedMessage(opts.queueRepo.getById(root.conversationId)?.tags);
    return message?.channel === root.channel && message.ts === root.threadTs && isReceivedHere(message);
  };
  // The human wrote in this thread and their message reached this seat; the thread belongs to no
  // other agent (it is the human's own alert, or the daemon's), so the answer goes where they asked.
  const humanWroteHere = (item: QueueItem, root: { threadTs: string; seat: string }, seat: string) =>
    item.destinationSession === seat && isReceivedHere(receivedMessage(item.tags))
    && item.tags?.includes(`thread-ts:${root.threadTs}`) === true
    && (parseSessionName(root.seat).kind === "external" || root.seat === "daemon@kernel");
  const deriveReplyToChoice = (p: OutboundPostPayload, channel: string): ReplyToChoice => {
    let item = p.replyTo ? opts.queueRepo.getById(p.replyTo) : null;
    for (let depth = 0; item && depth < MAX_REPLY_TO_CHAIN; depth++) {
      if (!cfg.explicitAnswersOnly && hasLiveHumanGate(item)) return { kind: "fallback", reason: "reference-has-live-gate", qitemId: item.qitemId };
      // An inbound reply answers in the thread the human wrote in, even a superseded root.
      const inThread = item.tags?.find((t) => t.startsWith("thread-ts:"))?.slice("thread-ts:".length);
      const root = (inThread ? threadMap.resolveByThread(inThread) : null) ?? threadMap.resolveByConversation(item.qitemId);
      if (root) {
        if (root.state === "closed") return { kind: "fallback", reason: "root-closed", threadTs: root.threadTs };
        // #192: with a channel map a root in another channel than this attempt's cannot carry the post.
        if (cfg.channelMap?.length && root.channel !== channel) return { kind: "fallback", reason: "root-other-channel", threadTs: root.threadTs };
        if (!isConfiguredChannel(root.channel) && !isHumanStartedRoot(root)) return { kind: "fallback", reason: "root-other-channel", threadTs: root.threadTs };
        if (root.seat !== (p.sourceSession ?? "") && !humanWroteHere(item, root, p.sourceSession ?? "")) return { kind: "fallback", reason: "root-other-seat", threadTs: root.threadTs };
        return { kind: "thread", threadTs: root.threadTs };
      }
      // A human-started message has no root of ours: answer in that message's own thread, in the
      // channel the human wrote in, and register it as the thread's root, so the human's later
      // replies route back to this seat.
      const humanMessage = receivedMessage(item.tags);
      if (humanMessage && !item.tags?.some((t) => t.startsWith("reply-to:"))) {
        if (!isConfiguredChannel(humanMessage.channel) && !isReceivedHere(humanMessage)) return { kind: "fallback", reason: "root-other-channel", threadTs: humanMessage.ts };
        if (cfg.channelMap?.length && humanMessage.channel !== channel) return { kind: "fallback", reason: "root-other-channel", threadTs: humanMessage.ts };
        const root = { threadTs: humanMessage.ts, channel: humanMessage.channel, human: item.sourceSession, seat: p.sourceSession ?? "", conversationId: item.qitemId };
        threadMap.open(root);
        opts.queueRepo.update({ qitemId: item.qitemId, actorSession: "daemon@kernel", transitionNote: formatPostedStamp({ ...root, messageTs: humanMessage.ts }) });
        return { kind: "thread", threadTs: humanMessage.ts };
      }
      // An inbound reply inside a thread names its conversation by tag, not by the replyTo field.
      const next = item.replyTo ?? item.tags?.find((t) => t.startsWith("reply-to:"))?.slice("reply-to:".length);
      if (!next) return { kind: "fallback", reason: "root-missing", qitemId: item.qitemId };
      item = opts.queueRepo.getById(next);
    }
    return item
      ? { kind: "fallback", reason: "chain-too-long", qitemId: item.qitemId }
      : { kind: "fallback", reason: "root-missing", qitemId: p.replyTo ?? "" };
  };
  // Decided ONCE and recorded on the row before the first post. Every later attempt reuses
  // the record, so a reconcile scan searches where the message actually went and --verify
  // reports what happened. If the record cannot be written, nothing posts: the delivery is
  // retained for replay and a transport-failed receipt names why, so --verify does not just
  // time out.
  // #192: with a channel map the record also names the channel the choice was made for, and every
  // retry posts there (resolveChannel below), so a remap never pairs a new channel with an old root.
  const chooseReplyToThread = (p: OutboundPostPayload, channel: string): ReplyToChoice => {
    const recorded = opts.queueRepo.replyToChoiceFor(p.qitemId);
    if (recorded) return recorded;
    const derived = deriveReplyToChoice(p, channel);
    const choice: ReplyToChoice = cfg.channelMap?.length ? { ...derived, channel } : derived;
    try {
      opts.queueRepo.update({ qitemId: p.qitemId, actorSession: REPLY_TO_CHOICE_ACTOR, transitionNote: formatReplyToChoice(choice) });
    } catch (e) {
      const detail = `reply-to thread choice could not be recorded: ${(e as Error).message}`;
      try { recordTransportFailed(p, "reply-to-choice-unrecorded", detail); }
      catch (receiptError) { log(`transport-failed receipt write FAILED for ${p.qitemId}: ${(receiptError as Error).message}`); }
      throw new Error(detail);
    }
    return choice;
  };

  // A replaced post keeps everything the original showed except its buttons.
  const repostInputs = (row: { sourceSession: string; evidenceRef?: string | null; summary: string | null }) => ({
    sourceLabel: cfg.sourceLabel,
    answerHint: cfg.explicitAnswersOnly,
    attribution: attributionFromSession(row.sourceSession),
    ...evidenceAttachment(undefined, row.evidenceRef, row.summary),
  });

  const lifecycle: RequestLifecycleDeps = {
    queueRepo: opts.queueRepo,
    threadMap,
    staleReminderDays: cfg.staleReminderDays,
    floorMs: lifecycleFloorMs(opts.home),
    linkState: opts.linkState ?? githubLinkState,
    postInThread: async (channel, threadTs, text) => {
      if (!bot) return false;
      const r = await postChatMessage(bot, { channel, thread_ts: threadTs, text }, opts.fetchImpl);
      if (!r.ok) log(`request lifecycle post failed thread=${threadTs}: ${r.error}`);
      return r.ok;
    },
    closeCard: async (qitemId, channel, line, compact) => {
      const item = opts.queueRepo.getById(qitemId);
      // The request's own card: the message its latest posted receipt names (a resolved notice is a
      // separate message, never the card).
      const transitions = opts.queueRepo.transitionLog.listForQitem(qitemId);
      const messageTs = [...transitions].reverse()
        .find((t) => t.actorSession === "daemon@kernel" && t.transitionNote?.startsWith("slack-owner-notification-posted ") && !/\skind=human-decision-resolved(\s|$)/.test(t.transitionNote))
        ?.transitionNote?.split(/\s+/).find((f) => f.startsWith("message_ts="))?.slice("message_ts=".length) ?? null;
      if (!item || !messageTs) return { ok: true, messageTs: null };
      if (!bot) return { ok: false, messageTs, error: "bot token unavailable" };
      const won = transitions.some((t) => t.transitionNote === CONFIRM_WON_NOTE && t.actorSession === "daemon@kernel");
      const message = compact ? buildCompactClosedMessage(line)
        : buildOutboundMessage(item, { ...repostInputs(item), closedNote: line, ...(won ? { confirmOutcome: "confirmed" as const } : {}) });
      const r = await updateChatMessage(bot, { channel, ts: messageTs, ...message }, opts.fetchImpl);
      return r.ok ? { ok: true, messageTs } : { ok: false, messageTs, error: r.error ?? "update failed" };
    },
    log,
  };

  // The gateway tags each inbound row with the message it came from (never parsed from the human's text).
  const receivedMessage = (tags: readonly string[] | null | undefined): { channel: string; ts: string } | null => {
    const ref = tags?.find((t) => t.startsWith(SLACK_MESSAGE_TAG))?.slice(SLACK_MESSAGE_TAG.length);
    const sep = ref?.lastIndexOf(":") ?? -1;
    return ref && sep > 0 ? { channel: ref.slice(0, sep), ts: ref.slice(sep + 1) } : null;
  };
  // A top-level message to a human is their to-do: it shows the done reaction once its row no
  // longer waits on them, and loses it when the row is reopened to them.
  const rootDone = new Map<string, boolean>(); // root threadTs -> whether it shows the done reaction
  const rootChains = new Map<string, Promise<void>>();
  const syncRootDone = (qitemId: string): Promise<void> => {
    const run = (rootChains.get(qitemId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const row = opts.queueRepo.getById(qitemId);
      if (!bot || !row) return;
      const done = !(["pending", "in-progress", "blocked"].includes(row.state) && askedHumanOf(qitemId) !== null);
      // The human's own message is a root too; it gets no done mark.
      const ownMessage = receivedMessage(row.tags);
      for (const root of threadMap.listRootsByConversation(qitemId)) {
        if (ownMessage?.channel === root.channel && ownMessage.ts === root.threadTs) continue;
        if ((rootDone.get(root.threadTs) ?? false) === done) continue;
        const input = { channel: root.channel, timestamp: root.threadTs, name: cfg.receipts.done };
        const r = done ? await addReaction(bot, input, opts.fetchImpl) : await removeReaction(bot, input, opts.fetchImpl);
        if (!r.ok) { log(`root ${done ? "done mark" : "done unmark"} failed ts=${root.threadTs}: ${r.error}`); continue; }
        rootDone.set(root.threadTs, done);
      }
    });
    rootChains.set(qitemId, run);
    void run.finally(() => { if (rootChains.get(qitemId) === run) rootChains.delete(qitemId); });
    return run;
  };
  // One run = one wire build. The abort controller lets stop() cancel anything this
  // run still has in flight — chiefly the inline rate-limit wait in postChatMessage,
  // whose stale retry must never post once a restart's replay owns the decision.
  const runCtl = new AbortController();

  // Late-bound so deliver can release the driver's in-flight guard (built after the wire).
  let releaseRef: (qitemId: string) => void = () => {};

  const deliver = outboundReady
    ? subsystemSlackDeliver({
        botToken: bot!,
        channel: cfg.channel!,
        // #192: with a channel map, a reply-to update whose choice is already recorded posts in that
        // choice's channel (the default for a choice recorded before any map existed), everything else
        // follows the map. Without a map (the fork's channels), a post follows its thread's channel,
        // else its slack-channel tag, its seat's channel or the default.
        resolveChannel: (p, threadTs) => {
          const replyTo = threadReplyTo(p);
          const recorded = replyTo ? opts.queueRepo.replyToChoiceFor(p.qitemId) : null;
          if (cfg.channelMap?.length) {
            if (recorded) return recorded.channel ?? cfg.channel!;
            const mapped = resolveOutboundChannel(cfg, p.sourceSession) ?? cfg.channel!;
            return notificationsChannelFor(p, replyTo, threadTs, mapped) ?? mapped;
          }
          if (recorded?.channel) return recorded.channel;
          const usual = channelForPost(p, threadTs);
          return notificationsChannelFor(p, replyTo, threadTs, usual) ?? usual;
        },
        pinChannel: Boolean(cfg.channelMap?.length),
        sourceLabel: cfg.sourceLabel,
        answerHint: cfg.explicitAnswersOnly,
        asksHuman: (p) => !!p.qitemId && askedHumanOf(p.qitemId) !== null,
        fetchImpl: opts.fetchImpl,
        stopSignal: runCtl.signal,
        delivered,
        attempted,
        outboundSeen,
        release: (q) => releaseRef(q),
        // Thread reuse is durable-conversation scoped, not merely human+seat scoped.
        // Slack replies identify only the root thread. Giving two qitems the same root
        // would make an inbound reply ambiguous and could resume the wrong human gate.
        // Re-delivery/new notification episodes for one qitem still reuse its exact root.
        // #96: an update may name an earlier qitem's root; the guard lives in deriveReplyToChoice.
        resolveThreadTs: (p, channel) => {
          if (isResolvedNotice(p)) return threadMap.resolveByConversation(p.qitemId)?.threadTs;
          if (threadReplyTo(p)) {
            const choice = chooseReplyToThread(p, channel);
            if (choice.kind === "thread") return choice.threadTs;
          }
          const own = threadMap.resolveOpenForConversation(
            p.destinationSession ?? "",
            p.sourceSession ?? "",
            p.qitemId,
          );
          // #96: once an update shares this root, a new decision from its owner starts a fresh
          // root instead, so the decision never lands in a thread a reader took as FYI-only.
          if (own && !threadReplyTo(p) && opts.queueRepo.isReplyToThread(own.threadTs)) return undefined;
          // #192: with a channel map, a root in another channel than this attempt's (the seat was
          // remapped since this item's root was posted) cannot carry this post, so a fresh root
          // opens in this attempt's channel. Without a map the root is reused as it always was,
          // whatever channel it was posted in.
          if (own && cfg.channelMap?.length && own.channel !== channel) return undefined;
          return own?.threadTs;
        },
        // S14: posting and interruption are separate threshold dials over one vocabulary.
        resolveMentionUserId: (p) => {
          if (p.humanIntent === "update" || isResolvedNotice(p)) return undefined;
          // OPR.0.5.6.1: the engine's decided loudness is the mention rule for
          // registered humans; the dial pair remains only for the null degrade.
          if ((p as { deliveryDigestPost?: boolean }).deliveryDigestPost) return undefined; // notify-class aggregate, never a mention
          const fire = (p as { deliveryDeferralFire?: boolean }).deliveryDeferralFire === true;
          const decision = fire ? null : decideForPayload(p);
          const eligible = fire
            ? true // the deferred interrupt mentions at fire time — that IS the deferral's promise
            : decision
              ? decision.mention
              : Boolean(p.ownerNotificationLevel && ownerNotificationLevelAtLeast(p.ownerNotificationLevel, cfg.minimumLevelThatInterrupts));
          if (!eligible) return undefined;
          const local = (p.destinationSession ?? "").split("@")[0] ?? "";
          if (!local) return undefined;
          const reg = registrySurface.loadHumanRegistry(opts.home);
          if (!reg.ok) return undefined;
          for (const e of reg.entities) {
            if (e.entityId !== local) continue;
            for (const b of e.connectorBindings) {
              if (b.kind === "slack" && b.handle) return b.handle;
            }
          }
          return undefined;
        },
        onPostedRoot: (p, ts, channel) => {
          // A healthy connection receives each post back as an event; the inbound liveness watch
          // waits for it. Every post, root or part, registers once, here or in onPostedPart.
          inboundHandle?.expectEcho(ts);
          const human = p.destinationSession ?? "";
          const seat = p.sourceSession ?? "";
          threadMap.open({ threadTs: ts, channel, human, seat, conversationId: p.qitemId });
          // The REBUILD stamp: the queue row is the durable source the map re-derives from.
          try {
            opts.queueRepo.update({
              qitemId: p.qitemId,
              actorSession: "daemon@kernel",
              transitionNote: formatPostedStamp({ threadTs: ts, messageTs: ts, channel, human, seat, conversationId: p.qitemId }),
            });
          } catch (e) {
            // Stamp failure degrades REBUILDABILITY, not routing — loud, never fatal to delivery.
            log(`thread stamp failed for ${p.qitemId}: ${(e as Error).message}`);
          }
        },
        // #899 — a message posted into a thread for an ask maps to that ask and its seat (the thread's root
        // may be another ask's), so a reaction on it reaches the seat that asked. A digest speaks for many
        // rows and has no single asking seat, so it isn't mapped.
        // #192: a part is recorded in the channel it was posted to, so a reaction on it in a mapped
        // channel finds its ask (thread_part_map is keyed by channel and message).
        onPostedPart: (p, messageTs, threadTs, channel) => {
          inboundHandle?.expectEcho(messageTs); // a multipart post's supplemental parts arrive only here
          const seat = p.sourceSession ?? "";
          if (!p.qitemId || !seat || (p as { deliveryDigestPost?: boolean }).deliveryDigestPost) return;
          const human = p.destinationSession ?? "";
          threadMap.recordPart({ messageTs, channel, threadTs, seat, conversationId: p.qitemId });
          try {
            opts.queueRepo.update({
              qitemId: p.qitemId,
              actorSession: "daemon@kernel",
              transitionNote: formatPostedStamp({ threadTs, messageTs, channel, human, seat, conversationId: p.qitemId }),
            });
          } catch (e) {
            log(`reply stamp failed for ${p.qitemId}: ${(e as Error).message}`);
          }
        },
        onTransportFailed: recordTransportFailed,
        onPosted: (p, messageTs, threadTs) => {
          // v3 digest branch: transport truth first — every member receipt is
          // stamped HERE, after the real post, digest-tokened and episode-keyed.
          const digest = (p as unknown as { deliveryDigestPost?: boolean; digestId?: string; memberReceipts?: Array<{ qitemId: string; notificationKey: string; level: string; kind: string }> });
          if (digest.deliveryDigestPost && Array.isArray(digest.memberReceipts)) {
            for (const m of digest.memberReceipts) {
              if (opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(m.qitemId, m.notificationKey)) continue;
              opts.queueRepo.update({
                qitemId: m.qitemId,
                actorSession: "daemon@kernel",
                transitionNote: [
                  "slack-owner-notification-posted",
                  `notification_key=${m.notificationKey}`,
                  `level=${m.level}`,
                  `kind=${m.kind}`,
                  `message_ts=${messageTs}`,
                  `thread_ts=${threadTs ?? messageTs}`,
                  `digest=${digest.digestId ?? "unknown"}`,
                ].join(" "),
              });
            }
            return;
          }
          const key = p.notificationKey ?? p.qitemId;
          if (opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(p.qitemId, key)) return;
          // One atomic queue transition records complete delivery and closes ONLY
          // an informational delivery obligation. This is never a human decision.
          opts.queueRepo.update({
            qitemId: p.qitemId,
            actorSession: "daemon@kernel",
            ...(p.humanIntent === "update" ? { state: "done" as const, closureReason: "no-follow-on" } : {}),
            transitionNote: [
              "slack-owner-notification-posted",
              `notification_key=${key}`,
              `level=${p.ownerNotificationLevel ?? "RECORD"}`,
              `kind=${p.ownerNotificationKind ?? "unclassified"}`,
              `message_ts=${messageTs}`,
              `thread_ts=${threadTs ?? messageTs}`,
            ].join(" "),
          });
        },
        log,
      })
    : async () => ({ ok: false as const, class: "slack-outbound-not-configured", detail: "bot token or channel missing" });

  // OPR.0.5.6.1 — decision containment ahead of the transport: log-class and
  // digest-class produce ZERO post attempts (AM-F5 tooth); an away-escalation
  // deferral arms the watchdog substrate and posts nothing now (AM-F1); an
  // away/off escalation records the single-human termination exactly once per
  // episode (A1.1, F-7). interrupt/notify fall through to the S14 delivery
  // path unchanged.
  const recordTerminationOnce = (p: OutboundPostPayload, decision: DeliveryDecision): void => {
    if (!decision.termination || !p.qitemId) return;
    const key = p.notificationKey ?? p.qitemId;
    const already = opts.queueRepo.transitionLog.listForQitem(p.qitemId).some((t) =>
      t.transitionNote?.startsWith(DELIVERY_TERMINATION_PREFIX)
        && t.transitionNote.split(/\s+/).includes(`notification_key=${key}`));
    if (already) return;
    opts.queueRepo.update({
      qitemId: p.qitemId,
      actorSession: "daemon@kernel",
      transitionNote: formatDeliveryTermination(decision.termination, key),
    });
  };
  // Decisions already in the dispatch buffer when this wire is built are retained from an earlier
  // run: posts that failed or never finished, which startServices() replays.
  const replayedAtStart = new Set(new DispatchBuffer(opts.home).pending().map((d) => d.decisionId));
  // A replayed notification for a row that has since left the active states is history, not news
  // (a post that failed, retried a day later): it posts nothing, and the row says why, unless the
  // episode already has its posted receipt. Returning ok drains it from the dispatch buffer.
  const dropStaleNotification = (p: OutboundPostPayload, state: string): void => {
    const key = p.notificationKey ?? p.qitemId;
    const notes = opts.queueRepo.transitionLog.listForQitem(p.qitemId).map((t) => t.transitionNote ?? "");
    const posted = notes.some((n) => n.startsWith("slack-owner-notification-posted ") && n.split(/\s+/).includes(`notification_key=${key}`));
    const note = `slack-owner-notification-dropped notification_key=${key} reason=row-not-active state=${state}`;
    if (!posted && !notes.includes(note)) {
      opts.queueRepo.update({ qitemId: p.qitemId, actorSession: "daemon@kernel", transitionNote: note });
    }
    outboundSeen.mark(key, "dropped-row-not-active");
    releaseRef(key);
  };
  const engineDeliver: SubsystemDeliverFn = async (decision) => {
    const p = ((decision as { payload?: unknown }).payload ?? {}) as OutboundPostPayload & { deliveryDeferralFire?: boolean };
    // The decision-resolved notice is written at closure, so a closed row is its normal case.
    if (replayedAtStart.has(decision.decisionId) && p.qitemId && p.ownerNotificationKind !== "human-decision-resolved"
      && !(p as { deliveryDigestPost?: boolean }).deliveryDigestPost) {
      const state = opts.queueRepo.getById(p.qitemId)?.state;
      if (state && !isBlockerLive(state)) {
        dropStaleNotification(p, state);
        return { ok: true as const };
      }
    }
    // The T+30 deferral FIRE executes an already-made decision — never re-consult
    // (a re-consult would re-defer: the immediate-plus-deferred shape AM-F3 forbids).
    // R2 B-3 belt: an episode that already carries its posted receipt (a replayed
    // decision, or any second mint) posts NOTHING — exactly-once by the receipt.
    // A digest post is an already-decided aggregate — never re-consulted
    // (member decisions were recorded at containment; receipts land in onPosted).
    if ((p as { deliveryDigestPost?: boolean }).deliveryDigestPost) return deliver(decision);
    if (p.deliveryDeferralFire) {
      const fireKey = p.notificationKey ?? p.qitemId;
      if (p.qitemId && opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(p.qitemId, fireKey)) {
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
      return deliver(decision);
    }
    const ruled = p.qitemId ? decideForPayload(p) : null;
    if (ruled) {
      recordTerminationOnce(p, ruled);
      const episodeKey = p.notificationKey ?? p.qitemId;
      if (ruled.outcome === "log") {
        outboundSeen.mark(episodeKey, "log-class-contained");
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
      if (ruled.outcome === "digest") {
        // R1 B-4: the MESSAGE-TIME decision is recorded on the row (with the
        // live dials already applied by the consult above); the flush consumes
        // this record and never re-decides from later registry state.
        const already = opts.queueRepo.listTransitions(p.qitemId).some((t) =>
          t.transitionNote?.startsWith("delivery-decision: digest")
            && t.transitionNote.includes(`notification_key=${episodeKey}`));
        if (!already) {
          opts.queueRepo.update({
            qitemId: p.qitemId,
            actorSession: "daemon@kernel",
            transitionNote: `delivery-decision: digest window=${ruled.digestWindow ?? "4h"} notification_key=${episodeKey}`,
          });
        }
        outboundSeen.mark(episodeKey, `digest-deferred-${ruled.digestWindow ?? "4h"}`);
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
      if (ruled.deferMinutes !== undefined) {
        try {
          armDeliveryDeferral({
            jobsRepo: new WatchdogJobsRepository(opts.queueRepo.db),
            queueRepo: opts.queueRepo,
            qitemId: p.qitemId,
            entityId: (p.destinationSession ?? "").split("@")[0] ?? "unknown",
            minutes: ruled.deferMinutes,
            notificationKey: episodeKey,
          });
        } catch (e) {
          log(`deferral arm failed for ${p.qitemId}: ${(e as Error).message} — falling through to immediate notify-class delivery (fail-loud beats silent loss)`);
          return deliver(decision);
        }
        outboundSeen.mark(episodeKey, "interrupt-deferred");
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
    }
    return deliver(decision);
  };

  const wire = buildInProcessWire({
    home: opts.home,
    ops: outboundReady ? [OUTBOUND_OP] : [],
    deliver: outboundReady ? engineDeliver : deliver,
    log,
  });

  // Services are CONSTRUCTED here but started only via startServices() (post-bind, index.ts):
  // composing a daemon must never dial Slack or start pollers — the createDaemon-in-tests
  // hermeticity rule, same as every monitor in the supervision tree.
  const stops: Array<() => void> = [];
  const starts: Array<() => void> = [];
  let inboundHandle: SocketInboundHandle | undefined;
  let recovery: ChannelRecovery | undefined;
  let extraRecoveries: ChannelRecovery[] = [];

  if (outboundReady) {
    const driver = new SlackOutboundDriver({
      home: opts.home,
      queue: ports,
      seen: outboundSeen,
      filter: { minimumLevel: cfg.minimumLevelThatPosts },
      dispatch: (op, ref, payload) => wire.dispatcher.dispatch(op, ref, payload),
      intervalMs: opts.outboundIntervalMs,
      log,
    });
    releaseRef = (q) => driver.release(q);
    let sweepTimer: ReturnType<typeof setInterval> | undefined;
    let sweeping = false;
    starts.push(() => {
      sweepTimer = setInterval(() => {
        if (sweeping) return;
        sweeping = true;
        void sweepRequests(lifecycle).finally(() => { sweeping = false; });
      }, opts.requestSweepIntervalMs ?? 10 * 60_000);
      sweepTimer.unref?.();
    });
    stops.push(() => clearInterval(sweepTimer));
    let unsubscribeOutbound: (() => void) | undefined;
    starts.push(() => {
      driver.start();
      unsubscribeOutbound = opts.queueRepo.events.subscribe((event) => {
        if ((event.type === "queue.created" || event.type === "queue.updated" || event.type === "queue.handed_off")
          && opts.outboundKick !== false && opts.queueRepo.transitionLog.latestOwnerNotificationForQitem(event.qitemId)) driver.kick();
        // A canceled request (an expired approval included) closes now, not at the next sweep, so its
        // card loses its buttons while the human may still be looking at it.
        const change = event as { type: string; qitemId: string; fromState?: string; toState?: string };
        if (change.type === "queue.updated" && change.toState === "canceled" && change.fromState !== "canceled") {
          // After the current write finishes: a close already under way (a human's cancel) has closed the thread by then.
          setImmediate(() => {
            const root = threadMap.resolveByConversation(change.qitemId);
            if (root?.state !== "open" || root.conversationId !== change.qitemId || !isRequestToHuman(opts.queueRepo.getById(change.qitemId), root)) return;
            void closeRequest(lifecycle, root, "canceled-by-seat", "daemon@kernel").catch((e) => log(`request ${change.qitemId} close failed: ${(e as Error).message}`));
          });
        }
      });
      log("slack outbound driver started (subsystem path)");
    });
    stops.push(() => { unsubscribeOutbound?.(); driver.stop(); });
  }

  // Hoisted out of the inbound block so status() can report the durable backlog.
  // Both files are the retry pass's custody: the event dead-letter
  // (`slack-inbound-deadletter.jsonl`) and the click dead-letter
  // (`slack-inbound-action-deadletter.jsonl`), which retryActionDeadLetters owns.
  // An inert wire omits the fields rather than inventing a count for a connector
  // that is not running.
  let dead: DeadLetterStore<SlackEvent> | undefined;
  let deadActions: DeadLetterStore<SlackBlockActions> | undefined;

  if (inboundReady) {
    const inboundSeen = new SeenStore(path.join(stateDir(opts.home), "slack-inbound-seen.jsonl"));
    dead = new DeadLetterStore<SlackEvent>(path.join(stateDir(opts.home), "slack-inbound-deadletter.jsonl"));
    const receipts = new InboundReceiptStore(path.join(stateDir(opts.home), "slack-inbound-receipts.jsonl"));
    const registry: RegistrySurface = registrySurface;
    const router = new InboundRouter({
      queue: ports,
      seen: inboundSeen,
      deadLetter: dead,
      destination: cfg.inboundDestination,
      resolveSender,
      // S10 — deterministic thread routing: mapped thread → exactly the mapped seat; unmapped
      // or human-initiated → the configured orchestrator slot as an unrouted-signal row.
      resolveRoute: makeThreadRouteResolver({ map: threadMap, unroutedDestination: cfg.inboundDestination, log,
        destinationForChannel: (channel) => channels.find((c) => c.id === channel)?.inboundDestination,
        // Machinery sends as daemon@kernel, <name>@host, <name>@system or system:<name> and never has a
        // session here; a real rig that happens to use such a name does.
        isAgentSeat: (seat) => !(/^daemon@kernel$|@host$|@system$|^system:/.test(seat))
          || !!opts.queueRepo.db.prepare("SELECT 1 FROM sessions WHERE session_name = ? LIMIT 1").get(seat),
        newestOpenDecision: (threadTs, channel, slackUser) => {
          const root = threadMap.resolveByThread(threadTs);
          const who = resolveSender(slackUser, channel);
          if (!channel || !who.admitted) return null;
          // Only a decision asked of this person: another human's decision in the thread leaves the root's.
          for (const part of threadMap.partsInThread(threadTs, channel)) {
            if (part.conversationId === root?.conversationId) continue;
            const item = opts.queueRepo.getById(part.conversationId);
            if (item && item.humanIntent !== "update" && hasLiveHumanGate(item) && askedHumanOf(item.qitemId) === who.source) return part;
          }
          return null;
        },
        isHumanStarted: (conversationId) => {
          const item = opts.queueRepo.getById(conversationId);
          const root = threadMap.resolveByConversation(conversationId);
          // A human's own message the seat later parked on that human is a real question: it correlates.
          return !!item && !!root && entityOf(item.sourceSession) === entityOf(root.human) && !hasLiveHumanGate(item);
        } }),
      resolveHumanReply: opts.resolveHumanReply && (async (input) => {
        // Only the human the item waits on may resolve it (its park's blocked_on, or a direct request's destination).
        if (askedHumanOf(input.qitemId) !== input.actorSession) return "not-applicable";
        return opts.resolveHumanReply!(input);
      }),
      explicitAnswersOnly: cfg.explicitAnswersOnly,
      hasQuestions: (qitemId) => (opts.queueRepo.getById(qitemId)?.humanQuestions?.length ?? 0) > 0,
      // #193 — a button click records its answer on the decision the clicked root belongs to;
      // a failed hand-back is retried with the event dead-letters, and each click is confirmed
      // in the decision's thread (a bot post, so inbound never ingests it).
      recordHumanAnswer: (input) => opts.queueRepo.recordHumanAnswer(input),
      reactionTarget: makeReactionTarget(opts.queueRepo, threadMap, cfg.explicitAnswersOnly, askedHumanOf),
      postedQitem: (messageTs) => opts.queueRepo.postedQitemForMessage(messageTs),
      markConfirmWon: (offerQitemId) => {
        opts.queueRepo.update({ qitemId: offerQitemId, actorSession: "daemon@kernel", transitionNote: CONFIRM_WON_NOTE });
      },
      isAddressed: async (ev) => {
        // In a channel with more than one human only an @mention addresses the app, in its threads too.
        if (!ev.channel || ((await humansIn(ev.channel)) ?? 0) <= 1) return true;
        const me = await appUserId();
        return !me || String(ev.text ?? "").includes(`<@${me}>`);
      },
      onMembershipChanged: (channel) => { humanCounts.delete(channel); void recount(channel); },
      ...(bot ? {
        retireQuestionButtons: async ({ channel, messageTs, qitemId }: { channel: string; messageTs: string; qitemId: string }) => {
          const decision = opts.queueRepo.getById(qitemId);
          if (!decision?.humanQuestions?.length) return;
          // Every answered question shows its pick; while some are open their buttons stay.
          const complete = unansweredQuestions(decision.humanQuestions, decision.humanAnswers ?? {}).length === 0;
          const message = buildOutboundMessage(decision, { ...repostInputs(decision), answered: complete });
          const r = await updateChatMessage(bot, { channel, ts: messageTs, ...message }, opts.fetchImpl);
          if (!r.ok) log(`question buttons not replaced qitem=${qitemId}: ${r.error}`);
        },
        retireConfirmOffer: async ({ channel, messageTs, offerQitemId, outcome }: { channel: string; messageTs: string; offerQitemId: string; outcome: import("./message.js").ConfirmOutcome }) => {
          const offer = opts.queueRepo.getById(offerQitemId);
          if (!offer) return;
          const message = buildOutboundMessage(offer, { ...repostInputs(offer), confirmOutcome: outcome });
          const r = await updateChatMessage(bot, { channel, ts: messageTs, ...message }, opts.fetchImpl);
          if (!r.ok) log(`confirm button not replaced offer=${offerQitemId}: ${r.error}`);
        },
      } : {}),
      cancelRequest: async ({ conversationId, actorSession, reason }) => {
        const root = threadMap.resolveByConversation(conversationId);
        if (!root || root.state !== "open" || !opts.queueRepo.getById(conversationId)) return "not-applicable";
        if (!isRequestHuman(root, actorSession)) return "not-authorized";
        await closeRequest(lifecycle, root, reason ? `canceled-by-human: ${reason}` : "canceled-by-human", actorSession, true);
        return "closed";
      },
      confirmOffer: ({ offerQitemId, actorSession }) => {
        const offer = opts.queueRepo.getById(offerQitemId);
        const defaultConfirm = cfg.explicitAnswersOnly && !offer?.humanConfirm && offer?.humanIntent !== "update" && !offer?.humanQuestions?.length;
        const reading = offer?.humanConfirm ?? (defaultConfirm ? DEFAULT_CONFIRM_DECISION : null);
        if (!offer || !reading) return { ok: false, reason: "not-a-confirm-offer" };
        const decisionQitemId = offer.humanIntent !== "update" ? offer.qitemId : offer.replyTo;
        if (!decisionQitemId) return { ok: false, reason: "not-a-confirm-offer" };
        // The decision's own addressed human answers it, whoever started the thread it sits in.
        if (askedHumanOf(decisionQitemId) !== actorSession) return { ok: false, reason: "not-the-asked-human" };
        if (offer.humanIntent === "update" && offer.tsCreated < gateOpenedAt(opts.queueRepo, decisionQitemId)) return { ok: false, reason: "offer-from-an-earlier-gate" };
        const won = opts.queueRepo.transitionLog.listForQitem(offer.qitemId).some((t) => t.transitionNote === CONFIRM_WON_NOTE && t.actorSession === "daemon@kernel" && t.identityProvenance === null);
        return { ok: true, decisionQitemId, reading, decided: currentGateResolved(opts.queueRepo, decisionQitemId), won };
      },
      actionDeadLetter: (deadActions = new DeadLetterStore<SlackBlockActions>(path.join(stateDir(opts.home), "slack-inbound-action-deadletter.jsonl"))),
      ...(bot ? {
        // A stopped run posts nothing, and its rate-limit wait ends with the run: after a restart the click's
        // redelivery belongs to the new router, which must not race a stale retry from this one.
        acknowledgeAnswer: async ({ channel, threadTs, text }: { channel?: string; threadTs: string; text: string }) => {
          const target = channel ?? cfg.channel;
          if (!target || runCtl.signal.aborted) return false;
          const r = await postChatMessage(bot, { channel: target, thread_ts: threadTs, text }, opts.fetchImpl, undefined,
            (ms) => abortableSleep(ms, runCtl.signal));
          if (!r.ok) log(`answer acknowledgement not posted thread=${threadTs}: ${r.error}`);
          return r.ok;
        },
      } : {}),
      // OPR.0.5.6.2 — inbound file transfer: wired only when the bot token exists
      // (downloads need `files:read`); absent → the router's own named-failure
      // arm keeps failure honest. Media lives beside the gateway's other durable
      // state, under the same home convention.
      ...(bot ? {
        files: makeInboundFilePort({
          token: bot,
          mediaDir: path.join(stateDir(opts.home), "slack-inbound-media"),
          fetchImpl: opts.fetchImpl,
          log,
        }),
      } : {}),
      log,
    });
    let unsubscribe: (() => void) | undefined;
    starts.push(() => {
      void appUserId();
      for (const c of channels) void humansIn(c.id);
    });
    starts.push(() => {
      unsubscribe = opts.queueRepo.events.subscribe((event) => {
        if (event.type === "queue.updated" || event.type === "queue.handed_off") void syncRootDone(event.qitemId);
      });
    });
    stops.push(() => unsubscribe?.());
    const followedThreads = (channel: string) => () => threadMap.listOpenRootsInChannel(channel, new Date(Date.now() - 7 * 24 * 3600_000).toISOString());
    const activeThreads = (channel: string) => () => threadMap.listActiveRootsInChannel(channel, new Date(Date.now() - 6 * 3600_000).toISOString());
    recovery = new ChannelRecovery({ channel: cfg.channel, token: bot, stateDir: stateDir(opts.home), router, fetchImpl: opts.fetchImpl, threadRoots: cfg.channel ? followedThreads(cfg.channel) : undefined, hotRoots: cfg.channel ? activeThreads(cfg.channel) : undefined });
    extraRecoveries = channels.filter((c) => c.id !== cfg.channel).map((c) => new ChannelRecovery({ channel: c.id, token: bot, stateDir: stateDir(opts.home), router, fetchImpl: opts.fetchImpl, threadRoots: followedThreads(c.id), hotRoots: activeThreads(c.id) }));
    const recoveries = [recovery, ...extraRecoveries];
    let fastTimer: ReturnType<typeof setInterval> | undefined;
    starts.push(() => {
      fastTimer = setInterval(() => { for (const r of recoveries) void r.runFast(); }, opts.fastRecoveryIntervalMs ?? 45_000);
      fastTimer.unref?.();
    });
    stops.push(() => clearInterval(fastTimer));
    starts.push(() => {
      for (const r of recoveries) r.initialize(); // persist the once-only floor before any live events
      inboundHandle = startSocketInbound(app!, router, {
        fetchImpl: opts.fetchImpl,
        wsFactory: opts.wsFactory,
        retryIntervalMs: opts.inboundRetryIntervalMs,
        inboundMaxConnects: opts.inboundMaxConnects,
        receipts,
        recovery: { run: async () => { await Promise.all(recoveries.map((r) => r.run())); }, stop: () => { for (const r of recoveries) r.stop(); } },
        log,
      });
      log("slack socket-mode inbound started (subsystem path)");
    });
    stops.push(() => inboundHandle?.stop());
  }

  const baseStop = wire.stop;
  const baseStartServices = wire.startServices;
  let servicesLive = false;
  return {
    dispatcher: wire.dispatcher,
    startServices: () => {
      if (servicesLive) return; // idempotent — a double post-bind start must not double-poll
      servicesLive = true;
      baseStartServices?.(); // replay un-Acked decisions through delivery (restart no-loss)
      for (const s of starts) s();
    },
    stop: () => {
      runCtl.abort(); // cancel this run's pending rate-limit waits before teardown
      for (const s of stops) { try { s(); } catch { /* best-effort */ } }
      baseStop();
    },
    status: () => ({
      platform: "slack", configurationDigest: channelStateDigest(cfg),
      outboundReady,
      inboundReady,
      recovery: recovery?.status() ?? { state: "unavailable", reason: "inbound-not-configured" },
      ...(extraRecoveries.length ? { extraRecoveries: extraRecoveries.map((r) => r.status()) } : {}),
      inbound: inboundHandle?.status() ?? { state: inboundReady ? "not-started" : "not-configured", generation: 0, reconnects: 0 },
      // The retry pass's durable custody, counted from both dead-letter files:
      // inbound events plus click answers. Records, not distinct messages — a
      // message that left more than one record is counted once per record, which
      // is why the field is named for records. Present iff inbound is configured;
      // an unreadable file reports state "unknown" with a reason instead of a
      // false zero.
      ...deadLetterBacklogFields(dead, deadActions),
    }),
  };
}
