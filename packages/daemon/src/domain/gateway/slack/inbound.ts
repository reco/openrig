// Slice-11 slack-connector — INBOUND orchestration (Socket Mode → queue).
//
// Locked items: 4 (human message → durable qitem on operator-agent@kernel,
// config-overridable), 8 (never-drop: fast-ack the transport, dead-letter every
// event that fails to land BEFORE returning, seen-mark ONLY after the durable
// qitem exists, in-flight per-event-ts dedup), plus loop-safety (never ingest
// bot/own posts) and T1076 (file/image events ignored CLEANLY in v1).
//
// The WebSocket/ack transport lives in the daemon's socket-inbound service (S10: in-daemon
// subsystem — the CLI runner retired); this module is the pure, fully-testable core:
// shouldIngest (filter), route (land + dedup + dead-letter), retryDeadLetters, and
// handleEnvelope (fast-ack + dispatch). S10 re-home: the queue seam is an in-process PORT
// (queue-access.ts adapts QueueRepository) — the rig-CLI shell-out bridge retired with the
// relay runners; the durability semantics around it are unchanged.
import type { SeenStore, DeadLetterStore, DeadLetterEntry } from "./state-store.js";
import type { InboundQueuePort } from "./queue-access.js";
import { createHash } from "node:crypto";
import { ADMITTED_EVENT_TYPES, REACTION_EVENT_TYPES } from "./capabilities.js";
import { escapeSlackText, parseConfirmAction, parseQuestionAction, redactSecrets, type ConfirmOutcome } from "./message.js";
import { formatHumanAnswers, unansweredQuestions, type RecordHumanAnswerResult } from "../../human-questions.js";

export interface SlackEvent {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  /** S10 thread routing: present on a threaded reply (= the PARENT root's ts). Absent on a
   *  top-level channel message. The affordance discriminator: thread_ts==ts parent,
   *  thread_ts!=ts reply, absent plain. */
  thread_ts?: string;
  channel?: string;
  files?: unknown[];
  /** reaction_added: the emoji name and the message it was added to. */
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
  /** Internal history provenance, retained across dead-letter retry. */
  recoveredAfterGap?: boolean;
}

/** #193 — the parts of a Socket Mode `block_actions` payload (a button click) we read. */
export interface SlackBlockActions {
  type?: string;
  user?: { id?: string };
  channel?: { id?: string };
  container?: { message_ts?: string; thread_ts?: string; channel_id?: string };
  message?: { ts?: string; thread_ts?: string };
  actions?: Array<{ block_id?: string; action_id?: string; value?: string; action_ts?: string }>;
}

/** Phase 1 — the decision a Confirm offer replies to and its stated reading, for the asked human only. */
export type ConfirmOffer = (input: { offerQitemId: string; actorSession: string }) =>
  | { ok: true; decisionQitemId: string; reading: string; decided: boolean; won: boolean }
  | { ok: false; reason: string };

/** Phase 1 — what a ✅ on a message decides, as classified against our own records. */
export type ReactionTarget =
  | { kind: "confirm"; offerQitemId: string; threadTs: string }
  | { kind: "answer"; decisionQitemId: string; threadTs: string; text: string };

export const CHECK_REACTION = "white_check_mark";
/** The received Slack message's identity on its inbound row, written by the gateway only. */
export const SLACK_MESSAGE_TAG = "slack-message:";
const FEEDBACK_REACTIONS: Record<string, "+1" | "-1"> = { "+1": "+1", thumbsup: "+1", "-1": "-1", thumbsdown: "-1" };

/** Slack message ts is unique within a channel, so every inbound id uses both fields. */
export function inboundQitemIdFor(channel: string | undefined, ts: string | undefined): string {
  return `qitem-slack-inbound-${createHash("sha256").update(`${channel ?? "-"}:${ts ?? "-"}`).digest("hex").slice(0, 20)}`;
}

export type RecordHumanAnswer = (input: { qitemId: string; actorSession: string; questionId: string; optionId: string }) => RecordHumanAnswerResult;

/** The root message a click was made on: buttons live on the decision's root post, whose ts is
 *  the thread map's key (a click inside a thread would carry that thread's root instead). */
export function clickedRootTs(payload: SlackBlockActions): string | undefined {
  return payload.container?.thread_ts ?? payload.message?.thread_ts ?? payload.container?.message_ts ?? payload.message?.ts;
}

export type InboundDisposition = "accepted" | "ignored" | "refused" | "dead-lettered" | "handler-failed";

/**
 * Loop-safety + non-ingestible ignore. Ingest genuine human messages — text,
 * and (OPR.0.5.6.2, replacing the T1076 v1 ignore) file-bearing drops: a
 * `file_share` subtype with files[] is THE shape a human upload arrives as,
 * and a pure drop legitimately has no caption, so empty text is admissible
 * when files are present. Loop safety is untouched: bot posts and every other
 * subtype (edits/joins) stay rejected, and a false return remains a clean
 * skip, never a crash or partial ingestion.
 */
/** P28 — the rejection BRANCH, as data. The ignore path used to log type/subtype/files, which
 *  are precisely the fields that have all PASSED when a message dies on bot_id or on
 *  missing-user/empty-text — so a silent discard could not be explained, and with `channels:read`
 *  ungranted there was no read that could even name the source conversation. This is the SINGLE
 *  definition of the ingest decision; `shouldIngest` is a thin wrapper over it so the branch logic
 *  has one origin and the log can never drift from the behaviour it describes.
 *  ("files" left the union at OPR.0.5.6.2: file-bearing events are now work, not noise.) */
