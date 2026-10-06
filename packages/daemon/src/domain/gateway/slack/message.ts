// Complete, bounded human messages. No content is silently clipped.
// Slack contracts checked 2026-09-10:
// https://docs.slack.dev/reference/methods/chat.postMessage/ (4,000 recommended;
// 40,000 truncation; top-level text is the screen-reader/notification fallback)
// https://docs.slack.dev/reference/block-kit/blocks/section-block/ (3,000)
// https://docs.slack.dev/reference/block-kit/blocks/ (50 blocks)
import { MAX_OPTION_LABEL, formatHumanAnswers, type HumanAnswers, type HumanQuestion } from "../../human-questions.js";

export const SLACK_TEXT_CAP = 3900; // Our conservative complete-fallback budget, not Slack’s hard limit.
export const SLACK_SECTION_CAP = 3000;
/** @deprecated Complete rendering ignores excerpt requests. */
export const DEFAULT_BODY_EXCERPT = SLACK_SECTION_CAP;

export interface QitemLike {
  qitemId: string;
  summary?: string | null;
  body?: string | null;
  destinationSession?: string | null;
  /** #193 — structured questions, rendered as one button row per question. */
  humanQuestions?: readonly HumanQuestion[] | null;
  humanAnswers?: HumanAnswers | null;
  humanIntent?: "decision" | "update" | null;
  /** Phase 1 — a reading the human confirms with one click (an update replying to a decision). */
  humanConfirm?: string | null;
  /** Phase 1 — the human only acknowledges this request with a ✅; it carries no buttons. */
  humanAck?: boolean | null;
}

/** M1 A5b — an outbound image attachment. A media-bearing OutboundDecision carries these;
 *  the connector renders each as a Slack Block Kit `image` block on the SHIPPED outbound path.
 *  This is the T1076 seam finally wired (Slice-12's image relay), not a redesign. */
export interface SlackMediaRef {
  imageUrl: string; // a resolvable image URL (https). NEVER a secret-bearing URL (rejected below).
  altText: string;  // accessibility + notification fallback text
}

export interface OutboundMessageOpts {
  sourceLabel: string; // where the queue lives (host/box/rig), from config — never hardcoded
  /** @deprecated Ignored: complete briefs are rendered or explicitly refused. */
  bodyExcerpt?: number;
  /** @deprecated Refused without an accessible projection; use mediaRefs. */
  extraBlocks?: unknown[];
  /** M1 A5b: outbound image attachments, rendered as Block Kit `image` blocks (the wired seam). */
  mediaRefs?: SlackMediaRef[];
  /** #47 — an https evidenceRef that is NOT an image (GitLab issue link, PROOF.md URL, …),
   *  rendered as a plain link in the message text + a context block. NEVER a Block Kit
   *  `image` block: Slack rejects the ENTIRE message with `invalid_blocks` when an image
   *  block's URL is not a real image, silently and permanently breaking delivery. */
  evidenceLink?: string | null;
  /** S10 / A1.2 — the structured seat-attribution header (rig/host/seat/session), rendered as
   *  one sender context line in ONE honest bot identity. Authorship lives in OUR record;
   *  Slack's transport actor stays the app. NEVER a per-message username/icon override. */
  attribution?: SeatAttribution;
  /** S10 interim loudness rule: an escalation MENTIONS its human (`<@Uxxx>`); everything else
   *  stays quiet-threaded. The value is the Slack USER ID (mention semantics require the id,
   *  never a display name). */
  mentionUserId?: string;
  /** Stable decision/part identity. Included in the complete fallback budget. */
  reconcileMarker?: string;
  /** Phase 1 (explicitAnswersOnly): decisions always carry buttons and no typed-reply hint; a
   *  decision without its own buttons gets an Agree button. */
  answerHint?: boolean;
  /** Phase 1: the offer's button is replaced by its outcome: confirmed, or not used because the
   *  decision was made another way. */
  confirmOutcome?: ConfirmOutcome;
  /** Phase 1: the acknowledgement request was acknowledged; its ✅ prompt is replaced. */
  acknowledged?: boolean;
  /** Phase 1: every question is answered; the button rows are replaced by the answers. */
  answered?: boolean;
}

