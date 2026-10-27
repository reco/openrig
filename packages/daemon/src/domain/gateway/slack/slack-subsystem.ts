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

import { SlackRecovery, ownedRecoveryChannels } from "./slack-recovery.js";
import { unansweredQuestions } from "../../human-questions.js";
import { parseMergeRef } from "../../human-merge.js";
import { channelStateDigest } from "../channel-operations.js";
import path from "node:path";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { buildInProcessWire, type GatewayWire, type SubsystemDeliverFn } from "../gateway-subsystem.js";
import { DispatchBuffer } from "../dispatch-buffer.js";
import { botInboxProblems } from "./bot-inbox.js";
import { addReaction, callWebApi, countChannelHumans, downloadPrivateFile, isSlackHost, lookupBotApp, postChatMessage, removeReaction, updateChatMessage } from "./slack-api.js";
import { channelsOf, effectiveInboundDestination, inboundDestinationNote, loadConfig } from "./config.js";
import { resolveDefaultReceiver } from "../../default-receiver.js";
import { resolveSecret } from "./secrets.js";
import { SeenStore, DeadLetterStore, InboundReceiptStore, slackMicros } from "./state-store.js";
import { makeQueuePorts } from "./queue-access.js";
import { SlackOutboundDriver, OUTBOUND_OP, type OutboundPostPayload } from "./outbound-driver.js";
import { SlackAskSettlement } from "./settled-asks.js";
import { abortableSleep, evidenceAttachment, POSSIBLY_POSTED_CLASS, subsystemSlackDeliver } from "./slack-delivery.js";
import { InboundRouter, SLACK_THREAD_ROOT_TAG, handleEnvelope, inboundQitemIdFor, NOT_ADDRESSED_TAG, SLACK_MESSAGE_TAG, type SocketEnvelope, type ReactionTarget, type SlackEvent, type SlackBlockActions, type InboundFilePort, type InboundFileResult, type StoredInboundFile, type FailedInboundFile } from "./inbound.js";
import { makeInboundSenderResolver, type RegistrySurface } from "./inbound-admission.js";
import { ThreadSeatMap, formatPostedStamp } from "./thread-seat-map.js";
import { attributionFromSession, buildCompactClosedMessage, buildOutboundMessage, DEFAULT_CONFIRM_DECISION, UPDATE_MENTION_TAG } from "./message.js";
import { makeThreadRouteResolver } from "./thread-routing.js";
import { resolveInboundChannelDestination, resolveOutboundChannel, unsupportedChannelMapFields } from "./channel-map.js";
import { resolveRigRepresentative } from "../../queue-owner.js";
import { recoveryTag } from "../../queue-recovery.js";
import { getSelfHostId } from "../../hosts/fanout-contract.js";
import { SettingsStore, type ResolvedSetting } from "../../user-settings/settings-store.js";
import { envelopeChannel, forwardChannelProblems, makeEnvelopeForwarder } from "./forwarding.js";
import type { HostRegistryLoadResult } from "../../hosts/hosts-registry-reader.js";
import { startSocketInbound, type SocketInboundHandle, type WsLike } from "./socket-inbound.js";
import { HUMAN_ALERT_TAG, loadHumanRegistry, resolveRegisteredHumanAddress, resolveSlackHandle } from "../human-registry.js";
import { sharedChannelAddresses, sharedChannelFor } from "../participants.js";
import { hasLiveHumanGate, isBlockerLive, type QueueItem, type QueueRepository } from "../../queue-repository.js";
import { humanAnswerText } from "../../human-questions.js";
import { formatReplyToChoice, formatArrivalThread, formatReplyToThreadMissing, REPLY_TO_CHOICE_ACTOR, REPLY_TO_CHAIN_LIMIT, type ReplyToChoice } from "../../reply-to-choice.js";
import { closeRequest, isRequestToHuman, currentGateResolved, entityOf, gateOpenedAt, githubLinkState, isRequestHuman, sweepRequests, type LinkState, type RequestLifecycleDeps, type RequestLink } from "./request-lifecycle.js";
import { isHumanSeatSessionRef, parseSessionName } from "../../session-name.js";
import type { FetchImpl } from "./slack-api.js";
import {
  ownerNotificationLevelAtLeast,
  RELAY_OWNER_NOTIFICATION_TRANSPORT_FAILED_PREFIX,
} from "../../queue-transition-log.js";
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
import { confirmReleaseAtPost, currentAskVerdict, holdForQuiet, noteQuietUnreadable } from "../../policies/quiet-release.js";
import { noteRePresentNotPosted, noteRePresentUnconfirmed, rePresentMarks, RE_PRESENT_DECISION_PREFIX, type RePresentUnconfirmed } from "./open-asks.js";
import { quietHoldFor } from "../human-quiet-windows.js";
import { WatchdogJobsRepository } from "../../watchdog-jobs-repository.js";
import { loadRelayProfiles } from "../relay-config.js";
import {
  createRelayOutboundTransport,
  prepareRelayDecision,
  relayStatePaths,
  resolvePrimaryRelayBinding,
  type RelayPayloadCarry,
} from "../relay-outbound.js";

const SECRET_BOT = "SLACK_BOT_TOKEN";
const SECRET_APP = "SLACK_APP_TOKEN";