export type IngestReason = "type" | "bot_id" | "subtype" | "no-user" | "empty-text";

export function ingestDecision(ev: SlackEvent): { ingest: true } | { ingest: false; reason: IngestReason } {
  const hasFiles = Array.isArray(ev.files) && ev.files.length > 0;
  if (!ev.type || !ADMITTED_EVENT_TYPES.includes(ev.type)) return { ingest: false, reason: "type" };
  if (ev.bot_id) return { ingest: false, reason: "bot_id" }; // never ingest our own / any bot post
  // OPR.0.5.6.2: `file_share` WITH files is the human-upload shape and is admitted;
  // every other subtype (edits, joins, …) stays rejected exactly as before.
  if (ev.subtype && !(ev.subtype === "file_share" && hasFiles)) return { ingest: false, reason: "subtype" };
  if (!ev.user) return { ingest: false, reason: "no-user" };
  // A pure file drop has no caption: empty text is admissible iff files ride along.
  if ((!ev.text || !ev.text.trim()) && !hasFiles) return { ingest: false, reason: "empty-text" };
  return { ingest: true };
}

/** OPR.0.5.6.2 — the inbound file-transfer PORT: injected so this core stays
 *  pure/testable; the subsystem wires the real download+store implementation
 *  (see makeInboundFilePort). Results are per-file and NAMED both ways. */
export interface StoredInboundFile { name: string; localPath: string; mimetype?: string; bytes: number }
export interface FailedInboundFile { name: string; error: string }
export interface InboundFileResult { stored: StoredInboundFile[]; failed: FailedInboundFile[] }
export interface InboundFilePort { transfer(files: unknown[], eventTs: string, eventChannel?: string): Promise<InboundFileResult> }

const EXPLICIT_ANSWER = /^\s*answer:\s*([\s\S]*?)\s*$/i;
const EXPLICIT_CANCEL = /^\s*cancel\s*(?::\s*([\s\S]*?))?\s*$/i;

/** The decision text of an explicit `answer:` reply, or null when the text is not one. */
export function explicitAnswer(text: string | undefined): string | null {
  const answer = EXPLICIT_ANSWER.exec(text ?? "")?.[1];
  return answer ? answer : null;
}

export function shouldIngest(ev: SlackEvent): boolean {
  return ingestDecision(ev).ingest;
}

/** A6 v3: the sender-admission verdict. An inbound Slack message may become a human-provenance
 *  qitem ONLY if its sender resolves to a REGISTERED human (admit-iff-registered); the stamped
 *  `source` is that human's canonical ref (never a raw platform id). An unregistered sender — or a
 *  registry that itself failed to load — is REFUSED with LOUD teaching, never a fabricated seat. */
export type InboundSenderResolution =
  | { admitted: true; source: string }
  | { admitted: false; teaching: string };

export interface InboundDeps {
  queue: InboundQueuePort;
  seen: SeenStore;
  deadLetter: DeadLetterStore<SlackEvent>;
  destination: string; // first-class config; default operator-agent@kernel
  /** A6 v3 registration gate. Resolves ev.user -> a registered human (or refuses). Injected so
   *  this core stays pure/testable; the subsystem wires it via the daemon human-registry resolver. */
  resolveSender: (slackUserId: string) => InboundSenderResolution;
  /** S10 thread routing (deterministic, zero inference): resolve the destination + tags for an
   *  admitted event. Absent → every event lands on the static `destination` (the pre-routing
   *  shape, and the fallback the tests pin). */
  resolveRoute?: (ev: SlackEvent) => { destination: string; tags?: string[]; correlationQitemId?: string };
  /** Continue an exact human gate through the existing Mission Control resolve primitive. */
  resolveHumanReply?: (input: { qitemId: string; actorSession: string; decision: string }) => Promise<"resolved" | "already-resolved" | "not-applicable">;
  /** Phase 1: only an explicit `answer:` reply resolves; other typed replies are conversation.
   *  Absent or false keeps the #96 contract (any typed reply answers). */
  explicitAnswersOnly?: boolean;
  /** #193 — record a clicked answer on the decision the clicked message belongs to. */
  recordHumanAnswer?: RecordHumanAnswer;
  /** Phase 1 — look up a clicked Confirm offer. */
  confirmOffer?: ConfirmOffer;
  /** Phase 1 — an explicit `cancel` in a request's thread; only the asked human's closes it. */
  cancelRequest?: (input: { conversationId: string; actorSession: string; reason: string }) => Promise<"closed" | "not-authorized" | "not-applicable">;
  /** Phase 1 — show the human their message was received (a 👀 on it). Best-effort. */
  markReceived?: (input: { channel: string; ts: string; qitemId: string }) => Promise<void>;
  /** Phase 1 — replace a fully answered decision's button rows with its answers. Best-effort. */
  retireQuestionButtons?: (input: { channel: string; messageTs: string; qitemId: string }) => Promise<void>;
  /** Phase 1 — replace a confirmed offer's button with its reading. Best-effort. */
  retireConfirmOffer?: (input: { channel: string; messageTs: string; offerQitemId: string; outcome: ConfirmOutcome }) => Promise<void>;
  /** Phase 1 — record 👍/👎 on one of our messages from its asked human; 👎 also asks the seat
   *  for an alternative. Feedback never decides anything. */
  recordFeedback?: (input: { channel: string; messageTs: string; actorSession: string; reaction: "+1" | "-1"; key: string }) => Promise<"recorded" | "not-applicable">;
  /** Phase 1 — record that this offer's click resolved its decision (so only it shows Confirmed). */
  markConfirmWon?: (offerQitemId: string) => void;
  /** Phase 1 — classify the message an admitted human added ✅ to; null = it decides nothing. */
  reactionTarget?: (input: { channel: string; messageTs: string; actorSession: string }) => ReactionTarget | null;
  /** #193 — clicks whose continuation (reply row + resolve) failed; retried with the event
   *  dead-letters. Absent → a failed click is only logged. */
  actionDeadLetter?: DeadLetterStore<SlackBlockActions>;
  /** #193 — tell the human in the decision's thread what a click did. Best-effort. */
  acknowledgeAnswer?: (input: { channel?: string; threadTs: string; text: string }) => Promise<void>;
  /** OPR.0.5.6.2 — inbound file transfer. Absent with a file-bearing event →
   *  every file is a NAMED failure on the row ("transfer unavailable"), never
   *  a silent drop of message or file. */
  files?: InboundFilePort;
  sourceLabel?: string;
  log?: (msg: string) => void;
}