/** A1.2 — the four attribution fields. */
export interface SeatAttribution {
  seat: string;
  rig?: string;
  host?: string;
  session: string;
}

/** Parse the stamped session triple (`member@rig[@host]`, the 51-09 stored form) into the
 *  attribution fields. A bare/unparseable ref degrades to seat=session (never a throw). */
export function attributionFromSession(sourceSession: string | null | undefined): SeatAttribution | undefined {
  if (!sourceSession) return undefined;
  const parts = sourceSession.split("@");
  if (parts.length >= 2) {
    const a: SeatAttribution = { seat: `${parts[0]}@${parts[1]}`, rig: parts[1], session: sourceSession };
    if (parts.length >= 3) a.host = parts.slice(2).join("@");
    return a;
  }
  return { seat: sourceSession, session: sourceSession };
}

const SLACK_ALT_TEXT_CAP = 2000; // Slack image alt_text hard limit.

/** M1 A5b — turn media refs into Block Kit `image` blocks. Item-7 hygiene: a secret-bearing
 *  image_url (e.g. a webhook URL smuggled as an image) is REFUSED, never forwarded. Alt text is
 *  redacted and validated without clipping. Returns only the well-formed, secret-free image blocks. */
export function buildImageBlocks(mediaRefs: readonly SlackMediaRef[] | undefined): unknown[] {
  if (!mediaRefs?.length) return [];
  const blocks: unknown[] = [];
  for (const m of mediaRefs) {
    const url = String(m.imageUrl || "");
    // Only forward a clean https URL that carries no secret (defense-in-depth, item 7).
    if (!isSafeHttpsUrl(url)) continue;
    blocks.push({
      type: "image",
      image_url: url,
      // R2 B1: alt text is row-carried → the same inert pipeline (redact + neutralize).
      alt_text: bounded(inert(String(m.altText || "attachment")), SLACK_ALT_TEXT_CAP, "image description"),
    });
  }
  return blocks;
}

/** #193 — the block_id / action_id prefixes a click carries back. The inbound path parses
 *  exactly these (one producer, one parser: see parseQuestionAction). */
export const QUESTION_BLOCK_PREFIX = "or-q:";
export const OPTION_ACTION_PREFIX = "or-opt:";
export const CONFIRM_BLOCK_PREFIX = "or-confirm:";
export const CONFIRM_ACTION_ID = "or-confirm";
export const NOT_NOW_ACTION_ID = "or-not-now";
export type ConfirmChoice = "confirm" | "not-now";
export type ConfirmOutcome = "confirmed" | "declined" | "not-used";
const ACK_PROMPT = "React ✅ when seen.";
const TYPED_REPLY_HINT = "Or reply in this thread with your own answer.";
/** Phase 1: a decision that brings no buttons of its own gets this one. */
export const DEFAULT_CONFIRM_LABEL = "Confirm";
export const DEFAULT_CONFIRM_DECISION = "confirmed";
export const NOT_NOW_LABEL = "Not now";
export const NOT_NOW_DECISION = "not now";
export const ACK_DECISION = "acknowledged";

/** Parse a clicked button back into its question and option ids; null if it is not ours. */
export function parseQuestionAction(blockId: unknown, actionId: unknown): { questionId: string; optionId: string } | null {
  if (typeof blockId !== "string" || typeof actionId !== "string") return null;
  if (!blockId.startsWith(QUESTION_BLOCK_PREFIX) || !actionId.startsWith(OPTION_ACTION_PREFIX)) return null;
  const questionId = blockId.slice(QUESTION_BLOCK_PREFIX.length);
  const optionId = actionId.slice(OPTION_ACTION_PREFIX.length);
  return questionId && optionId ? { questionId, optionId } : null;
}