export interface SlackWireOpts {
  home: string;
  queueRepo: QueueRepository;
  log?: (msg: string) => void;
  /** Injectable seams (tests): fetch, websocket factory, sweep cadence, registry surface. */
  fetchImpl?: FetchImpl;
  wsFactory?: (url: string) => WsLike;
  /** The host registry a hub forwards by (default: this home's hosts.yaml). */
  loadHostRegistry?: () => HostRegistryLoadResult;
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
  /** `typedReply`: a typed thread reply, whose words a decision parked on its person stores as its answer; a click's return never does. */
  resolveHumanReply?: (input: { qitemId: string; actorSession: string; decision: string; messageTs?: string; typedReply?: boolean }) => Promise<"resolved" | "resolved-uncertain" | "already-resolved" | "not-applicable">;
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
  home?: string,
): NonNullable<SlackWireOpts["resolveHumanReply"]> {
  return async (input) => {
    const source = queueRepo.getById(input.qitemId);
    if (source?.humanIntent === "update") return "not-applicable";
    if (!contract) return "not-applicable";
    // Any registered person's reply resumes a question parked on another: one trusted workspace, recorded as them on that
    // person's ask (the write contract names both).
    const uncertainDecision = `${input.decision}\n\n---\nOpenRig timing context (Slack reply ${JSON.stringify([input.actorSession, input.messageTs ?? null])}): This reply resumed the question, but its ordering against the posted question could not be confirmed. Resuming is not approval; read the person's words in context.`;
    // An acknowledgement retry must not resolve again. Match this reply's durable
    // context, not an older episode's generic resolved marker.
    if (slackMicros(input.messageTs) !== null && queueRepo.transitionLog.listForQitem(input.qitemId)
      // A different person's resume carries their attribution after the timing context, so match that too.
      .some((transition) => transition.ownerNotificationKind === "human-decision-resolved"
        && (transition.transitionNote === uncertainDecision || transition.transitionNote?.startsWith(`${uncertainDecision}; by `) === true))) {
      return "resolved-uncertain";
    }
    let uncertain = false;
    let parkedOnAsked = false;
    let episodeKey: string | undefined;
    let digestReceipt = false;
    // A park on a person by any address (a registered person's own address, as their Slack rows carry it, or a
    // legacy human seat) answers only from a reply written after its current question posted.
    if (source?.state === "blocked" && source.blockedOn && queueRepo.isPersonAddress(source.blockedOn)) {
      parkedOnAsked = queueRepo.isPersonAddress(source.destinationSession) && queueRepo.answersAsk(source, input.actorSession);
      const episode = queueRepo.currentHumanRequiredEpisode(input.qitemId);
      if (!episode) return "not-applicable";
      const { key, receipt } = episode;
      episodeKey = key;
      // A final receipt attests delivery even when reconciliation lost its timestamp.
      // Without one, ONLY a unique exact current-episode primary proves anything.
      const primary = !receipt && home ? pendingPrimaryReceipt(home, input.qitemId, key) : null;
      if (!receipt && !primary) return "not-applicable";
      const posted = slackMicros(receipt?.messageTs ?? primary?.messageTs);
      const replied = slackMicros(input.messageTs);
      if (posted !== null && replied !== null && replied <= posted) return "not-applicable";
      uncertain = Boolean(receipt?.digest) || posted === null || replied === null;
      digestReceipt = Boolean(receipt?.digest);
    }

    try {
      // One answer per question: another person's committed return for this question is the answer. Resume with it, as
      // theirs; this reply stays the conversation it already became.
      const winner = episodeKey ? queueRepo.committedAnswerFromAnother(input.qitemId, input.actorSession, episodeKey) : null;
      if (winner) {
        // Its typed words are the question's answer, stored as its own resume would: it was taken as the answer only after
        // the question posted, so only a digest receipt leaves its order uncertain.
        const words = humanAnswerText(winner.body);
        const stores = queueRepo.isPersonAddress(source!.destinationSession) && queueRepo.answersAsk(source!, winner.sourceSession) && !digestReceipt;
        await contract.act({ verb: "resolve", qitemId: input.qitemId, actorSession: winner.sourceSession, decision: words,
          ...(stores ? { answerText: words } : {}) });
        return "not-applicable";
      }
      // A question parked on the person it asked takes their typed reply as its answer, stored in the resume's own
      // transaction. A click's return stores nothing here, and a reply whose order is uncertain stays words in context.
      await contract.act({ verb: "resolve", ...input, decision: uncertain ? uncertainDecision : input.decision,
        ...(input.typedReply && parkedOnAsked && !uncertain ? { answerText: input.decision } : {}) });
      return uncertain ? "resolved-uncertain" : "resolved";
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

/** Read positive multipart evidence without changing final receipt/ack ownership. */
function pendingPrimaryReceipt(home: string, qitemId: string, notificationKey: string): { messageTs: string } | null {
  const pending = new DispatchBuffer(home).pending().filter((decision) => {
    const p = decision.payload as Partial<OutboundPostPayload> | null;
    return decision.op === OUTBOUND_OP && p?.qitemId === qitemId
      && p.notificationKey === notificationKey && p.ownerNotificationKind === "human-required";
  });
  if (pending.length !== 1) return null;
  const prefix = `${pending[0]!.decisionId}::primary-receipt::`;
  const records = [...new SeenStore(path.join(stateDir(home), "slack-attempted-decisions.jsonl")).load()]
    .filter((id) => id.startsWith(prefix));
  if (records.length !== 1) return null;
  try {
    const receipt = JSON.parse(Buffer.from(records[0]!.slice(prefix.length), "base64url").toString("utf8"));
    return slackMicros(receipt?.messageTs) !== null ? { messageTs: receipt.messageTs } : null;
  } catch { return null; }
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
 *  inbound-event, click and relay dead-letter files — the event file also carries reactions,
 *  and a message that left more than one record is counted once per record, so the
 *  retry pass owns exactly these records. When any file cannot be read the count is
 *  `null`, not 0: a number (or a zero) beside an unknown state still reads as "nothing
 *  stuck" to a consumer that only looks at the count, so the state and the reason tell
 *  the truth and the number says it does not know. An inert connector reports the same
 *  retained records without starting retries. */
function deadLetterBacklogFields(
  dead: DeadLetterStore<SlackEvent>,
  deadActions: DeadLetterStore<SlackBlockActions>,
  deadForwards: DeadLetterStore<unknown>,
): Record<string, unknown> {
  let records = 0;
  let reason: string | undefined;
  for (const store of [dead, deadActions, deadForwards]) {
    const result = store.readResult();
    if (result.ok) records += result.entries.length;
    else reason = reason ?? result.reason;
  }
  if (reason !== undefined) return { deadLetterBacklog: null, deadLetterBacklogState: "unknown", deadLetterBacklogReason: reason };
  return { deadLetterBacklog: records, deadLetterBacklogState: "ok" };
}

/** The chosen host.name is display-only, including reserved-looking names. Only
 *  an unconfigured default or empty name falls back to the durable self-host id. */
export function selfMachineLabel(displayName: Pick<ResolvedSetting, "value" | "source"> | null | undefined, selfId: string | null): string | null {
  const name = displayName?.source !== "default" && typeof displayName?.value === "string" ? displayName.value.trim() : "";
  if (name) return name;
  return selfId;
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
  // Read once, when the connector starts, like the rest of its configuration.
  // The sender line names the machine a post comes from; the operator's display
  //  name (host.name — the same source the self-host id seeds from) reads better
  //  than a generated `host-<hash>` id on a machine named after first boot. The
  //  durable identity stays in the queue record; this is display-only. Resolved
  //  ONCE here so no settings read sits on the per-post path (restart picks up a
  //  rename, the same pickup cadence as the rest of the connector config).
  const machineId = getSelfHostId();
  const machineLabel = selfMachineLabel(
    (() => { try { return new SettingsStore().resolveOne("host.name"); } catch { return null; } })(),
    machineId,
  );
  const receiver = (() => { try { return resolveDefaultReceiver(opts.queueRepo.db); } catch { return null; } })();
  const inbound = effectiveInboundDestination(cfg, receiver?.session ?? null);
  const inboundNote = inboundDestinationNote(inbound, receiver);
  if (inbound.from === "default") log(`slack inbound: ${inboundNote}`);
  const inboundRouting = { fallback: "local", destination: inbound.destination, destinationFrom: inbound.from, ...(inboundNote ? { destinationNote: inboundNote } : {}) };
  const dead = new DeadLetterStore<SlackEvent>(path.join(stateDir(opts.home), "slack-inbound-deadletter.jsonl"));
  const deadActions = new DeadLetterStore<SlackBlockActions>(path.join(stateDir(opts.home), "slack-inbound-action-deadletter.jsonl"));
  // Retained relays belong to their original host, even after forwarding configuration changes.
  const deadForwards = new DeadLetterStore<{ host: string; envelope: SocketEnvelope }>(
    path.join(stateDir(opts.home), "slack-inbound-forward-deadletter.jsonl"));

  const registrySurface: RegistrySurface = opts.registry ?? { loadHumanRegistry, resolveSlackHandle };
  const hasRelayPrimaryBinding = (): boolean => {
    try {
      const reg = registrySurface.loadHumanRegistry(opts.home);
      return (
        reg.ok &&
        reg.entities.some((e) =>
          e.connectorBindings.some((b) => b.role === "primary" && (b.kind as string) === "relay"),
        )
      );
    } catch {
      return false;
    }
  };
  const hasPendingRelayDecisions = (): boolean => {
    try {
      return new DispatchBuffer(opts.home).pending().some((d) => {
        const p = (d.payload ?? {}) as RelayPayloadCarry;
        return Boolean(p.relayConnectorRef || p.relayEnvelope);
      });
    } catch {
      return false;
    }
  };
  const relayConfigured = hasRelayPrimaryBinding() || hasPendingRelayDecisions();
  const anyOutboundEnabled = outboundReady || relayConfigured;

  if (!outboundReady && !inboundReady && !relayConfigured) {
    const missing = !cfg.enabled ? "connector disabled (rig slack enable)" : !bot ? "SLACK_BOT_TOKEN unresolved" : "channel unconfigured";
    log(`slack delivery not configured (${missing}) — wire is inert; dispatches would be refused honestly`);
    const inert = buildInProcessWire({
      home: opts.home,
      ops: [],
      deliver: async () => ({ ok: false, class: "slack-not-configured", detail: missing }),
      log,
    });
    return { ...inert, status: () => ({ platform: "slack", configurationDigest: channelStateDigest(cfg), outboundReady: false, inboundReady: false, inboundRouting, recovery: { state: "unavailable", reason: "inbound-not-configured" }, inbound: { state: "not-configured" }, ...deadLetterBacklogFields(dead, deadActions, deadForwards) }) };
  }

  const ports = makeQueuePorts(opts.queueRepo, {
    loadHumanRegistry: () => registrySurface.loadHumanRegistry(opts.home),
    sharedChannels: () => sharedChannelAddresses(opts.home),
  });
  // OPR.0.5.6.1 — the one engine consult (AM-F5: the gateway consults the
  // engine BEFORE dispatch). Null = destination is not a registered human;
  // the caller keeps the pre-engine dial behavior (stated degrade).
  const destinationHuman = (p: OutboundPostPayload) => {
    const local = (p.destinationSession ?? "").split("@")[0] ?? "";
    if (!local) return null;
    const reg = registrySurface.loadHumanRegistry(opts.home);
    if (!reg.ok) return null;
    return reg.entities.find((e) => e.entityId === local) ?? null;
  };
  const requestedUpdateMention = (p: OutboundPostPayload): string | undefined => {
    if (!p.tags?.includes(UPDATE_MENTION_TAG)) return undefined;
    const human = destinationHuman(p);
    if (!human || resolveAvailability(human.prefs) !== "available") return undefined;
    return human.connectorBindings.find((b) => b.kind === "slack" && b.handle)?.handle;
  };
  // The person's quiet hours are read on their own. When only they can't be read, that isn't a quiet window: with
  // `pastUnreadableQuiet`, a routine ask that would post is decided from the person's other settings, with no mention
  // (quiet hours would have muted one), and `quietUnreadable` says why, for the post to say so. Quiet hours never change
  // an escalation, or an ask that posts nothing. Without it (a relay, which can't show that line) the read throws.
  const decideForPayload = (p: OutboundPostPayload, { pastUnreadableQuiet }: { pastUnreadableQuiet: boolean }):
    (DeliveryDecision & { quietUnreadable?: string }) | null => {
    const human = destinationHuman(p);
    if (!human) return null;
    const escalation = p.humanIntent !== "update" && isEscalationClass(p.tags);
    let quiet: ReturnType<typeof quietHoldFor>;
    let quietUnreadable: string | undefined;
    try {
      quiet = quietHoldFor(opts.queueRepo.db, human.entityId, new Date());
    } catch (error) {
      if (!pastUnreadableQuiet) throw error;
      quiet = null;
      quietUnreadable = (error as Error).message;
    }
    const decision = decideDelivery({
      level: p.ownerNotificationLevel ?? null,
      escalation,
      alerted: p.humanIntent !== "update" && (p.tags ?? []).includes(HUMAN_ALERT_TAG),
      human: {
        entityId: human.entityId,
        deliveryClass: human.prefs.deliveryClass,
        availability: resolveAvailability(human.prefs),
      },
      dials: {
        minimumLevelThatPosts: cfg.minimumLevelThatPosts,
        minimumLevelThatInterrupts: cfg.minimumLevelThatInterrupts,
      },
      quiet,
    });
    if (quietUnreadable === undefined || escalation || (decision.outcome !== "interrupt" && decision.outcome !== "notify")) return decision;
    return { ...decision, outcome: "notify", mention: false, quietUnreadable };
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
  const isConfiguredChannel = (channel: string) => channels.some((c) => c.id === channel) || (cfg.channelMap ?? []).some((e) => e.channel === channel)
    || Object.values(cfg.mergeChannels ?? {}).includes(channel);
  const MERGE_REF_TAG = "human-merge-ref:";
  const mergeChannelFor = (p: OutboundPostPayload): string | undefined => {
    const ref = p.tags?.find((t) => t.startsWith(MERGE_REF_TAG))?.slice(MERGE_REF_TAG.length);
    const repo = ref ? parseMergeRef(ref)?.repo.toLowerCase() : undefined;
    return repo ? Object.entries(cfg.mergeChannels ?? {}).find(([name]) => name.toLowerCase() === repo)?.[1] : undefined;
  };
  // A new root goes to the configured channel its row names, else to the channel whose seat is
  // posting; replies stay in their thread's channel.
  const SLACK_CHANNEL_TAG = "slack-channel:";
  const taggedChannel = (p: OutboundPostPayload): string | undefined => {
    const id = p.tags?.find((t) => t.startsWith(SLACK_CHANNEL_TAG))?.slice(SLACK_CHANNEL_TAG.length);
    if (!id || isConfiguredChannel(id)) return id || undefined;
    log(`qitem ${p.qitemId} names unconfigured channel ${id}; posting in the seat's channel`);
    return undefined;
  };
  // A daemon alert is about a seat: a prompt notice names it, a finding names the row it recovers.
  const alertSubject = (p: { sourceSession?: string | null; tags?: readonly string[] | null }, depth = 0): string | null | undefined => {
    if (p.sourceSession !== "daemon@kernel") return p.sourceSession;
    const tag = (prefix: string) => p.tags?.find((t) => t.startsWith(prefix))?.slice(prefix.length);
    const seat = tag("stuck-prompt-session:");
    if (seat) return seat;
    const recovered = tag("recovery-for:");
    const row = recovered && depth < 2 ? opts.queueRepo.getById(recovered) : null;
    return row ? alertSubject(row, depth + 1) : p.sourceSession;
  };
  const channelForPost = (p: OutboundPostPayload, threadTs: string | undefined): string =>
    (threadTs ? threadMap.resolveByThread(threadTs)?.channel : undefined)
      ?? sharedChannelFor(p.destinationSession, opts.home)?.channelId
      ?? mergeChannelFor(p)
      ?? taggedChannel(p)
      ?? channels.find((c) => c.inboundDestination === p.sourceSession)?.id ?? cfg.channel!;
  // #192 — the channel a payload posts to: its seat's (or rig's) mapped channel, else the
  // default. The seat is the row's agent side (queue-access projects it into sourceSession for
  // requests, blocked items and resolved decisions alike); an aggregate digest has none and
  // posts to the default. Only called when outbound is ready, so the default is set.
  // A post to a registered shared channel goes to that channel (0.7.3); a reply there already follows its root's channel.
  const channelFor = (p: OutboundPostPayload): string =>
    sharedChannelFor(p.destinationSession, opts.home)?.channelId ?? resolveOutboundChannel(cfg, alertSubject(p)) ?? cfg.channel!;

  // OPR.0.5.6.14 — a failed post writes the transport-failed ledger transition so the
  // undelivered surface (and --verify) can name the gateway's error instead of guessing
  // from nudge telemetry. One receipt per episode.
  // #897 — an ask that can't be rendered fails the same way on every retry, so the person never
  // sees it. Tell the seat that asked, once: the notice's id derives from the ask's, so a replay
  // returns the same row instead of a second one.
  // A retry that can't post the rest of an ask some of which may already be in Slack says so.
  const notifySourceUndeliverable = (p: OutboundPostPayload, detail: string, partlyPosted = false, invalidBlocks = false): void => {
    const seat = p.sourceSession;
    if (!p.qitemId || !seat) return;
    const human = p.destinationSession ?? "the person";
    // A prior episode's notice must not hide this explicit Slack rejection.
    const noticeId = invalidBlocks
      ? `${p.notificationKey ?? p.qitemId}-invalid-blocks-undeliverable`
      : `${p.qitemId}-undeliverable`;
    opts.queueRepo.create({
      qitemId: noticeId,
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
        invalidBlocks
          ? "Slack rejected the message blocks. OpenRig will not retry this payload. Check its evidence links and message content, then send a corrected ask as a new queue item. The original row remains undelivered; close it when you have handled it."
          : partlyPosted
          ? "Check the thread in Slack and send what's missing as a new ask. The original row stays open until you close it."
          : "Shorten it and send it as a new ask. The original row stays open until you close it.",
      ].join("\n"),
      evidenceRef: `rig queue show ${p.qitemId}`,
      tags: ["slack-undeliverable", recoveryTag(p.qitemId)],
    }).catch((e) => log(`undeliverable notice FAILED for ${p.qitemId}: ${(e as Error).message}`));
  };

  const resolveRelayConnectorRef = (p: OutboundPostPayload): string | null => {
    const carry = p as RelayPayloadCarry;
    if (typeof carry.relayConnectorRef === "string" && carry.relayConnectorRef.trim().length > 0) {
      return carry.relayConnectorRef.trim();
    }
    try {
      const reg = registrySurface.loadHumanRegistry(opts.home);
      return resolvePrimaryRelayBinding(p.destinationSession, reg)?.connectorRef ?? null;
    } catch {
      return null;
    }
  };

  const recordTransportFailed = (
    p: OutboundPostPayload,
    failureClass: string,
    detail: string,
    partlyPosted?: boolean,
    relay = false,
  ): void => {
    if (!p.qitemId) return;
    const carry = p as RelayPayloadCarry;
    const isRelay = relay || Boolean(carry.relayConnectorRef || carry.relayEnvelope);
    if (!isRelay && (failureClass === "human-message-unrenderable" || failureClass === "slack-invalid-blocks")) {
      notifySourceUndeliverable(p, detail, partlyPosted, failureClass === "slack-invalid-blocks");
    }
    const key = p.notificationKey ?? p.qitemId;
    if (isRelay) {
      opts.queueRepo.recordRelayOwnerNotificationTransportFailed({
        qitemId: p.qitemId,
        notificationKey: key,
        connectorRef: resolveRelayConnectorRef(p),
        failureClass,
        detail,
      });
      return;
    }
    const previousFailure = opts.queueRepo.transitionLog.listForQitem(p.qitemId).filter((transition) =>
      (transition.transitionNote?.startsWith("slack-owner-notification-transport-failed ")
        || transition.transitionNote?.startsWith(`${RELAY_OWNER_NOTIFICATION_TRANSPORT_FAILED_PREFIX} `))
        && transition.transitionNote.split(/\s+/).includes(`notification_key=${key}`)).at(-1);
    // A corrected attempt can fail transiently after a permanent rejection, and a
    // transient failure can be followed by a definite rejection; an unreadable 2xx
    // (possibly posted) can follow either. Preserve each change of kind.
    const previousNote = previousFailure?.transitionNote ?? "";
    const sameKind = (kind: string) => previousNote.includes(`class=${kind} `) === (failureClass === kind);
    const alreadyRecorded = previousNote.startsWith("slack-owner-notification-transport-failed ")
      && sameKind("slack-invalid-blocks") && sameKind(POSSIBLY_POSTED_CLASS);
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
  const MAX_REPLY_TO_CHAIN = REPLY_TO_CHAIN_LIMIT;
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
        if (root.seat !== (p.sourceSession ?? "") && !humanWroteHere(item, root, p.sourceSession ?? "")) return { kind: "fallback", reason: "root-other-seat", threadTs: root.threadTs };
        // #192: with a channel map a root in another channel than this attempt's cannot carry the post.
        if (cfg.channelMap?.length && root.channel !== channel) return { kind: "fallback", reason: "root-other-channel", threadTs: root.threadTs };
        if (!isConfiguredChannel(root.channel) && root.origin !== "person" && !isHumanStartedRoot(root)) return { kind: "fallback", reason: "root-other-channel", threadTs: root.threadTs };
        // A reply row (a reaction, an answer) names its ask's root: that ask's own live gate still keeps the thread.
        const owner = root.seat === p.sourceSession && root.conversationId !== item.qitemId ? opts.queueRepo.getById(root.conversationId) : null;
        if (!cfg.explicitAnswersOnly && owner && hasLiveHumanGate(owner)) return { kind: "fallback", reason: "reference-has-live-gate", qitemId: owner.qitemId };
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
      if (!next) {
        // #2990: this reply has no gate correlation, but its arrival thread was recorded when
        // it landed. Its answer returns there; the conversation's gate still recognizes only
        // the newest root. Consult this record only at the end of the replyTo chain.
        const arrival = opts.queueRepo.arrivalThreadFor(item.qitemId);
        const root = arrival ? threadMap.resolveByThread(arrival.threadTs, arrival.channel) : null;
        if (root) {
          if (root.state === "closed") return { kind: "fallback", reason: "root-closed", threadTs: root.threadTs };
          if (root.human !== (p.destinationSession ?? "")) return { kind: "fallback", reason: "root-other-human", threadTs: root.threadTs };
          if (root.seat !== (p.sourceSession ?? "")) return { kind: "fallback", reason: "root-other-seat", threadTs: root.threadTs };
          if (root.channel !== channel) return { kind: "fallback", reason: "root-other-channel", threadTs: root.threadTs };
          return { kind: "thread", threadTs: root.threadTs };
        }
        return { kind: "fallback", reason: "root-missing", qitemId: item.qitemId };
      }
      item = opts.queueRepo.getById(next);
    }
    return item
      ? { kind: "fallback", reason: "chain-too-long", qitemId: item.qitemId }
      : { kind: "fallback", reason: "root-missing", qitemId: p.replyTo ?? "" };
  };
  // A reply to a person's own message (a root minted from it, tagged SLACK_THREAD_ROOT_TAG) posts in
  // that message's channel, wherever the replying seat's items otherwise post: the answer goes back
  // where the person asked. Roots OpenRig posted keep #192's rule (the seat's current channel). Only a
  // reply that will thread there takes that channel: one that fails the root's checks (another seat, another
  // person, a closed root, a live gate) posts top-level in the replying seat's own channel, as before.
  const personRootChannel = (p: OutboundPostPayload): string | null => {
    let item = p.replyTo ? opts.queueRepo.getById(p.replyTo) : null;
    let lastItem = item;
    for (let depth = 0; item && depth < MAX_REPLY_TO_CHAIN; depth++) {
      const root = threadMap.resolveByConversation(item.qitemId);
      if (root) {
        if (!item.tags?.includes(SLACK_THREAD_ROOT_TAG)) return null;
        return deriveReplyToChoice(p, root.channel).kind === "thread" ? root.channel : null;
      }
      lastItem = item;
      item = item.replyTo ? opts.queueRepo.getById(item.replyTo) : null;
    }
    // #2990: A reply in a superseded person-owned root uses that root's channel when a channel map would otherwise move it.
    const arrival = !item && lastItem ? opts.queueRepo.arrivalThreadFor(lastItem.qitemId) : null;
    const root = arrival ? threadMap.resolveByThread(arrival.threadTs, arrival.channel) : null;
    const owner = root ? opts.queueRepo.getById(root.conversationId) : null;
    if (root && owner?.tags?.includes(SLACK_THREAD_ROOT_TAG) && deriveReplyToChoice(p, root.channel).kind === "thread") return root.channel;
    return null;
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
    // The channel is recorded whenever it isn't the default, so a retry posts where the choice was made.
    const choice: ReplyToChoice = cfg.channelMap?.length || channel !== cfg.channel ? { ...derived, channel } : derived;
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
  // A human's admitted message shows its row's progress: received while it waits for the seat,
  // picked once claimed, done once closed. A handed-off row follows its successor. Each sync reads
  // the current state and runs one at a time per message, so the last sync decides the reaction.
  const CLOSED_STATES = ["done", "canceled", "failed", "denied"];
  const successorOf = (qitemId: string) => {
    const next = opts.queueRepo.db.prepare("SELECT qitem_id FROM queue_items WHERE handed_off_from = ? ORDER BY ts_created DESC LIMIT 1").get(qitemId) as { qitem_id: string } | undefined;
    return next ? opts.queueRepo.getById(next.qitem_id) : null;
  };
  const wantedReceipt = (row: QueueItem): string => {
    let current: QueueItem | null = row;
    for (let depth = 0; current && depth < MAX_REPLY_TO_CHAIN; depth++) {
      if (current.state !== "handed-off" && current.closureReason !== "handed_off_to") break;
      const next = successorOf(current.qitemId);
      if (!next && current.state !== "handed-off") break;
      current = next;
    }
    if (!current || current.state === "handed-off" || current.state === "in-progress" || current.state === "blocked") return cfg.receipts.picked;
    return CLOSED_STATES.includes(current.state) ? cfg.receipts.done : cfg.receipts.received;
  };
  const appliedReceipt = new Map<string, string>(); // channel:ts -> the stage this run last put on it
  const receiptChains = new Map<string, Promise<void>>();
  const syncMessageReceipt = (origin: QueueItem, message: { channel: string; ts: string }): Promise<void> => {
    const key = `${message.channel}:${message.ts}`;
    const run = (receiptChains.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const row = opts.queueRepo.getById(origin.qitemId);
      if (!bot || !row) return;
      const wanted = wantedReceipt(row);
      const applied = appliedReceipt.get(key);
      if (applied === wanted) return;
      const input = { channel: message.channel, timestamp: message.ts };
      const add = await addReaction(bot, { ...input, name: wanted }, opts.fetchImpl);
      if (!add.ok) { log(`receipt ${wanted} not added ts=${message.ts}: ${add.error}`); return; }
      appliedReceipt.delete(key);
      let cleared = true;
      for (const name of applied ? [applied] : [cfg.receipts.received, cfg.receipts.picked, cfg.receipts.done].filter((n) => n !== wanted)) {
        const r = await removeReaction(bot, { ...input, name }, opts.fetchImpl);
        if (!r.ok) { cleared = false; log(`receipt ${name} not removed ts=${message.ts}: ${r.error}`); }
      }
      if (cleared) appliedReceipt.set(key, wanted);
    });
    receiptChains.set(key, run);
    void run.finally(() => { if (receiptChains.get(key) === run) receiptChains.delete(key); });
    return run;
  };
  const syncReceipt = (qitemId: string): void => {
    const row = opts.queueRepo.getById(qitemId);
    const synced = new Set<string>();
    for (const id of [...(row?.chainOfRecord ?? []), qitemId]) {
      const origin = id === qitemId ? row : opts.queueRepo.getById(id);
      const message = receivedMessage(origin?.tags);
      if (!origin || !message || origin.tags?.includes(NOT_ADDRESSED_TAG) || synced.has(`${message.channel}:${message.ts}`)) continue;
      synced.add(`${message.channel}:${message.ts}`);
      void syncMessageReceipt(origin, message);
    }
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
  // The wire's own dispatcher, bound once the wire exists: a delivery step that must mint a new durable decision.
  let selfDispatch: (decisionId: string, payload: unknown) => { ok: boolean; error?: string } = () => ({ ok: false, error: "wire not built" });

  const deliver = outboundReady
    ? subsystemSlackDeliver({
        botToken: bot!,
        channel: cfg.channel!,
        // #192: with a channel map, a reply-to update whose choice is already recorded posts in that
        // choice's channel (the default for a choice recorded before any map existed), a reply to a
        // person's own message posts in its root's channel, everything else follows the map. Without
        // a map (the fork's channels), a post follows its thread's channel, else its slack-channel
        // tag, its seat's channel or the default.
        resolveChannel: (p, threadTs) => {
          const replyTo = threadReplyTo(p);
          const recorded = replyTo ? opts.queueRepo.replyToChoiceFor(p.qitemId) : null;
          const personRoot = replyTo ? personRootChannel(p) : null;
          if (cfg.channelMap?.length) {
            if (recorded) return recorded.channel ?? cfg.channel!;
            const mapped = personRoot ?? mergeChannelFor(p) ?? channelFor(p);
            return notificationsChannelFor(p, replyTo, threadTs, mapped) ?? mapped;
          }
          if (recorded?.channel) return recorded.channel;
          const usual = personRoot ?? channelForPost(p, threadTs);
          return notificationsChannelFor(p, replyTo, threadTs, usual) ?? usual;
        },
        pinChannel: Boolean(cfg.channelMap?.length),
        sourceLabel: cfg.sourceLabel,
        unfurl: cfg.unfurl === "on" ? "on" : "off",
        // P6: each post names the machine it comes from — the operator's display
        //  name when one is set, else the daemon's own host id.
        machine: () => machineLabel,
        machineFallback: machineId ?? undefined,
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
          // A choice naming this root's channel shares it. One naming no channel shares it when its update
          // posted into this root, by channel and ts (the part the post recorded). When no post of it into a
          // root with this ts is recorded (not posted yet, or recorded before parts were kept), it shares it
          // as on main.
          if (own && !threadReplyTo(p) && (
            opts.queueRepo.isReplyToThread(own.threadTs, { channel: own.channel })
            || opts.queueRepo.unnamedReplyToChoiceRows(own.threadTs).some((id) => {
              const channels = threadMap.partChannels(id, own.threadTs);
              return channels.length === 0 || channels.includes(own.channel);
            })
          )) return undefined;
          // #192: with a channel map, a root in another channel than this attempt's (the seat was
          // remapped since this item's root was posted) cannot carry this post, so a fresh root
          // opens in this attempt's channel. Without a map the root is reused as it always was,
          // whatever channel it was posted in.
          if (own && cfg.channelMap?.length && own.channel !== channel) return undefined;
          return own?.threadTs;
        },
        // S14: posting and interruption are separate threshold dials over one vocabulary.
        resolveMentionUserId: (p) => {
          if (isResolvedNotice(p)) return undefined;
          if (p.humanIntent === "update") return requestedUpdateMention(p);
          // OPR.0.5.6.1: the engine's decided loudness is the mention rule for
          // registered humans; the dial pair remains only for the null degrade.
          if ((p as { deliveryDigestPost?: boolean }).deliveryDigestPost) return undefined; // notify-class aggregate, never a mention
          if ((p as { quietRelease?: boolean }).quietRelease) return undefined; // releasing a quiet hold: posted, never a mention
          const fire = (p as { deliveryDeferralFire?: boolean }).deliveryDeferralFire === true;
          // At post time the decision was just made; if it can't be re-read now, no mention. Quiet hours that can't be read
          // never mention a routine ask (the decision says so).
          let decision: DeliveryDecision | null;
          try { decision = fire ? null : decideForPayload(p, { pastUnreadableQuiet: true }); } catch { return undefined; }
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
        // #2234: Slack posted a reply to this root as a new top-level message, so the root is gone. Its mapping is closed,
        // so later posts don't reuse it. A closed root still routes a reply to its seat.
        onThreadMissing: (p, threadTs, channel) => {
          threadMap.close(threadTs, channel);
          log(`thread ${threadTs} in ${channel} is gone: Slack posted the reply as a new message, so its mapping is closed`);
          // A --reply-to update's receipt says where it actually went; the recorded choice stays, for retries.
          if (threadReplyTo(p)) {
            try {
              opts.queueRepo.update({ qitemId: p.qitemId, actorSession: REPLY_TO_CHOICE_ACTOR, transitionNote: formatReplyToThreadMissing(threadTs) });
            } catch (e) {
              log(`reply-to placement for ${p.qitemId} not recorded: ${(e as Error).message}`);
            }
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

  const { attemptedPath: relayAttemptedPath, deliveredPath: relayDeliveredPath } = relayStatePaths(opts.home);
  const relayAttempted = new SeenStore(relayAttemptedPath);
  const relayDelivered = new SeenStore(relayDeliveredPath);
  const relayTransport = createRelayOutboundTransport({
    attempted: relayAttempted,
    delivered: relayDelivered,
    outboundSeen,
    fetchImpl: opts.fetchImpl,
    stopSignal: runCtl.signal,
    log,
    resolveProfile: (connectorRef) => {
      const reg = registrySurface.loadHumanRegistry(opts.home);
      const loaded = loadRelayProfiles(opts.home, reg.ok ? { entities: reg.entities } : undefined);
      if (!loaded.ok && loaded.registryError) {
        return { ok: false, reason: loaded.registryError };
      }
      const profile = loaded.get(connectorRef);
      if (!profile) {
        return { ok: false, reason: `relay profile "${connectorRef}" is not registered` };
      }
      if (!profile.ready || !profile.credentials) {
        return { ok: false, reason: profile.reason };
      }
      return {
        ok: true,
        connectorRef: profile.connectorRef,
        mode: profile.mode,
        url: profile.credentials.url,
        outboundToken: profile.credentials.outboundToken,
      };
    },
    hasAcceptedReceipt: ({ qitemId, notificationKey, deliveryId }) =>
      opts.queueRepo.hasRelayOwnerNotificationReceipt(qitemId, notificationKey, deliveryId),
    onAccepted: (info) => {
      opts.queueRepo.recordRelayOwnerNotificationAccepted({
        qitemId: info.qitemId,
        notificationKey: info.notificationKey,
        deliveryId: info.deliveryId,
        connectorRef: info.connectorRef,
        replyRef: info.replyRef,
        replyRefHash: info.refHash,
        revision: info.revision,
        episodeKey: info.episodeKey,
        level: info.level,
        kind: info.kind,
        humanIntent: info.humanIntent,
        closeUpdate: !info.digestId,
        ...(info.digestId ? { digest: info.digestId } : {}),
      });
    },
    onTransportFailed: (p, failureClass, detail) => recordTransportFailed(p, failureClass, detail, false, true),
    release: (q) => releaseRef(q),
  });

  const prepareDecision = (decision: Parameters<SubsystemDeliverFn>[0]) =>
    prepareRelayDecision(decision, {
      loadHumanRegistry: () => registrySurface.loadHumanRegistry(opts.home),
      queueRepo: opts.queueRepo,
      resolveOutcome: (p) => {
        let ruled: DeliveryDecision | null = null;
        try { ruled = p.qitemId ? decideForPayload(p, { pastUnreadableQuiet: false }) : null; } catch { ruled = null; }
        if (ruled) {
          if (ruled.outcome === "interrupt" && ruled.deferMinutes === undefined) return "interrupt";
          if (ruled.outcome === "digest") return "digest";
          return "notify";
        }
        const interrupt = Boolean(
          p.ownerNotificationLevel && ownerNotificationLevelAtLeast(p.ownerNotificationLevel, cfg.minimumLevelThatInterrupts),
        );
        return interrupt ? "interrupt" : "notify";
      },
    });

  const isRelayDecision = (decision: Parameters<SubsystemDeliverFn>[0], p: OutboundPostPayload): boolean => {
    const carry = p as RelayPayloadCarry;
    if (carry.relayConnectorRef || carry.relayEnvelope) return true;
    try {
      const reg = registrySurface.loadHumanRegistry(opts.home);
      return resolvePrimaryRelayBinding(p.destinationSession ?? decision.entityBindingRef, reg) !== null;
    } catch {
      return false;
    }
  };

  const targetDeliverFor = (decision: Parameters<SubsystemDeliverFn>[0], p: OutboundPostPayload): SubsystemDeliverFn => {
    if (!isRelayDecision(decision, p)) return deliver;
    return (d) => {
      const carry = (d.payload ?? {}) as RelayPayloadCarry;
      const readyDecision = carry.relayConnectorRef && carry.relayEnvelope ? d : prepareDecision(d);
      return relayTransport.deliver(readyDecision);
    };
  };

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
  /** The marks a later post of a re-shown ask carries, from its row (see `rePresentMarks`); empty for any other ask. */
  const rowMarks = (qitemId: string | undefined, key: string | undefined): ReturnType<typeof rePresentMarks> =>
    qitemId && key ? rePresentMarks(opts.queueRepo.listTransitions(qitemId).map((t) => t.transitionNote ?? ""), key) : {};
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
  // An earlier attempt of this exact decision may be in Slack with its response lost. A gate that would hold, trim, defer
  // or ack it (instead of handing it to delivery) resolves that first, through the reconciler. Found goes to delivery
  // unchanged, which records receipts for what was posted and never posts it again in another form. A post confirmed
  // partly in Slack (its first part found, the post not complete) also goes to delivery: only its own remaining parts
  // post, under its own part ids and in its own thread and channel, even during quiet hours. Never-attempted and absent
  // attempts, and a scan that couldn't finish or be read, haven't started: they go on through the gate like any other post. Where the gate posts,
  // delivery reconciles (keeping its at-least-once post for an unfinished scan); where it holds, the release posts it
  // after quiet. A decision that goes straight to delivery skips this.
  const resolveEarlierAttempt = async (decision: Parameters<SubsystemDeliverFn>[0]): Promise<Awaited<ReturnType<SubsystemDeliverFn>> | null> => {
    const landing = "landing" in deliver ? await (deliver as { landing: (d: typeof decision) => Promise<unknown> }).landing(decision) : "unattempted";
    if (landing === "found" || landing === "partial") return deliver(decision);
    return null;
  };

  // A digest post was decided before it was posted. By the time it is delivered (a buffered post replayed after a
  // restart, say), some members may already be owned elsewhere: posted (a receipt), or held for quiet hours (a hold
  // note, so the window's release job posts it). And if the recipient's quiet hours began in between, its routine
  // members are held now rather than posted into them; a member that has since become an escalation still posts.
  // The original decision only ever carries its original payload: if what's left differs, it goes out as a new
  // decision with its own id and receipts (enqueued before the original is acked), so a post under one id never has two
  // contents, and receipts bind to exactly the members posted under it. An earlier attempt of the original that may
  // have landed is resolved by the reconciler first. Quiet hours that can't be read aren't a quiet window: the digest
  // posts and says so, and each member's row records it. A relay, which can't show that line, posts nothing (the catch).
  const deliverDigestPost = async (decision: Parameters<SubsystemDeliverFn>[0], p: OutboundPostPayload) => {
    const relay = isRelayDecision(decision, p);
    const targetDeliver = targetDeliverFor(decision, p);
    if (!relay) {
      const settled = await resolveEarlierAttempt(decision);
      if (settled) return settled;
    }
    const recipient = (p.destinationSession ?? "").split("@")[0] ?? "";
    let quiet: ReturnType<typeof quietHoldFor>;
    let quietUnreadable: string | undefined;
    try {
      quiet = recipient ? quietHoldFor(opts.queueRepo.db, recipient, new Date()) : null;
    } catch (error) {
      if (relay) {
        // A relay's attempted digest (it may be in Slack) is retained: acked, the next flush would mint the ask again
        // from the row as it is now. A never-attempted one is acked: its members keep their digest notes, so the next
        // flush selects them again. A store check only: no Slack read on a failure path.
        if (relayTransport.wasAttempted(decision)) {
          log(`digest post ${decision.decisionId} retained: quiet hours couldn't be read: ${(error as Error).message}`);
          return { ok: false as const, class: "quiet-unreadable", detail: (error as Error).message };
        }
        log(`digest post ${decision.decisionId} not posted: quiet hours couldn't be read: ${(error as Error).message}`);
        return { ok: true as const };
      }
      quiet = null;
      quietUnreadable = (error as Error).message;
    }
    const aggregate = (p as { memberReceipts?: Array<{ qitemId: string; notificationKey: string }> }).memberReceipts;
    const members = aggregate ?? (p.qitemId ? [{ qitemId: p.qitemId, notificationKey: p.notificationKey ?? p.qitemId }] : []);
    const owned = (m: { qitemId: string; notificationKey: string }) =>
      opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(m.qitemId, m.notificationKey)
      || opts.queueRepo.listTransitions(m.qitemId).some((t) => (t.transitionNote ?? "").startsWith("delivery-decision: quiet-hold ")
        && (t.transitionNote ?? "").split(/\s+/).includes(`notification_key=${m.notificationKey}`));
    const jobsRepo = new WatchdogJobsRepository(opts.queueRepo.db);
    const escalation = (m: { qitemId: string }) => {
      const row = opts.queueRepo.getById(m.qitemId);
      return !!row && row.humanIntent !== "update" && isEscalationClass(row.tags);
    };
    const kept = members.filter((m) => {
      if (owned(m)) return false;
      if (!quiet) return true;
      if (escalation(m)) return true;
      holdForQuiet({ queueRepo: opts.queueRepo, jobsRepo, qitemId: m.qitemId, entityId: recipient, hold: { ...quiet!, notificationKey: m.notificationKey } });
      return false;
    });
    if (kept.length === members.length) {
      // A digest holding a re-shown ask whose earlier attempt may be in Slack says it may repeat, and an attempt log that
      // can't be read doesn't hold it. A kept digest decides the same when it comes back here.
      const repeat = !relay && members.some((m) => rowMarks(m.qitemId, m.notificationKey).possibleRepeat);
      if (quietUnreadable !== undefined) {
        log(`digest post ${decision.decisionId} posting: its recipient's quiet hours couldn't be read (${quietUnreadable})`);
        for (const m of members) noteQuietUnreadable(opts.queueRepo, m.qitemId, m.notificationKey, quietUnreadable);
      }
      const marks = { ...(repeat ? { possibleRepeat: true } : {}), ...(quietUnreadable !== undefined ? { quietUnreadable: true } : {}) };
      return targetDeliver(Object.keys(marks).length > 0 ? { ...decision, payload: { ...p, ...marks } } : decision); // the original, as it is
    }
    if (kept.length === 0 || !aggregate) return { ok: true as const }; // nothing left to post under it
    const keptIds = new Set(kept.map((m) => m.qitemId));
    const body = String(p.body ?? "").split("\n").filter((line) => [...keptIds].some((id) => line.endsWith(`[${id}]`))).join("\n");
    const summary = String(p.summary ?? "").replace(/— \d+ item\(s\)/, `— ${kept.length} item(s)`);
    const keptId = `${decision.decisionId}:kept:${createHash("sha256").update(kept.map((m) => m.notificationKey).sort().join(",")).digest("hex").slice(0, 16)}`;
    // Durable first: the new decision is in the buffer before the original is acked (returning ok). A crash between the
    // two replays the original, which computes the same kept set and id; the dispatcher accepts the pending id once.
    const { relayConnectorRef: _rc, relayEnvelope: _re, relayRevision: _rr, ...restPayload } = p as RelayPayloadCarry;
    const res = selfDispatch(keptId, { ...restPayload, memberReceipts: kept, body, summary });
    return res.ok ? { ok: true as const } : { ok: false as const, class: "kept-dispatch-refused", detail: res.error };
  };

  const engineDeliver: SubsystemDeliverFn = async (decision) => {
    let p = ((decision as { payload?: unknown }).payload ?? {}) as OutboundPostPayload & { deliveryDeferralFire?: boolean };
    const relay = isRelayDecision(decision, p);
    const targetDeliver = targetDeliverFor(decision, p);
    if (relay) {
      let alreadyAttempted = false;
      try {
        alreadyAttempted = relayTransport.wasAttempted(decision);
      } catch {
        return targetDeliver(decision);
      }
      if (alreadyAttempted) {
        return targetDeliver(decision);
      }
    }
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
    if ((p as { deliveryDigestPost?: boolean }).deliveryDigestPost) return deliverDigestPost(decision, p);
    // Releasing an ask held for quiet hours: it posts as itself, never re-consulted (that would digest C and D again). A
    // receipt means it already did. A release can wait in the buffer (and be replayed after a restart), so it is
    // re-checked here, at post time, against the recipient's quiet, the row and the posting threshold as they are now.
    if ((p as { quietRelease?: boolean }).quietRelease) {
      const key = p.notificationKey ?? p.qitemId;
      if (p.qitemId && opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(p.qitemId, key)) {
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
      if (!relay) {
        const settled = await resolveEarlierAttempt(decision);
        if (settled) return settled;
      }
      const verdict = !p.qitemId ? "post" : await confirmReleaseAtPost({
        queueRepo: opts.queueRepo,
        jobsRepo: new WatchdogJobsRepository(opts.queueRepo.db),
        home: opts.home,
        registry: { loadHumanRegistry: () => registrySurface.loadHumanRegistry(opts.home) },
        entityId: (p.destinationSession ?? "").split("@")[0] ?? "",
        qitemId: p.qitemId,
        notificationKey: key,
        // Quiet hours that can't be read at release don't hold it: it posts and says so. A relay can't, so it waits.
        pastUnreadableQuiet: !relay,
      });
      if (verdict === "post" || verdict === "post-quiet-unreadable") {
        // A re-shown ask whose earlier attempt may be in Slack keeps saying so when its release posts it, and an attempt
        // log that still can't be read doesn't hold the release. (The release has just re-checked its state.)
        const { possibleRepeat } = relay ? {} : rowMarks(p.qitemId, key);
        if (verdict === "post-quiet-unreadable") log(`quiet release ${decision.decisionId} posting: its recipient's quiet hours couldn't be read`);
        const marks = { ...(possibleRepeat ? { possibleRepeat } : {}), ...(verdict === "post-quiet-unreadable" ? { quietUnreadable: true } : {}) };
        return targetDeliver(Object.keys(marks).length > 0 ? { ...decision, payload: { ...p, ...marks } } : decision);
      }
      // Declined (the row says why) or couldn't be checked (nothing written): either way nothing posts now. Acking is
      // safe because the window's release job owns redelivery until the ask has a receipt or a disposition; keeping it
      // buffered would wait for a restart and block the job's own re-dispatch of the same decision id.
      releaseRef(p.qitemId);
      return { ok: true as const };
    }
    // An open ask shown again after enable (`rig slack post-open-asks`): checked here, at post time, against the row, the
    // recipient and the posting threshold as they are now, then delivered like any fresh ask below (the delivery rules,
    // quiet hours, digest, thread). One that's no longer current, or can't be checked, posts nothing and its row says why,
    // unless an earlier attempt of it may already be in Slack (below).
    if (decision.decisionId.startsWith(RE_PRESENT_DECISION_PREFIX) && p.qitemId) {
      const key = p.notificationKey ?? p.qitemId;
      if (opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(p.qitemId, key)) {
        releaseRef(key);
        return { ok: true as const };
      }
      // Whether an earlier attempt can be in Slack is read from the attempt log, which the landing check below reads
      // leniently. A log that exists but can't be read is unknown, not "never attempted": it counts as an earlier attempt
      // that may be in Slack, and never as a reason to write a not-posted record.
      let attemptLogUnreadable: string | null = null;
      try {
        (relay ? relayAttempted : attempted).statuses();
      } catch (error) {
        attemptLogUnreadable = (error as Error).message;
      }
      // An earlier attempt of this decision found in Slack goes to delivery, which records it.
      const landing = attemptLogUnreadable ? "maybe"
        : !relay && "landing" in deliver ? await (deliver as { landing: (d: typeof decision) => Promise<string> }).landing(decision) : "unattempted";
      if (landing === "found" || landing === "partial") return targetDeliver(decision);
      const regForVerdict = registrySurface.loadHumanRegistry(opts.home);
      const alertsForVerdict =
        regForVerdict.ok || regForVerdict.noHumans
          ? await ports.listHumanAlerts({ minimumLevel: cfg.minimumLevelThatPosts })
          : undefined;
      const verdict = await currentAskVerdict({
        queueRepo: opts.queueRepo,
        home: opts.home,
        registry: { loadHumanRegistry: () => regForVerdict },
        entityId: (p.destinationSession ?? "").split("@")[0] ?? "",
        qitemId: p.qitemId,
        notificationKey: key,
        ...(alertsForVerdict ? { alerts: alertsForVerdict } : {}),
      });
      // A definite verdict is positive evidence: this is no longer the person's current ask, so it doesn't post. One whose
      // earlier attempt Slack couldn't rule out may already be posted: it's never recorded as not posted, and it stays in
      // the buffer, so its replay decides again (and reconciles) instead of the uncertainty being dropped.
      if (verdict.kind === "disposition") {
        if (landing === "maybe") {
          log(`re-shown ${decision.decisionId} retained: an earlier attempt may be in Slack, and it can't go on now (${verdict.reason})`);
          return attemptLogUnreadable
            ? { ok: false as const, class: "re-present-attempt-log-unreadable", detail: attemptLogUnreadable }
            : { ok: false as const, class: "re-present-earlier-attempt-unconfirmed", detail: verdict.reason };
        }
        noteRePresentNotPosted(opts.queueRepo, p.qitemId, key, verdict);
        releaseRef(key);
        return { ok: true as const };
      }
      // What OpenRig can't tell isn't a reason to hold the ask: it goes on through the person's delivery settings (a
      // readable quiet window still holds it), and the post says what couldn't be checked. An attempt log that can't be
      // read can't record the new attempt either, so the bound is the process: a kept decision replays only when the
      // gateway starts, and the dispatcher takes a pending id once. The relay posts no such line, so it waits, as before.
      const unconfirmed: RePresentUnconfirmed[] = [
        ...(attemptLogUnreadable || (landing === "maybe" && verdict.kind === "unavailable") ? ["attempt" as const] : []),
        ...(verdict.kind === "unavailable" ? ["state" as const] : []),
      ];
      if (unconfirmed.length > 0 && relay) {
        if (landing === "maybe") {
          const why = attemptLogUnreadable ?? (verdict.kind === "unavailable" ? verdict.detail : "an earlier attempt may be in Slack");
          log(`re-shown ${decision.decisionId} retained: an earlier attempt may be in Slack, and it can't go on now (${why})`);
          return attemptLogUnreadable
            ? { ok: false as const, class: "re-present-attempt-log-unreadable", detail: attemptLogUnreadable }
            : { ok: false as const, class: "re-present-earlier-attempt-unconfirmed", detail: why };
        }
        noteRePresentNotPosted(opts.queueRepo, p.qitemId, key, verdict as Exclude<typeof verdict, { kind: "post" }>);
        releaseRef(key);
        return { ok: true as const };
      }
      if (unconfirmed.length > 0) {
        const why = [attemptLogUnreadable ? `the attempt log couldn't be read (${attemptLogUnreadable})` : null,
          verdict.kind === "unavailable" ? `the ask's state couldn't be checked (${verdict.detail})` : null].filter(Boolean).join("; ");
        log(`re-shown ${decision.decisionId} goes on to delivery, marked: ${why}`);
        noteRePresentUnconfirmed(opts.queueRepo, p.qitemId, key, unconfirmed, why);
        p = { ...p, ...(unconfirmed.includes("attempt") ? { possibleRepeat: true } : {}), ...(unconfirmed.includes("state") ? { stateUnconfirmed: true } : {}) };
        decision = { ...decision, payload: p };
      }
    }
    if (p.deliveryDeferralFire) {
      const fireKey = p.notificationKey ?? p.qitemId;
      if (p.qitemId && opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(p.qitemId, fireKey)) {
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
      // A deferred re-shown ask keeps its marks when the fire posts it: the fire checks nothing again.
      const marks = relay ? {} : rowMarks(p.qitemId, fireKey);
      return targetDeliver(Object.keys(marks).length > 0 ? { ...decision, payload: { ...p, ...marks } } : decision);
    }
    // A post confirmed partly in Slack finishes without consulting quiet hours, so it is resolved before the decision
    // (which reads them). Only a started multipart post is checked here, from the stores first, so an ordinary
    // retry isn't scanned twice; any other attempted decision is resolved at the gate below.
    const started = !relay && "unfinished" in deliver && (deliver as { unfinished: (d: typeof decision) => boolean }).unfinished(decision);
    if (started) {
      const settled = await resolveEarlierAttempt(decision);
      if (settled) return settled;
    }
    let ruled: (DeliveryDecision & { quietUnreadable?: string }) | null;
    try {
      // Quiet hours that can't be read are decided past (see decideForPayload), so a re-shown ask goes through the
      // person's known settings like any other. What still throws here is the decision itself, which isn't permission.
      ruled = p.qitemId ? decideForPayload(p, { pastUnreadableQuiet: !relay }) : null;
    } catch (error) {
      // An attempted decision (it may be partly or wholly in Slack) is retained and nothing posts: acking it would drop
      // the post's missing parts and let the sweep offer the ask again under a new id, posting it from the start. Its
      // replay decides again once the quiet state reads. A store check only: no Slack read on a failure path.
      const wasAttempted = relay
        ? relayTransport.wasAttempted(decision)
        : "attempted" in deliver && (deliver as { attempted: (d: typeof decision) => boolean }).attempted(decision);
      if (wasAttempted) {
        log(`delivery decision for attempted ${decision.decisionId} couldn't be made; retained: ${(error as Error).message}`);
        return { ok: false as const, class: "quiet-unreadable", detail: (error as Error).message };
      }
      // The decision couldn't be made (for example the person's quiet hours couldn't be read): post nothing and record
      // nothing. Releasing the in-flight guard lets the outbound sweep offer this still-unseen ask again and decide afresh.
      // (A relay's unreadable quiet hours land here: it can't show the line that would let it post.)
      log(`delivery decision for ${p.qitemId} deferred: ${(error as Error).message}`);
      // A re-shown ask is seen, so no sweep offers it again: its row says it wasn't posted, and the person who ran
      // `rig slack post-open-asks` runs it again once the state reads (same decision id).
      if (decision.decisionId.startsWith(RE_PRESENT_DECISION_PREFIX) && p.qitemId) {
        noteRePresentNotPosted(opts.queueRepo, p.qitemId, p.notificationKey ?? p.qitemId, { kind: "unavailable", detail: (error as Error).message });
      }
      // Released by notification key, the guard's own key: nothing marks this ask seen, so the next sweep must see it.
      releaseRef(p.notificationKey ?? p.qitemId!);
      return { ok: true as const };
    }
    if (!relay && !started && ruled && (ruled.outcome === "log" || (ruled.outcome === "hold" && ruled.quietHold)
      || ruled.outcome === "digest" || ruled.deferMinutes !== undefined)) {
      const settled = await resolveEarlierAttempt(decision);
      if (settled) return settled;
    }
    if (ruled) {
      recordTerminationOnce(p, ruled);
      const episodeKey = p.notificationKey ?? p.qitemId;
      if (ruled.outcome === "log") {
        outboundSeen.mark(episodeKey, "log-class-contained");
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
      if (ruled.outcome === "hold" && ruled.quietHold) {
        // Quiet hours: recorded on the row with its window, occurrence and revision; the release job posts it later.
        holdForQuiet({
          queueRepo: opts.queueRepo,
          jobsRepo: new WatchdogJobsRepository(opts.queueRepo.db),
          qitemId: p.qitemId,
          entityId: (p.destinationSession ?? "").split("@")[0] ?? "unknown",
          hold: { ...ruled.quietHold, notificationKey: episodeKey },
        });
        outboundSeen.mark(episodeKey, "quiet-held");
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
          return targetDeliver(decision);
        }
        outboundSeen.mark(episodeKey, "interrupt-deferred");
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
      if (ruled.quietUnreadable !== undefined) {
        // It posts now, unmentioned, and says the person's quiet hours couldn't be read; the row records that first, and
        // what became of the post is its own receipt. A replay decides again from a fresh read.
        log(`${decision.decisionId} posting: ${p.qitemId}'s recipient's quiet hours couldn't be read (${ruled.quietUnreadable})`);
        noteQuietUnreadable(opts.queueRepo, p.qitemId, episodeKey, ruled.quietUnreadable);
        return targetDeliver({ ...decision, payload: { ...p, quietUnreadable: true } });
      }
    }
    return targetDeliver(decision);
  };

  const wire = buildInProcessWire({
    home: opts.home,
    ops: anyOutboundEnabled ? [OUTBOUND_OP] : [],
    ...(anyOutboundEnabled ? { prepare: prepareDecision } : {}),
    deliver: anyOutboundEnabled ? engineDeliver : deliver,
    log,
  });
  selfDispatch = (decisionId, payload) =>
    wire.dispatcher.dispatch(OUTBOUND_OP, String((payload as { destinationSession?: string }).destinationSession ?? ""), payload, { decisionId });

  // Services are CONSTRUCTED here but started only via startServices() (post-bind, index.ts):
  // composing a daemon must never dial Slack or start pollers — the createDaemon-in-tests
  // hermeticity rule, same as every monitor in the supervision tree.
  const stops: Array<() => void> = [];
  const starts: Array<() => void> = [];
  const settlement = outboundReady ? new SlackAskSettlement({ queue: opts.queueRepo, token: bot!, fetchImpl: opts.fetchImpl, log }) : null;
  if (settlement) {
    starts.push(() => settlement.start());
    stops.push(() => settlement.stop());
  }
  let inboundHandle: SocketInboundHandle | undefined;
  let recovery: SlackRecovery | undefined;
  // Recovery covers the channels this machine owns and the threads tracked in them. The configured
  // default channel keeps its established seed; a channel newly recovered starts at adoption.
  const buildRecovery = (router: InboundRouter, seedDefault: boolean, relayed = false): SlackRecovery => new SlackRecovery({
    channels: ownedRecoveryChannels(cfg).map((channel) => (seedDefault && channel === cfg.channel ? { channel } : { channel, seed: "adoption" as const })),
    token: bot,
    stateDir: stateDir(opts.home),
    router,
    trackedThreads: (channels, closedSince) => threadMap.trackedForRecovery(channels, closedSince),
    fetchImpl: opts.fetchImpl,
    ...(relayed ? { relayed: true } : {}),
  });

  if (anyOutboundEnabled) {
    const driverQueue = outboundReady
      ? ports
      : {
          listHumanAlerts: async (filter: Parameters<typeof ports.listHumanAlerts>[0]) => {
            const alerts = await ports.listHumanAlerts(filter);
            try {
              const reg = registrySurface.loadHumanRegistry(opts.home);
              return alerts.filter((alert) => resolvePrimaryRelayBinding(alert.destinationSession, reg) !== null);
            } catch {
              return [];
            }
          },
        };
    const driver = new SlackOutboundDriver({
      home: opts.home,
      queue: driverQueue,
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
            if (root?.state !== "open" || root.conversationId !== change.qitemId || !isRequestToHuman(opts.queueRepo, opts.queueRepo.getById(change.qitemId), root)) return;
            void closeRequest(lifecycle, root, "canceled-by-seat", "daemon@kernel").catch((e) => log(`request ${change.qitemId} close failed: ${(e as Error).message}`));
          });
        }
      });
      log("slack outbound driver started (subsystem path)");
    });
    stops.push(() => { unsubscribeOutbound?.(); driver.stop(); });
  }

  // A machine of a shared app receives its channels' events from the hub (routes/gateway.ts).
  let acceptForwarded: ((env: SocketEnvelope) => Promise<{ status: string; reason?: string }>) | undefined;
  let relayedReceived = 0; // envelopes a hub relayed here since this wire was built
  const forwardProblems = forwardChannelProblems(cfg);
  if (cfg.forwardChannels?.length && forwardProblems.length) log(`slack forwarding OFF: ${forwardProblems.join("; ")}`);
  const forwarding = Boolean(cfg.forwardChannels?.length && forwardProblems.length === 0 && inboundReady);

  // The router runs whenever the connector is enabled with a token: with the app-level token it
  // also holds the Socket Mode connection; without it, this machine takes its channels' events from
  // the hub that holds the shared app's connection.
  let router: InboundRouter | undefined;
  if (inboundReady || outboundReady) {
    const inboundSeen = new SeenStore(path.join(stateDir(opts.home), "slack-inbound-seen.jsonl"));
    const registry: RegistrySurface = registrySurface;
    const built = (router = new InboundRouter({
      queue: ports,
      seen: inboundSeen,
      deadLetter: dead,
      destination: inbound.destination,
      reactions: cfg.reactions === "off" ? "off" : "route",
      resolveSender,
      // S10 — deterministic thread routing: mapped thread → exactly the mapped seat; unmapped
      // or human-initiated → the configured orchestrator slot as an unrouted-signal row.
      resolveRoute: makeThreadRouteResolver({
        map: threadMap,
        unroutedDestination: inbound.destination,
        log,
        // A person's top-level message in a channel the map routes: its `inbound` seat or its rig's representative.
        resolveChannelDestination: (channel) =>
          resolveInboundChannelDestination(cfg, channel, (rig) => resolveRigRepresentative(opts.queueRepo.db, rig)),
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
      // A person's top-level message is its answer's root, marked as theirs, and stamped on their row
      // like a posted root, so a rebuild restores it as theirs.
      mintThread: (m) => {
        threadMap.open({ ...m, origin: "person" });
        try {
          opts.queueRepo.update({
            qitemId: m.conversationId,
            actorSession: "daemon@kernel",
            transitionNote: formatPostedStamp({ ...m, messageTs: m.threadTs, origin: "person" }),
          });
        } catch (e) {
          log(`thread stamp failed for ${m.conversationId}: ${(e as Error).message}`);
        }
      },
      recordArrivalThread: (input) => {
        try {
          opts.queueRepo.update({ qitemId: input.qitemId, actorSession: REPLY_TO_CHOICE_ACTOR, transitionNote: formatArrivalThread(input) });
        } catch (e) {
          log(`arrival thread record failed for ${input.qitemId}: ${(e as Error).message}`);
        }
      },
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
      actionDeadLetter: deadActions,
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
      // Named-bot delivery: wired only with a valid botInbox and the bot token bots.info needs.
      ...(cfg.botInbox && bot && botInboxProblems(cfg).length === 0 ? {
        botInbox: {
          channel: cfg.botInbox.channel,
          destination: cfg.botInbox.destination,
          bots: cfg.botInbox.bots,
          lookupBot: (botId: string) => lookupBotApp(bot, botId, opts.fetchImpl),
        },
      } : {}),
      forward: {
        hostFor: (channel: string | undefined) => forwarding ? cfg.forwardChannels!.find((f) => f.channel === channel)?.host ?? null : null,
        send: makeEnvelopeForwarder({ fetchImpl: opts.fetchImpl as typeof fetch | undefined, loadRegistry: opts.loadHostRegistry }),
      },
      forwardDeadLetter: deadForwards,
      log,
    }));
    if (cfg.botInbox && (!bot || botInboxProblems(cfg).length > 0)) {
      log(`slack bot inbox OFF: ${!bot ? "SLACK_BOT_TOKEN unresolved (bots.info needs it)" : botInboxProblems(cfg).join("; ")}`);
    }
    // An envelope the hub relayed is handled here and never relayed again.
    acceptForwarded = (env) => {
      relayedReceived++;
      // A relayed event adopts its channel for recovery, from this local receipt time (only a channel configured here).
      if (!inboundReady) recovery?.adoptRelayed(envelopeChannel(env), Date.now());
      return handleEnvelope(env, () => {}, built, log, undefined, { relayed: true });
    };
    if (!inboundReady) {
      // No socket here, so no socket-driven retry: drain this machine's own retained events on the
      // same five-minute cadence the socket uses, once services start. The hub relays this machine's
      // channels' live events; each configured channel the hub has relayed here is also recovered,
      // from its first relayed event, so this machine, which owns it, gets what nobody received.
      const relayedRecovery = (recovery = buildRecovery(built, false, true));
      const recover = () => { void relayedRecovery.run().catch(() => log("channel recovery failed; checkpoint retained")); };
      let retryTimer: ReturnType<typeof setInterval> | undefined;
      starts.push(() => {
        relayedRecovery.initialize(); // channels adopted before a restart resume from their saved coverage
        retryTimer = setInterval(() => {
          recover();
          void built.retryDeadLetters().catch((e) => log(`slack dead-letter retry failed: ${(e as Error).message}`));
        }, opts.inboundRetryIntervalMs ?? 5 * 60 * 1000);
        retryTimer.unref?.();
      });
      stops.push(() => { relayedRecovery.stop(); if (retryTimer) clearInterval(retryTimer); });
    }
  }

  if (inboundReady && router) {
    let unsubscribe: (() => void) | undefined;
    starts.push(() => {
      void appUserId();
      for (const c of channels) void humansIn(c.id);
    });
    starts.push(() => {
      unsubscribe = opts.queueRepo.events.subscribe((event) => {
        if (event.type === "queue.updated" || event.type === "queue.handed_off") void syncRootDone(event.qitemId);
        if (event.type === "queue.created" || event.type === "queue.claimed" || event.type === "queue.unclaimed" || event.type === "queue.handed_off"
          || (event.type === "queue.updated" && event.fromState !== event.toState)) syncReceipt(event.qitemId);
      });
    });
    stops.push(() => unsubscribe?.());
    const socketRouter = router;
    const receipts = new InboundReceiptStore(path.join(stateDir(opts.home), "slack-inbound-receipts.jsonl"));
    recovery = buildRecovery(socketRouter, true);
    starts.push(() => {
      recovery!.initialize(); // persist the once-only floor before any live events
      inboundHandle = startSocketInbound(app!, socketRouter, {
        fetchImpl: opts.fetchImpl,
        wsFactory: opts.wsFactory,
        retryIntervalMs: opts.inboundRetryIntervalMs,
        inboundMaxConnects: opts.inboundMaxConnects,
        receipts,
        recovery,
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
    ...(acceptForwarded ? { acceptForwarded } : {}),
    releaseOutboundKey: (key: string) => releaseRef(key),
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
      ...(settlement ? { settlement: settlement.status() } : {}),
      inboundRouting,
      recovery: recovery?.status() ?? { state: "unavailable", reason: "inbound-not-configured" },
      inbound: inboundHandle?.status() ?? { state: inboundReady ? "not-started" : "not-configured", generation: 0, reconnects: 0 },
      // Durable inbound custody across event, click and relay files, even when inert.
      // Count records, not distinct messages; unreadable storage is null/unknown.
      ...deadLetterBacklogFields(dead, deadActions, deadForwards),
      relayAttemptsInFlight: router?.getRelayAttemptsInFlight() ?? 0,
      // A machine with no connection of its own can take events a hub relays here; whether a hub does is
      // the hub's configuration, so this says only that it can, and how many have arrived.
      ...(router && !inboundReady ? { relayedInbound: { accepting: true, received: relayedReceived } } : {}),
      ...(forwarding ? { forwardChannels: cfg.forwardChannels!.length } : {}),
    }),
  };
}