export class InboundRouter {
  private readonly inflight = new Set<string>(); // same-channel message identity double-dispatch guard
  private readonly confirmChains = new Map<string, Promise<unknown>>(); // one Confirm at a time per decision
  private retryPass: Promise<{ retried: number; landed: number }> | undefined;
  constructor(private readonly deps: InboundDeps) {}

  private summaryOf(ev: SlackEvent, transfer?: InboundFileResult | null, correlationQitemId?: string, conversation = false): { summary: string; body: string } {
    const text = String(ev.text ?? "");
    const meta = `slack channel=${ev.channel} user=${ev.user} ts=${ev.ts}`;
    // OPR.0.5.6.2 — attachments ride the row BODY by LOCAL path (Slack owns
    // nothing; the media file is OUR copy). Failures are per-file and named:
    // the message always survives a failed transfer.
    const sections: string[] = [text];
    if (ev.recoveredAfterGap) {
      const posted = new Date(Number(ev.ts) * 1000).toISOString();
      sections.unshift(`Recovered after a gap (late delivery). Originally posted ${posted} (Slack ts ${ev.ts}).`);
    }
    if (transfer && (transfer.stored.length > 0 || transfer.failed.length > 0)) {
      const lines: string[] = [];
      if (transfer.stored.length > 0) {
        lines.push("Attachments (workspace-local copies):");
        for (const f of transfer.stored) {
          lines.push(`- ${f.localPath} (${f.name}${f.mimetype ? `, ${f.mimetype}` : ""}, ${f.bytes} bytes)`);
        }
      }
      for (const f of transfer.failed) {
        lines.push(`FILE TRANSFER FAILED: ${f.name} — ${f.error}`);
      }
      sections.push(lines.join("\n"));
    }
    const firstFileName = transfer?.stored[0]?.name ?? transfer?.failed[0]?.name;
    const headline = text.trim() ? text : firstFileName ? `[file] ${firstFileName}` : text;
    return {
      summary: `${ev.recoveredAfterGap ? "[Recovered after gap] " : ""}Founder via Slack: ${headline.slice(0, 90)}`,
      body: `${sections.filter((s) => s.length > 0).join("\n\n")}\n\n---\nSource: ${meta}${correlationQitemId ? `\nIn reply to: ${correlationQitemId}` : ""}${conversation ? `\nConversation: this reply does not resolve ${correlationQitemId}. Answer in its thread with rig queue create --human-intent update --reply-to ${correlationQitemId}.` : ""}\nRouted by openrig slack-inbound. Default destination per config; re-route via queue as needed.`,
    };
  }

  /** What a reply on a decision's thread decides: the resolve text, or null for conversation. */
  private replyDecision(ev: SlackEvent, correlationQitemId: string | undefined): string | null {
    if (!correlationQitemId) return null;
    if (this.deps.explicitAnswersOnly) return explicitAnswer(ev.text);
    return String(ev.text ?? "").trim() || "[file reply]";
  }

  private replyTags(correlationQitemId: string | undefined, decision: string | null, cancel: string | null): string[] {
    if (!correlationQitemId || !this.deps.explicitAnswersOnly) return [];
    return [decision ? "human-answer" : "conversation", ...(cancel !== null ? ["cancel-request"] : [])];
  }

  /** The reason of an explicit `cancel` reply in a request's thread, or null when it is not one. */
  private replyCancel(ev: SlackEvent, correlationQitemId: string | undefined): string | null {
    if (!correlationQitemId || !this.deps.explicitAnswersOnly) return null;
    const m = EXPLICIT_CANCEL.exec(ev.text ?? "");
    return m ? (m[1] ?? "") : null;
  }

  /** Slack message ts is unique within a channel, so every inbound id uses both fields. */
  private inboundEventId(ev: SlackEvent): string {
    return `${ev.channel ?? "-"}:${ev.ts ?? "-"}`;
  }

  private inboundQitemId(ev: SlackEvent): string {
    return inboundQitemIdFor(ev.channel, ev.ts);
  }