/** The offer qitem a clicked Confirm button names; null if the click is not a Confirm. */
export function parseConfirmAction(blockId: unknown, actionId: unknown): { offerQitemId: string; choice: ConfirmChoice } | null {
  if (typeof blockId !== "string" || !blockId.startsWith(CONFIRM_BLOCK_PREFIX)) return null;
  const choice = actionId === CONFIRM_ACTION_ID ? "confirm" : actionId === NOT_NOW_ACTION_ID ? "not-now" : null;
  const offerQitemId = blockId.slice(CONFIRM_BLOCK_PREFIX.length);
  return choice && offerQitemId ? { offerQitemId, choice } : null;
}

function buildConfirmBlocks(qitemId: string, reading: string, outcome: ConfirmOutcome | undefined, approve: boolean): { blocks: unknown[]; text: string } {
  if (outcome === "declined") {
    const text = bounded(`Decided: *${NOT_NOW_LABEL}*`, SLACK_SECTION_CAP, "declined");
    return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
  }
  if (outcome === "not-used") {
    const text = bounded(`Not used: the decision was already made another way. (${approve ? "Button" : "Reading"}: ${inert(reading)})`, SLACK_SECTION_CAP, "unused offer");
    return { text, blocks: [{ type: "context", elements: [{ type: "mrkdwn", text }] }] };
  }
  const confirmed = outcome === "confirmed";
  if (confirmed && approve) {
    const text = bounded(`Decided: *${inert(reading)}*`, SLACK_SECTION_CAP, "approved call to action");
    return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
  }
  if (approve) {
    const label = bounded(inert(reading), MAX_OPTION_LABEL, "approve button label");
    return {
      text: `Click "${label}" or "${NOT_NOW_LABEL}" to decide.`,
      blocks: [{ type: "actions", block_id: `${CONFIRM_BLOCK_PREFIX}${qitemId}`, elements: [
        { type: "button", action_id: CONFIRM_ACTION_ID, style: "primary", text: { type: "plain_text", text: label } },
        { type: "button", action_id: NOT_NOW_ACTION_ID, text: { type: "plain_text", text: NOT_NOW_LABEL } },
      ] }],
    };
  }
  if (confirmed) {
    const text = bounded(`Confirmed: ${inert(reading)}`, SLACK_SECTION_CAP, "confirmed reading");
    return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
  }
  const text = bounded(`*My reading:* ${inert(reading)}`, SLACK_SECTION_CAP, "confirm reading");
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      { type: "actions", block_id: `${CONFIRM_BLOCK_PREFIX}${qitemId}`, elements: [{ type: "button", action_id: CONFIRM_ACTION_ID, style: "primary", text: { type: "plain_text", text: "Confirm" } }] },
    ],
  };
}

function buildAnsweredBlocks(questions: readonly HumanQuestion[], answers: HumanAnswers): { blocks: unknown[]; text: string } {
  const lines = formatHumanAnswers(questions, answers).map((line) => bounded(`Answered: ${inert(line)}`, SLACK_SECTION_CAP, "answer"));
  return { text: lines.join("\n"), blocks: lines.map((text) => ({ type: "section", text: { type: "mrkdwn", text } })) };
}

/** #193 — the questions as blocks (a section, then a button row, per question) plus the
 *  complete text they must also appear as in the accessible fallback. */