  /**
   * Core landing attempt — NO dead-letter side effect. Dedup by ts (in-flight +
   * durable seen). `reason` distinguishes a dedup skip from a genuine create
   * failure so callers dead-letter ONLY real failures. On success, marks seen
   * (durable qitem exists → safe).
   */
  private async attemptLand(ev: SlackEvent, isCurrent: () => boolean = () => true): Promise<{
    landed: boolean;
    qitemId?: string;
    reason?: "dup" | "inflight" | "inactive" | "create_failed" | "resolve_failed" | "unregistered";
    correlationQitemId?: string;
    replyResolution?: "resolved" | "already-resolved" | "not-applicable";
  }> {
    const ts = ev.ts ?? "";
    const eventId = this.inboundEventId(ev);
    if (!ts || this.deps.seen.load().has(eventId)) return { landed: false, reason: "dup" };
    if (this.inflight.has(eventId)) return { landed: false, reason: "inflight" };
    if (!isCurrent()) return { landed: false, reason: "inactive" };
    // A6 v3 registration gate: admit-iff-registered. An unregistered sender is REFUSED here —
    // never landed as a fabricated human-<slackid>@kernel seat. This is a POLICY refusal, not a
    // transient failure, so it is NOT dead-lettered (retrying can't help until the human registers).
    const who = this.deps.resolveSender(ev.user ?? "");
    if (!who.admitted) {
      this.deps.log?.(`inbound REFUSED — unregistered sender ${ev.user} (ts=${ts}): ${who.teaching}`);
      return { landed: false, reason: "unregistered" };
    }
    this.inflight.add(eventId);
    try {
      // OPR.0.5.6.2 — transfer the human's files BEFORE composing the row so the
      // row carries local paths (or named failures). A missing port is itself a
      // named per-file failure, never a silent drop.
      const fileMetas = Array.isArray(ev.files) ? ev.files : [];
      let transfer: InboundFileResult | null = null;
      if (fileMetas.length > 0) {
        const namedAll = (error: string): InboundFileResult => ({
          stored: [],
          failed: fileMetas.map((f, i) => {
            const m = (f ?? {}) as { name?: string; id?: string };
            return { name: String(m.name ?? m.id ?? `file-${i + 1}`), error };
          }),
        });
        if (!this.deps.files) {
          transfer = namedAll("file transfer unavailable (no file port wired)");
        } else {
          // R1 F2: a THROWING port (disk-full mkdirp, any crash) must never cost
          // the already-ACKed message — the row still lands and every file
          // becomes a NAMED failure. Failure honesty is a property of this seam,
          // not a promise the port is trusted to keep.
          try {
            transfer = await this.deps.files.transfer(fileMetas, ts, ev.channel);
          } catch (e) {
            this.deps.log?.(`inbound file port CRASHED ts=${ts}: ${(e as Error).message}`);
            transfer = namedAll(`file transfer crashed: ${(e as Error).message || "unknown error"}`);
          }
        }
      }
      if (!isCurrent()) return { landed: false, reason: "inactive" };
      // S10 — deterministic route (thread map) when wired; static destination otherwise.
      const route = this.deps.resolveRoute?.(ev) ?? { destination: this.deps.destination };
      const decision = this.replyDecision(ev, route.correlationQitemId);
      const cancel = this.replyCancel(ev, route.correlationQitemId);
      const replyTags = this.replyTags(route.correlationQitemId, decision, cancel);
      const { summary, body } = this.summaryOf(ev, transfer, route.correlationQitemId, replyTags.includes("conversation"));
      let qitemId: string;
      try {
        qitemId = await this.deps.queue.createQitem({
          qitemId: this.inboundQitemId(ev),
          source: who.source, // the REGISTERED human's canonical ref (human-class), never a raw platform id
          destination: route.destination,
          priority: "routine",
          tags: [...route.tags ?? ["founder-slack", "inbound"], ...replyTags, `${SLACK_MESSAGE_TAG}${ev.channel ?? "-"}:${ts}`],
          summary,
          body,
        });
      } catch (e) {
        this.deps.log?.(`qitem create failed ts=${ts}: ${(e as Error).message}`);
        return { landed: false, reason: "create_failed" };
      }
      let replyResolution: "resolved" | "already-resolved" | "not-applicable" | undefined;
      if (route.correlationQitemId && decision && this.deps.resolveHumanReply) {
        try {
          replyResolution = await this.deps.resolveHumanReply({
            qitemId: route.correlationQitemId,
            actorSession: who.source,
            decision,
          });
        } catch (e) {
          this.deps.log?.(`human reply continuation failed qitem=${route.correlationQitemId} ts=${ts}: ${(e as Error).message}`);
          return { landed: false, qitemId, reason: "resolve_failed", correlationQitemId: route.correlationQitemId };
        }
      }
      if (route.correlationQitemId && cancel !== null && this.deps.cancelRequest) {
        try {
          const canceled = await this.deps.cancelRequest({ conversationId: route.correlationQitemId, actorSession: who.source, reason: cancel });
          this.deps.log?.(`cancel request ${route.correlationQitemId} by ${who.source}: ${canceled}`);
        } catch (e) {
          this.deps.log?.(`cancel continuation failed qitem=${route.correlationQitemId} ts=${ts}: ${(e as Error).message}`);
          return { landed: false, qitemId, reason: "resolve_failed", correlationQitemId: route.correlationQitemId };
        }
      }
      this.deps.seen.mark(eventId, "landed"); // durable qitem exists → safe to mark
      if (ev.channel && this.deps.markReceived) {
        try {
          await this.deps.markReceived({ channel: ev.channel, ts, qitemId });
        } catch (e) {
          this.deps.log?.(`received mark failed ts=${ts}: ${(e as Error).message}`);
        }
      }
      this.deps.log?.(`qitem ${qitemId} -> ${route.destination} (ts=${ts})`);
      return { landed: true, qitemId, correlationQitemId: route.correlationQitemId, replyResolution };
    } finally {
      this.inflight.delete(eventId);
    }
  }

  /**
   * LIVE path: attempt to land; on a genuine create failure, dead-letter the
   * event (attempt-counted) BEFORE returning — NOT marked seen (item 8).
   */
  async route(ev: SlackEvent, attempts = 0, isCurrent: () => boolean = () => true): Promise<{
    landed: boolean;
    qitemId?: string;
    disposition: "accepted" | "ignored" | "refused" | "dead-lettered";
    reason?: string;
    correlationQitemId?: string;
    replyResolution?: "resolved" | "already-resolved" | "not-applicable";
  }> {
    const r = await this.attemptLand(ev, isCurrent);
    if (!r.landed && (r.reason === "create_failed" || r.reason === "resolve_failed")) {
      this.deps.deadLetter.append(ev, attempts + 1);
      this.deps.log?.(`dead-lettered ts=${ev.ts} (attempt ${attempts + 1})`);
    }
    const disposition = r.landed ? "accepted" : r.reason === "unregistered" ? "refused" : (r.reason === "dup" || r.reason === "inflight" || r.reason === "inactive") ? "ignored" : "dead-lettered";
    return { landed: r.landed, qitemId: r.qitemId, disposition, reason: r.reason, correlationQitemId: r.correlationQitemId, replyResolution: r.replyResolution };
  }

  /**
   * #193 — a button click on a decision's structured questions. The clicked message is the
   * decision's root, so the same thread map a typed reply uses names the decision and its seat
   * (never the button's own ids, which only pick the question and option). Each click records
   * one answer; once the set is complete the answers are final, and the continuation lands one
   * reply row on the seat and resolves the decision, exactly like a typed reply. The reply row's
   * id is derived from the decision, so a redelivered click or a retry finds the same row. A
   * failed continuation is dead-lettered and retried like a typed reply that failed to land.
   */
  async routeAction(payload: SlackBlockActions): Promise<{ status: InboundDisposition; reason?: string }> {
    const r = await this.attemptAction(payload, true);
    if (r.status === "handler-failed") this.deps.actionDeadLetter?.append(payload, 1);
    return r;
  }

  private async attemptAction(payload: SlackBlockActions, live: boolean): Promise<{ status: InboundDisposition; reason?: string }> {
    const action = payload.actions?.[0];
    const offerQitemId = parseConfirmAction(action?.block_id, action?.action_id);
    if (offerQitemId) return this.attemptConfirm(payload, offerQitemId, live);
    const picked = parseQuestionAction(action?.block_id, action?.action_id);
    if (!picked) return { status: "ignored", reason: "not-a-question-button" };
    const who = this.deps.resolveSender(payload.user?.id ?? "");
    if (!who.admitted) {
      this.deps.log?.(`click REFUSED — unregistered sender ${payload.user?.id}: ${who.teaching}`);
      return { status: "refused", reason: "unregistered" };
    }
    const rootTs = clickedRootTs(payload);
    const route = rootTs ? this.deps.resolveRoute?.({ type: "message", thread_ts: rootTs, channel: payload.channel?.id }) : undefined;
    const qitemId = route?.correlationQitemId;
    if (!rootTs || !route || !qitemId) return { status: "ignored", reason: "unmapped-message" };
    const recorded = this.deps.recordHumanAnswer?.({ qitemId, actorSession: who.source, ...picked });
    if (!recorded || recorded.status !== "recorded") {
      return { status: "ignored", reason: recorded?.reason ?? "answers-unavailable" };
    }
    const acknowledge = async (text: string) => {
      try {
        await this.deps.acknowledgeAnswer?.({ channel: payload.channel?.id, threadTs: rootTs, text });
      } catch (e) {
        this.deps.log?.(`answer acknowledgement failed qitem=${qitemId}: ${(e as Error).message}`);
      }
    };
    const lines = formatHumanAnswers(recorded.questions, recorded.answers);
    if (!recorded.complete) {
      this.deps.log?.(`answer recorded qitem=${qitemId} question=${picked.questionId}`);
      const [just] = formatHumanAnswers(recorded.questions.filter((q) => q.id === picked.questionId), recorded.answers);
      const waiting = unansweredQuestions(recorded.questions, recorded.answers).map((q) => q.question);
      if (live) await acknowledge(escapeSlackText(redactSecrets(`Recorded: ${just}. Still to answer: ${waiting.join("; ")}`)));
      return { status: "accepted", reason: "answer-recorded" };
    }
    let resolution: "resolved" | "already-resolved" | "not-applicable" | undefined;
    try {
      await this.deps.queue.createQitem({
        qitemId: `qitem-slack-answers-${createHash("sha256").update(qitemId).digest("hex").slice(0, 20)}`,
        source: who.source,
        destination: route.destination,
        priority: "routine",
        tags: [...route.tags ?? ["founder-slack", "inbound"], "human-answer"],
        summary: `Founder via Slack: answered ${lines.length === 1 ? "1 question" : `${lines.length} questions`}`,
        body: `${lines.join("\n")}\n\n---\nAnswers (question id → option id): ${JSON.stringify(recorded.answers)}\nIn reply to: ${qitemId} (its humanAnswers field holds the same)\nRouted by openrig slack-inbound (button click).`,
      });
      resolution = await this.deps.resolveHumanReply?.({ qitemId, actorSession: who.source, decision: lines.join("; ") });
    } catch (e) {
      this.deps.log?.(`answer continuation failed qitem=${qitemId}: ${(e as Error).message}`);
      if (live) await acknowledge("Your answers are recorded, but handing them back failed. OpenRig will retry.");
      return { status: "handler-failed", reason: "answer-continuation-failed" };
    }
    if (resolution === "not-applicable") {
      // The reply row reached the seat, but the decision did not close: say so on the log and
      // the receipt instead of reporting success. Retrying cannot change this outcome.
      this.deps.log?.(`answers complete but resolve not applicable qitem=${qitemId}`);
      return { status: "refused", reason: "resolve-not-applicable" };
    }
    this.deps.log?.(`answers complete qitem=${qitemId} -> ${route.destination}`);
    const channel = payload.channel?.id;
    if (channel) {
      try {
        await this.deps.retireQuestionButtons?.({ channel, messageTs: payload.container?.message_ts ?? payload.message?.ts ?? rootTs, qitemId });
      } catch (e) {
        this.deps.log?.(`question buttons not replaced qitem=${qitemId}: ${(e as Error).message}`);
      }
    }
    if (resolution === "resolved") await acknowledge(escapeSlackText(redactSecrets(`All answered, sent back: ${lines.join("; ")}`)));
    return { status: "accepted", reason: "answers-complete" };
  }