function buildQuestionBlocks(questions: readonly HumanQuestion[], hint: string | null): { blocks: unknown[]; text: string } {
  const blocks: unknown[] = [];
  const lines: string[] = [];
  for (const q of questions) {
    const question = bounded(`*${inert(q.question)}*`, SLACK_SECTION_CAP, "question");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: question } });
    blocks.push({
      type: "actions",
      block_id: `${QUESTION_BLOCK_PREFIX}${q.id}`,
      elements: q.options.map((o) => ({
        type: "button",
        action_id: `${OPTION_ACTION_PREFIX}${o.id}`,
        value: o.id,
        ...(o.recommended ? { style: "primary" } : {}),
        text: { type: "plain_text", text: bounded(inert(o.label), MAX_OPTION_LABEL, "option label") },
      })),
    });
    lines.push(question, ...q.options.map((o) => `• ${inert(o.label)}${o.recommended ? " (recommended)" : ""}`));
  }
  if (hint) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: hint }] });
    lines.push(hint);
  }
  return { blocks, text: lines.join("\n") };
}

// Secret-looking patterns we refuse to forward (item 7 defense-in-depth).
const SECRET_PATTERNS: RegExp[] = [
  /xox[baprs]-[A-Za-z0-9-]+/g, // Slack bot/user/app/refresh tokens
  /xapp-[A-Za-z0-9-]+/g, // Slack app-level (Socket Mode) token
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, // incoming webhook URL
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi, // bearer tokens
  /xoxe\.xox[bp]-[A-Za-z0-9-]+/g, // rotation tokens
];

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(text);
  });
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, "[redacted-secret]");
  }
  return out;
}

/** S10 fix-r1 (R2 B1) — STRUCTURAL neutralization of queue-controlled content. Slack's
 *  formatting contract parses control sequences (<@U…>, <!here>, <!channel>, <!subteam^…>,
 *  <url|label>) only from a literal "<"; its documented rule for displaying user-generated
 *  text is to escape exactly &, <, > (docs.slack.dev/messaging/formatting-message-text).
 *  Escaping these three makes EVERY control form inert BY CONSTRUCTION — present and past
 *  forms alike — never a blocklist of known spellings. Ordinary mrkdwn styling (*bold*,
 *  _italic_, bare URLs) uses none of the three and survives untouched. Order matters: "&"
 *  first, or the escapes themselves would be re-escaped. */
export function escapeSlackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The untrusted-field pipeline: secrets redacted, then Slack control syntax neutralized. */
function inert(text: string): string {
  return escapeSlackText(redactSecrets(text));
}