  /** Phase 1 — a Confirm click resolves the decision its offer replies to with exactly the
   *  offer's stored reading. The reply row id derives from the offer, so a replayed click finds
   *  the same row, and the resolve transition happens at most once. */
  private async attemptConfirm(payload: SlackBlockActions, offerQitemId: string, live: boolean): Promise<{ status: InboundDisposition; reason?: string }> {
    const who = this.deps.resolveSender(payload.user?.id ?? "");
    if (!who.admitted) {
      this.deps.log?.(`confirm REFUSED — unregistered sender ${payload.user?.id}: ${who.teaching}`);
      return { status: "refused", reason: "unregistered" };
    }
    const rootTs = clickedRootTs(payload);
    if (!rootTs) return { status: "ignored", reason: "unmapped-message" };
    return this.confirm(who.source, offerQitemId, rootTs, payload.channel?.id, live, payload.container?.message_ts ?? payload.message?.ts);
  }

  private async confirm(actorSession: string, offerQitemId: string, rootTs: string, channel: string | undefined, live: boolean, offerTs?: string): Promise<{ status: InboundDisposition; reason?: string }> {
    const route = this.deps.resolveRoute?.({ type: "message", thread_ts: rootTs, channel });
    if (!route?.correlationQitemId) return { status: "ignored", reason: "unmapped-message" };
    const offer = this.deps.confirmOffer?.({ offerQitemId, actorSession });
    if (!offer?.ok) return { status: "refused", reason: offer?.reason ?? "confirm-unavailable" };
    if (offer.decisionQitemId !== route.correlationQitemId) return { status: "ignored", reason: "offer-not-in-this-thread" };
    const previous = this.confirmChains.get(offer.decisionQitemId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.confirmInTurn(actorSession, offerQitemId, route, channel, offerTs));
    this.confirmChains.set(offer.decisionQitemId, run);
    try {
      return await run;
    } finally {
      if (this.confirmChains.get(offer.decisionQitemId) === run) this.confirmChains.delete(offer.decisionQitemId);
    }
  }

  /** Runs only after any earlier Confirm on the same decision finished, so `decided` and `won`
   *  are read after that click's resolve and mark. */
  private async confirmInTurn(actorSession: string, offerQitemId: string, route: { destination: string; tags?: string[] }, channel: string | undefined, offerTs: string | undefined): Promise<{ status: InboundDisposition; reason?: string }> {
    const offer = this.deps.confirmOffer?.({ offerQitemId, actorSession });
    if (!offer?.ok) return { status: "refused", reason: offer?.reason ?? "confirm-unavailable" };
    const retire = async (outcome: ConfirmOutcome) => {
      if (!channel || !offerTs) return;
      try {
        await this.deps.retireConfirmOffer?.({ channel, messageTs: offerTs, offerQitemId, outcome });
      } catch (e) {
        this.deps.log?.(`confirm button not replaced offer=${offerQitemId}: ${(e as Error).message}`);
      }
    };
    if (offer.decided) {
      await retire(offer.won ? "confirmed" : "not-used");
      return { status: "ignored", reason: offer.won ? "already-confirmed" : "decided-by-another-answer" };
    }
    let resolution: "resolved" | "already-resolved" | "not-applicable" | undefined;
    try {
      await this.deps.queue.createQitem({
        qitemId: `qitem-slack-confirm-${createHash("sha256").update(offerQitemId).digest("hex").slice(0, 20)}`,
        source: actorSession,
        destination: route.destination,
        priority: "routine",
        tags: [...route.tags ?? ["founder-slack", "inbound"], "human-answer"],
        summary: "Founder via Slack: confirmed your reading",
        body: `Confirmed: ${offer.reading}\n\n---\nIn reply to: ${offer.decisionQitemId} (offer ${offerQitemId})\nRouted by openrig slack-inbound (Confirm click).`,
      });
      resolution = await this.deps.resolveHumanReply?.({ qitemId: offer.decisionQitemId, actorSession, decision: offer.reading });
    } catch (e) {
      this.deps.log?.(`confirm continuation failed offer=${offerQitemId}: ${(e as Error).message}`);
      return { status: "handler-failed", reason: "confirm-continuation-failed" };
    }
    if (resolution === "resolved") {
      this.deps.markConfirmWon?.(offerQitemId);
      await retire("confirmed");
    } else if (resolution === "already-resolved") {
      await retire("not-used");
    }
    if (resolution !== "resolved") return { status: "ignored", reason: resolution ?? "resolve-unavailable" };
    return { status: "accepted", reason: "confirmed" };
  }

  /** Phase 1 — a ✅ from the asked human on their decision's root, their own reply in its
   *  thread, or a Confirm offer. Deduplicated per (message, person); a failed continuation is
   *  dead-lettered and retried like a typed reply. */
  async routeReaction(ev: SlackEvent): Promise<{ status: InboundDisposition; reason?: string }> {
    const r = await this.attemptReaction(ev, true);
    if (r.status === "handler-failed") this.deps.deadLetter.append(ev, 1);
    return r;
  }

  private async attemptReaction(ev: SlackEvent, live: boolean): Promise<{ status: InboundDisposition; reason?: string }> {
    const channel = ev.item?.channel;
    const messageTs = ev.item?.ts;
    const feedback = FEEDBACK_REACTIONS[ev.reaction ?? ""];
    if (feedback && channel && messageTs) return this.feedback(ev, channel, messageTs, feedback);
    if (ev.reaction !== CHECK_REACTION || !channel || !messageTs) return { status: "ignored", reason: "not-a-check-on-a-message" };
    const key = `reaction:${channel}:${messageTs}:${ev.user ?? "-"}`;
    if (this.deps.seen.load().has(key) || this.inflight.has(key)) return { status: "ignored", reason: "dup" };
    const who = this.deps.resolveSender(ev.user ?? "");
    if (!who.admitted) {
      this.deps.log?.(`reaction REFUSED — unregistered sender ${ev.user}: ${who.teaching}`);
      return { status: "refused", reason: "unregistered" };
    }
    const target = this.deps.reactionTarget?.({ channel, messageTs, actorSession: who.source });
    if (!target) return { status: "ignored", reason: "not-a-decision-message" };
    this.inflight.add(key);
    try {
      const r = target.kind === "confirm"
        ? await this.confirm(who.source, target.offerQitemId, target.threadTs, channel, live, messageTs)
        : await this.answerByReaction(who.source, target, channel, key, messageTs);
      if (r.status !== "handler-failed") this.deps.seen.mark(key, r.status);
      return r;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async feedback(ev: SlackEvent, channel: string, messageTs: string, reaction: "+1" | "-1"): Promise<{ status: InboundDisposition; reason?: string }> {
    const key = `feedback:${channel}:${messageTs}:${ev.user ?? "-"}:${reaction}`;
    if (this.deps.seen.load().has(key) || this.inflight.has(key)) return { status: "ignored", reason: "dup" };
    const who = this.deps.resolveSender(ev.user ?? "");
    if (!who.admitted) return { status: "refused", reason: "unregistered" };
    this.inflight.add(key);
    try {
      const r = await this.deps.recordFeedback?.({ channel, messageTs, actorSession: who.source, reaction, key });
      this.deps.seen.mark(key, r ?? "not-applicable");
      return r === "recorded" ? { status: "accepted", reason: `feedback-${reaction}` } : { status: "ignored", reason: "not-our-request" };
    } catch (e) {
      this.deps.log?.(`feedback not recorded ts=${messageTs}: ${(e as Error).message}`);
      return { status: "handler-failed", reason: "feedback-failed" };
    } finally {
      this.inflight.delete(key);
    }
  }

  private async answerByReaction(actorSession: string, target: Extract<ReactionTarget, { kind: "answer" }>, channel: string, key: string, messageTs: string): Promise<{ status: InboundDisposition; reason?: string }> {
    const route = this.deps.resolveRoute?.({ type: "message", thread_ts: target.threadTs, channel });
    if (route?.correlationQitemId !== target.decisionQitemId) return { status: "ignored", reason: "not-the-current-decision" };
    let resolution: "resolved" | "already-resolved" | "not-applicable" | undefined;
    try {
      await this.deps.queue.createQitem({
        qitemId: `qitem-slack-reaction-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`,
        source: actorSession,
        destination: route.destination,
        priority: "routine",
        tags: [...route.tags ?? ["founder-slack", "inbound"], "human-answer"],
        summary: `Founder via Slack: ✅ ${target.text.slice(0, 80)}`,
        body: `${target.text}\n\n---\nIn reply to: ${target.decisionQitemId}\nRouted by openrig slack-inbound (✅ reaction).`,
      });
      resolution = await this.deps.resolveHumanReply?.({ qitemId: target.decisionQitemId, actorSession, decision: target.text });
    } catch (e) {
      this.deps.log?.(`reaction continuation failed qitem=${target.decisionQitemId}: ${(e as Error).message}`);
      return { status: "handler-failed", reason: "reaction-continuation-failed" };
    }
    return resolution === "resolved" ? { status: "accepted", reason: "answered-by-reaction" } : { status: "ignored", reason: resolution ?? "resolve-unavailable" };
  }

  /**
   * INTERRUPTION-SAFE retry (item 8): read the durable set NON-destructively,
   * attempt each, then ATOMICALLY replace the file with only the still-failing
   * entries. The original file stays intact until the atomic replace, so a crash
   * at any point loses nothing (a since-landed event is skipped via the seen-set).
   * Does NOT go through route() (which would double-append) — uses attemptLand.
   */
  async retryDeadLetters(): Promise<{ retried: number; landed: number }> {
    // Connect-time and periodic retries can overlap. Join the owned pass rather
    // than replacing its snapshot or dropping its in-flight entries as duplicates.
    if (this.retryPass) return this.retryPass;
    const pass = this.retryDeadLetterPass();
    this.retryPass = pass;
    try {
      return await pass;
    } finally {
      if (this.retryPass === pass) this.retryPass = undefined;
    }
  }

  private async retryDeadLetterPass(): Promise<{ retried: number; landed: number }> {
    const entries = this.deps.deadLetter.readAll();
    if (entries.length === 0) return this.retryActionDeadLetters();
    this.deps.log?.(`retrying ${entries.length} dead-letter(s)`);
    const stillFailing: DeadLetterEntry<SlackEvent>[] = [];
    let landed = 0;
    const seen = this.deps.seen.load();
    for (const e of entries) {
      if (e.ev.type === "reaction_added") {
        const reacted = await this.attemptReaction(e.ev, false);
        if (reacted.status === "accepted") landed++;
        else if (reacted.status === "handler-failed") stillFailing.push({ ev: e.ev, at: e.at, attempts: e.attempts + 1 });
        continue;
      }
      if (e.ev.ts && seen.has(this.inboundEventId(e.ev))) continue; // already landed → recovered, drop from set
      const r = await this.attemptLand(e.ev);
      if (r.landed) landed++;
      else if (r.reason === "create_failed" || r.reason === "resolve_failed") stillFailing.push({ ev: e.ev, at: e.at, attempts: e.attempts + 1 });
      else if (r.reason === "inflight") stillFailing.push(e); // owner has not proved durable landing yet
    }
    this.deps.deadLetter.replaceBatch(entries, stillFailing); // atomic; newer appends stay owed
    const actions = await this.retryActionDeadLetters();
    return { retried: entries.length + actions.retried, landed: landed + actions.landed };
  }

  /** #193 — retry dead-lettered clicks. Same interruption-safe shape as the event retry:
   *  read, attempt each, then atomically keep only the ones still failing. */
  private async retryActionDeadLetters(): Promise<{ retried: number; landed: number }> {
    const store = this.deps.actionDeadLetter;
    const entries = store?.readAll() ?? [];
    if (!store || entries.length === 0) return { retried: 0, landed: 0 };
    const stillFailing: DeadLetterEntry<SlackBlockActions>[] = [];
    let landed = 0;
    for (const e of entries) {
      const r = await this.attemptAction(e.ev, false);
      if (r.status === "handler-failed") stillFailing.push({ ev: e.ev, at: e.at, attempts: e.attempts + 1 });
      else if (r.status === "accepted") landed++;
    }
    store.replaceBatch(entries, stillFailing);
    return { retried: entries.length, landed };
  }
}

export interface SocketEnvelope {
  envelope_id?: string;
  type?: string;
  reason?: string;
  payload?: { event?: SlackEvent } & SlackBlockActions;
}

/**
 * Handle one Socket Mode envelope. FAST-ACK first, ALWAYS (item 8: Socket Mode
 * punishes slow acks; transport redelivery is not the safety net). Then filter
 * and route. Ack happens even if routing later fails — the dead-letter, not
 * transport redelivery, is the zero-drop net.
 */
export async function handleEnvelope(
  env: SocketEnvelope,
  ack: () => void,
  router: InboundRouter,
  log?: (m: string) => void,
  onReceived?: () => void,
): Promise<{ status: InboundDisposition; reason?: string }> {
  if (env.envelope_id) ack(); // fast-ack, unconditional, first
  onReceived?.(); // diagnostic receipt follows ACK but precedes every handler filter
  if (env.type === "disconnect") return { status: "ignored", reason: "disconnect" };
  if (env.type === "interactive") {
    // #193 — a button click. Other interactive payloads (shortcuts, modals) are not ours.
    if (env.payload?.type !== "block_actions") return { status: "ignored", reason: "interactive-type" };
    return router.routeAction(env.payload);
  }
  if (env.type !== "events_api") return { status: "ignored", reason: "envelope-type" };
  const ev = { ...env.payload?.event, recoveredAfterGap: undefined }; // only history admission supplies recovery provenance
  if (ev.type && REACTION_EVENT_TYPES.includes(ev.type)) return router.routeReaction(ev);
  const decision = ingestDecision(ev);
  if (!decision.ingest) {
    // P28: name the branch that FIRED and the conversation it came from. Privacy rail — a channel
    // id and a branch LABEL only: never bodies, tokens, user ids, or text content/length.
    if (ev.type) {
      log?.(
        `ignored non-ingestible event type=${ev.type} subtype=${ev.subtype ?? "-"} files=${ev.files?.length ?? 0}` +
          ` channel=${ev.channel ?? "-"} reason=${decision.reason}`,
      );
    }
    return { status: "ignored", reason: decision.reason };
  }
  const routed = await router.route(ev);
  return { status: routed.disposition, reason: routed.reason };
}