function isSafeHttpsUrl(url: string): boolean {
  if (!/^https:\/\/\S+$/.test(url) || containsSecret(url)) return false;
  try {
    const parsed = new URL(url);
    return !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** #47 — render a non-image https evidenceRef as a plain link instead of a Block Kit
 *  `image` block. The URL arrives pre-validated as `^https://\S+$` from the delivery
 *  layer; item-7 hygiene still applies (a secret-bearing URL is refused, never
 *  forwarded), and a URL carrying mrkdwn-breaking `<`, `>`, `|` degrades to escaped
 *  plain text rather than a link. Returns null when there is nothing safe to render. */
function buildEvidenceLink(url: string | null | undefined): { text: string; block: unknown } | null {
  const ref = typeof url === "string" ? url.trim() : "";
  if (!ref || !isSafeHttpsUrl(ref)) return null;
  const escapedRef = inert(ref);
  const text = `Evidence: ${escapedRef}`;
  const context = bounded(/[<>|]/.test(ref) ? text : `Evidence: <${escapedRef}|evidence>`, SLACK_SECTION_CAP, "evidence context");
  const block = { type: "context", elements: [{ type: "mrkdwn", text: context }] };
  return { text, block };
}

/** S10 fix-r3 (R2 exactly-once) — the STRUCTURAL reconciliation identity: a bounded,
 *  decision-scoped token. decisionId is daemon-minted per decision (never settable through
 *  queue rows) and stable across retries of the same decision, so ONLY the target posted
 *  message carries this exact delimited token — ordinary prose quoting a qitem id (or even a
 *  lookalike built from the qitem id) cannot reproduce it. ONE producer function; the
 *  reconcile scanner matches exactly this function's output — producer and scanner share
 *  identity bytes by construction. Parentheses/colon only: no &,<,> so the token is
 *  escape-stable and never parses as Slack control syntax. */
export function reconcileToken(decisionId: string): string {
  return `(or-mark:${escapeSlackText(String(decisionId))})`;
}

export interface SlackMessagePayload {
  text: string; // notification fallback (always set)
  blocks: unknown[]; // Block Kit (T1076-extensible)
}

export class HumanMessageShapeError extends Error {
  readonly code = "human_message_unrenderable";
}

function bounded(text: string, max: number, field: string): string {
  // Count the escaped wire string in UTF-16 units, conservatively. Never slice
  // an entity or surrogate pair; reject the whole request before any post.
  if (text.length > max) {
    throw new HumanMessageShapeError(`${field} is ${text.length} units after escaping (maximum ${max}). Shorten the human brief; put only supplemental context in --human-detail-file. Keep the action and options in the primary body.`);
  }
  return text;
}

/** Pure, deterministic rendering. Queue metadata stays in the durable request;
 * the human sees one subject, complete body and one sender attribution. */
export function buildOutboundMessage(q: QitemLike, opts: OutboundMessageOpts): SlackMessagePayload {
  const summary = inert(String(q.summary || "(no summary)"));
  const body = bounded(inert(String(q.body || "")), SLACK_SECTION_CAP, "body");
  const mention = opts.mentionUserId ? `<@${opts.mentionUserId}> :rotating_light: ` : "";
  const headline = bounded(`${mention}*${summary}*`, SLACK_SECTION_CAP, "subject");
  const attr = bounded(`from ${inert(opts.attribution?.session || opts.sourceLabel)}`, 2000, "sender");
  const imageBlocks = buildImageBlocks(opts.mediaRefs);
  const attachmentText = imageBlocks.map((b) => `Image: ${(b as { alt_text: string }).alt_text}`).join("\n");
  const evidence = buildEvidenceLink(opts.evidenceLink);
  const explicit = opts.answerHint === true;
  const questionParts = !q.humanQuestions?.length ? null
    : opts.answered ? buildAnsweredBlocks(q.humanQuestions, q.humanAnswers ?? {})
    : buildQuestionBlocks(q.humanQuestions, explicit ? null : TYPED_REPLY_HINT);
  const confirmText = q.humanConfirm ?? (explicit && q.humanIntent !== "update" && !q.humanQuestions?.length && !q.humanAck ? DEFAULT_CONFIRM_LABEL : null);
  const confirmParts = confirmText ? buildConfirmBlocks(q.qitemId, confirmText, opts.confirmOutcome, q.humanIntent !== "update") : null;
  const ackText = q.humanAck && q.humanIntent !== "update" ? (opts.acknowledged ? "Acknowledged." : ACK_PROMPT) : null;
  if (opts.extraBlocks?.length) {
    throw new HumanMessageShapeError("Extra blocks have no complete accessible fallback. Use mediaRefs for images or author supplemental human detail.");
  }
  const text = bounded([headline, body, questionParts?.text, confirmParts?.text, ackText, attr, evidence ? evidence.text : null, attachmentText, opts.reconcileMarker].filter(Boolean).join("\n"), SLACK_TEXT_CAP, "complete fallback");
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: headline } }];
  if (body.trim()) blocks.push({ type: "section", text: { type: "mrkdwn", text: body } });
  if (questionParts) blocks.push(...questionParts.blocks);
  if (confirmParts) blocks.push(...confirmParts.blocks);
  if (ackText) blocks.push({ type: "section", text: { type: "mrkdwn", text: ackText } });
  blocks.push(...imageBlocks);
  if (evidence) blocks.push(evidence.block);
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: attr }] });
  if (blocks.length > 50) throw new HumanMessageShapeError("Message exceeds 50 Slack blocks. Reduce attachments before sending.");
  return { text, blocks };
}
