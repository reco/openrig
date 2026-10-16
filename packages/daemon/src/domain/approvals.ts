// Approvals without a terminal: a seat that opted in sends its permission prompt here (its
// PermissionRequest hook waits on the answer). The human gets Approve / Deny buttons with the
// full command or tool input, literal credentials masked; the click is returned to the hook. The card
// stays answerable while the hook asks; with no answer after approvalTimeoutSeconds its thread is pinged
// once. A hook that stops asking expires the request with a note in its thread.
// This answers permission prompts only: it cannot override a runtime's own safety denials.

import { createHash } from "node:crypto";
import type { QueueRepository } from "./queue-repository.js";
import { maskSecrets } from "./credential-mask.js";
import { SLACK_SECTION_CAP, escapeSlackText, redactSecrets } from "./gateway/slack/message.js";
import { ANSWERED_IN_TERMINAL, PROMPT_CLEARED_PREFIX, dialogExcerpt, promptTitleTags } from "./stuck-prompt-watch.js";
import { alwaysRuleFor, ruleDecision, type AlwaysRule, type ApprovalRule } from "./approval-rules.js";

/** On a card that offers Always approve / Always deny: the exact rule it shows, saved on that click. */
export const ALWAYS_RULE_TAG = "always-rule:";
export const ALWAYS_EXACT_TAG = "always-exact";

/** Every card's four buttons, and the tags and line that say what an Always click saves. `brief`: the card has
 *  no room for an exact rule's full text, which is the input the card shows. */
export function alwaysOffer(rule: AlwaysRule, seat: string, brief = false) {
  const options = [{ id: "allow", label: "Approve" }, { id: "deny", label: "Deny" }, { id: "always_allow", label: "Always approve" }, { id: "always_deny", label: "Always deny" }];
  if ("refused" in rule) return { options, tags: [], note: `\nAlways approve / Always deny answer like Approve / Deny but save no rule: ${rule.refused}.` };
  const tags = [`${ALWAYS_RULE_TAG}${rule.match}`, ...(rule.exact ? [ALWAYS_EXACT_TAG] : [])];
  if (!rule.exact) return { options, tags, note: `\nAlways approve / Always deny also save \`${rule.match}\` for ${seat}.` };
  if (brief) return { options, tags, note: `\nAlways approve / Always deny also save a rule for ${seat} matching only this exact input.` };
  return { options, tags, note: `\nAlways approve / Always deny also save this rule for ${seat}, matching only this exact input:\n\`\`\`\n${rule.match}\n\`\`\`` };
}

export type ApprovalDecision = "allow" | "deny";
export type ApprovalWait = ApprovalDecision | "pending" | "expired";

export interface ApprovalRequest {
  sessionName: string;
  toolName: string;
  toolInput: unknown;
  /** A subagent's tool call blocks its seat too; the card names the subagent. */
  agentType?: string | null;
}

export interface ApprovalServiceDeps {
  queueRepo: QueueRepository;
  /** Seats that opted in to Slack approvals (session names). */
  optedIn: () => readonly string[];
  /** The human who may answer: the registered approver's address, or null. */
  approver: () => string | null;
  /** True only when the token is the named seat's own (bound to its node, name and generation). */
  verifySeat: (sessionName: string, seatToken: string | null) => boolean | Promise<boolean>;
  /** The seat's working directory, shown on the card. */
  cwdOf?: (sessionName: string) => string | null;
  /** How long an unanswered card waits before its one re-ping; read at each sweep. */
  repingMs?: () => number;
  /** The human's allow/deny rules, read at each request. */
  rules?: () => readonly ApprovalRule[];
  /** Saves a rule from an Always approve / Always deny click. */
  saveRule?: (rule: ApprovalRule) => void;
  pollMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface ApprovalService {
  verify: (sessionName: string, seatToken: string | null) => Promise<boolean>;
  /** A rule's answer for this request, before any human is asked; null when no rule matches. */
  byRule: (input: ApprovalRequest) => { decision: ApprovalDecision; message: string } | null;
  /** A deny rule's message for this request, checked before the runtime's own rules; null when none denies it.
   *  Throws when the rules cannot be read. */
  denyByRule: (input: ApprovalRequest) => string | null;
  start: (input: ApprovalRequest) => Promise<string | null>;
  /** Only the seat that asked may wait on its request. */
  wait: (requestId: string, sessionName: string, sliceMs: number) => Promise<ApprovalWait>;
  /** Expire every open request whose hook stopped asking (killed, an older hook that gave up, a daemon
   *  restart), and ping once in the thread of each still unanswered after repingMs. */
  sweep: () => Promise<void>;
  /** Answer every open request a rule now covers, as a rule hit at start would; returns the answered ids. */
  recheck: () => string[];
  /** The rule's message for a request a rule answered after it was asked; null otherwise. */
  ruleMessage: (requestId: string) => string | null;
}

const RULED = new RegExp(`^${PROMPT_CLEARED_PREFIX}(approved|denied) by rule (.+)$`, "s");

/** A hook asks again within a minute (one wait slice); twice that without a call means it is gone. */
export const APPROVAL_ABANDONED_MS = 120_000;

export const APPROVAL_REPING_MS = 900_000;
/** Not "approval ...": wait() reads a note with that prefix as an answer already recorded. */
const REPINGED = "re-pinged: approval still waiting";
const QUESTION_ID = "approval";
const MAX_PENDING_PER_SEAT = 3;
/** What the card's thread can carry within Slack's 20 message parts, escaped, with half-full cuts. */
const MAX_DETAIL_CHARS = 25_000;

/** What the human approves, in full: the command or patch text as written (Bash, Codex's
 *  apply_patch), else the tool input as JSON. */
export function approvalText(toolName: string, toolInput: unknown): string {
  const input = toolInput as { command?: unknown } | null;
  const raw = typeof input?.command === "string" ? input.command : JSON.stringify(toolInput ?? {}, null, 2);
  return maskSecrets(raw).replace(/```/g, "`​``");
}

/** Codex says why it asks: a network grant ("network-access <target>") or the agent's justification. */
function approvalReason(toolInput: unknown): string | null {
  const title = approvalTitle(toolInput);
  if (!title) return null;
  return (title.network ? `*${title.text}*` : `Reason: ${title.text}`).replace(/`/g, "'");
}

/** What the request is for, in the runtime's words: a network grant's target, else the tool's description. */
function approvalTitle(toolInput: unknown): { text: string; network: boolean } | null {
  const description = (toolInput as { description?: unknown } | null)?.description;
  if (typeof description !== "string" || !description.trim()) return null;
  const target = /^network-access\s+(.+)$/.exec(description.trim())?.[1];
  return { text: maskSecrets(target ? `Network access to ${target}` : description.trim()), network: !!target };
}

/** A request this new may not have its dialog drawn yet: it is never retired as answered. */
export const APPROVAL_RETIRE_GRACE_MS = 10_000;

/** A never-seen request whose seat shows no prompt this long past its grace was answered between scans. Its
 *  dialog becomes readable within about 35 s of the card when it is still up. */
export const APPROVAL_UNSEEN_RETIRE_MS = 90_000;

interface OpenApproval { qitemId: string; session: string; createdAt: number; shows: string | null; subagent: boolean }

function openApprovals(repo: QueueRepository): OpenApproval[] {
  return (repo.db.prepare(`SELECT qitem_id, source_session, ts_created, body FROM queue_items WHERE state = 'pending' AND tags LIKE '%"approval-request"%'
      AND (human_answers IS NULL OR human_answers = '{}')`).all() as Array<{ qitem_id: string; source_session: string; ts_created: string; body: string | null }>)
    .map((r) => {
      const text = /```\n([\s\S]*?)\n```/.exec(r.body ?? "")?.[1] ?? "";
      return { qitemId: r.qitem_id, session: r.source_session, createdAt: Date.parse(r.ts_created), shows: dialogMark(text),
        subagent: /^Asked by its .+ subagent$/m.test(r.body ?? "") };
    });
}

const flat = (text: string) => text.replace(/[\s│┃╭╮╰╯─━]+/g, "");

/** What the runtime's dialog shows of a request: a command's first line, else the file's name, URL or query
 *  of a tool input; null for an input whose dialog text cannot be predicted. */
function dialogMark(text: string): string | null {
  if (!text.startsWith("{")) return text ? flat(text.split("\n")[0]!).slice(0, 60) : null;
  const path = /"(?:file_path|notebook_path)"\s*:\s*"([^"]{1,300})"/.exec(text)?.[1];
  const field = path ? path.split("/").pop() : /"(?:url|query)"\s*:\s*"([^"]{1,200})"/.exec(text)?.[1];
  return field ? flat(field).slice(0, 60) : null;
}

/** The seat's PermissionRequest hook is waiting on an unanswered Slack request for the dialog on
 *  screen (null: a dialog that could not be read in full, which any open request may be). */
export function seatHasOpenApproval(repo: QueueRepository, session: string, dialog: string | null): boolean {
  return openApprovals(repo).some((a) => a.session === session && (dialog === null || a.shows === null || flat(dialog).includes(a.shows)));
}

export interface TerminalAnswerEvidence {
  /** Requests whose own dialog was on screen at some scan; filled by the retire check itself. */
  seen: Set<string>;
  /** When each never-seen request's seat began showing no prompt, past its grace; filled by the retire check. */
  emptySince: Map<string, number>;
  /** The seat's hooks show it started work or ended its turn after `since` (an ISO time). */
  movedOn: (session: string, since: string) => boolean;
}

/** The terminal dialog shows while the hook waits, and an answer typed there leaves the hook running.
 *  A request past its grace whose readable pane shows no prompt was answered in the terminal when its own
 *  dialog was seen and is gone, when the seat moved on since it asked (not for a subagent's request: the main
 *  agent works on meanwhile), or when no prompt has shown for APPROVAL_UNSEEN_RETIRE_MS (an answer between
 *  scans, such as a quick No that ends the turn without a hook). It then expires, so its card loses its buttons
 *  and the hook stops waiting. Until then a pane with no prompt is a dialog not read yet, and the card stays.
 *  While some dialog is up nothing is retired: it may be this request's, cut short, or one queued behind it. */
export function retireApprovalsAnsweredInTerminal(repo: QueueRepository, dialogs: Map<string, string | null>, evidence: TerminalAnswerEvidence, now = Date.now()): string[] {
  const retired: string[] = [];
  const open = openApprovals(repo);
  for (const id of evidence.seen) if (!open.some((a) => a.qitemId === id)) evidence.seen.delete(id);
  for (const id of evidence.emptySince.keys()) if (!open.some((a) => a.qitemId === id)) evidence.emptySince.delete(id);
  for (const a of open) {
    if (!dialogs.has(a.session)) continue;
    const dialog = dialogs.get(a.session) ?? null;
    if (dialog !== null) evidence.emptySince.delete(a.qitemId);
    if (dialog !== null && (a.shows === null || flat(dialog).includes(a.shows))) evidence.seen.add(a.qitemId);
    if (dialog !== null || now - a.createdAt < APPROVAL_RETIRE_GRACE_MS) continue;
    if (!evidence.emptySince.has(a.qitemId)) evidence.emptySince.set(a.qitemId, now);
    const answered = evidence.seen.has(a.qitemId)
      || (!a.subagent && evidence.movedOn(a.session, new Date(a.createdAt).toISOString()))
      || now - evidence.emptySince.get(a.qitemId)! >= APPROVAL_UNSEEN_RETIRE_MS;
    if (!answered) continue;
    repo.update({ qitemId: a.qitemId, actorSession: "daemon@kernel", state: "canceled", transitionNote: `approval expired: ${ANSWERED_IN_TERMINAL}` });
    retired.push(a.qitemId);
  }
  return retired;
}

export function makeApprovalService(deps: ApprovalServiceDeps): ApprovalService {
  const log = deps.log ?? (() => {});
  const repingMs = deps.repingMs ?? (() => APPROVAL_REPING_MS);
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const lastAsked = new Map<string, number>();
  const expire = async (requestId: string, why: string) => {
    lastAsked.delete(requestId);
    const item = deps.queueRepo.getById(requestId);
    // An answer already given stands: the hook returns it, whatever closes the row afterwards.
    if (!item || item.state !== "pending" || item.humanAnswers?.[QUESTION_ID]) return;
    // Canceling closes the request: its card loses its buttons and its own thread says why and where
    // the prompt went (request-lifecycle closeRequest).
    deps.queueRepo.update({ qitemId: requestId, actorSession: "daemon@kernel", state: "canceled", transitionNote: `approval expired: ${why}` });
  };
  /** One reply in the card's thread, so the human hears about a request still waiting; the card keeps its buttons. */
  const reping = async (item: { qitemId: string; sourceSession: string; destinationSession: string; summary: string | null }) => {
    if (deps.queueRepo.transitionLog.listForQitem(item.qitemId).some((t) => t.transitionNote === REPINGED)) return;
    deps.queueRepo.update({ qitemId: item.qitemId, actorSession: "daemon@kernel", transitionNote: REPINGED });
    const minutes = Math.round(repingMs() / 60_000);
    await deps.queueRepo.create({ sourceSession: item.sourceSession, destinationSession: item.destinationSession, humanIntent: "update", replyTo: item.qitemId, nudge: false,
      summary: `Still waiting: ${item.summary ?? `approval for ${item.sourceSession}`}`,
      body: `${item.sourceSession} has waited ${minutes} minute${minutes === 1 ? "" : "s"} for this approval. Approve / Deny on the card above still answer it.` })
      .catch((e: Error) => log(`re-ping for ${item.qitemId} not posted: ${e.message}`));
  };
  /** The rule the card showed, saved for the asking seat; null when the card offered none or saving failed. */
  const saveAlways = (qitemId: string, tags: string[] | null | undefined, effect: ApprovalDecision, seat: string): string | null => {
    const match = tags?.find((t) => t.startsWith(ALWAYS_RULE_TAG))?.slice(ALWAYS_RULE_TAG.length);
    if (!match || !deps.saveRule) return null;
    // Only a card this service built may save a rule: a row created over the API carries an identity provenance.
    const created = deps.queueRepo.transitionLog.listForQitem(qitemId).find((t) => t.transitionNote === "created");
    if (!created || created.identityProvenance !== null) return null;
    const exact = tags!.includes(ALWAYS_EXACT_TAG) ? { exact: true } : {};
    try { deps.saveRule({ effect, match, seats: seat, note: `saved from Slack for ${seat}`, ...exact }); return match; }
    catch (e) { log(`always rule ${match} not saved: ${(e as Error).message}`); return null; }
  };
  /** The input of each request this process asked about, so a later rule can answer it. */
  const asked = new Map<string, ApprovalRequest>();
  const hitFor = (input: ApprovalRequest) => {
    try { return ruleDecision(deps.rules?.() ?? [], input); } catch (e) {
      log(`approval rules not applied: ${(e as Error).message}`);
      return null;
    }
  };
  const hitMessage = (hit: NonNullable<ReturnType<typeof ruleDecision>>) =>
    `${hit.effect === "deny" ? "Denied" : "Allowed"} by the OpenRig approval rule ${hit.rule.match}${hit.rule.note ? `: ${hit.rule.note}` : ""}`;
  const ruledBy = (requestId: string) => {
    const notes = deps.queueRepo.transitionLog.listForQitem(requestId);
    const m = notes.map((t) => RULED.exec(t.transitionNote ?? "")).find(Boolean);
    return m ? { decision: (m[1] === "approved" ? "allow" : "deny") as ApprovalDecision, match: m[2]! } : null;
  };
  const service: ApprovalService = {
    verify: async (sessionName, seatToken) => deps.verifySeat(sessionName, seatToken),
    byRule(input) {
      const hit = hitFor(input);
      if (!hit) return null;
      log(`${hit.effect} by rule ${hit.rule.match}${hit.rule.seats ? ` for ${hit.rule.seats}` : ""}: ${input.sessionName} ${input.toolName} ${approvalText(input.toolName, input.toolInput).split("\n")[0]!.slice(0, 200)}`);
      return { decision: hit.effect, message: hitMessage(hit) };
    },
    denyByRule(input) {
      // Unreadable rules throw: the hook then refuses what it cannot check, rather than every deny going quiet.
      const hit = ruleDecision(deps.rules?.() ?? [], input);
      if (hit?.effect !== "deny") return null;
      log(`deny by rule ${hit.rule.match} before the runtime's own rules: ${input.sessionName} ${approvalText(input.toolName, input.toolInput).split("\n")[0]!.slice(0, 200)}`);
      return hitMessage(hit);
    },
    recheck() {
      const answered: string[] = [];
      for (const [requestId, input] of asked) {
        const item = deps.queueRepo.getById(requestId);
        if (!item || item.state !== "pending" || item.humanAnswers?.[QUESTION_ID]) { asked.delete(requestId); continue; }
        const hit = hitFor(input);
        if (!hit) continue;
        asked.delete(requestId);
        // Canceling closes the card, its line saying which rule answered (request-lifecycle closeRequest).
        deps.queueRepo.update({ qitemId: requestId, actorSession: "daemon@kernel", state: "canceled",
          transitionNote: `${PROMPT_CLEARED_PREFIX}${hit.effect === "allow" ? "approved" : "denied"} by rule ${hit.rule.match}` });
        answered.push(requestId);
      }
      return answered;
    },
    ruleMessage(requestId) {
      const ruled = ruledBy(requestId);
      return ruled ? `${ruled.decision === "deny" ? "Denied" : "Allowed"} by the OpenRig approval rule ${ruled.match}` : null;
    },
    async start(input) {
      if (!deps.optedIn().includes(input.sessionName)) return null;
      const human = deps.approver();
      if (!human) return null;
      const cwd = deps.cwdOf?.(input.sessionName);
      const reason = approvalReason(input.toolInput);
      const subagent = input.agentType ? `Asked by its ${input.agentType.replace(/[`*_~<>]/g, "")} subagent\n` : "";
      const text = approvalText(input.toolName, input.toolInput);
      const head = `${cwd ? `In \`${cwd.replace(/`/g, "")}\`\n` : ""}${subagent}${reason ? `${reason}\n` : ""}`;
      const whole = `${head}\`\`\`\n${text}\n\`\`\``;
      // Too long for one card: the card shows the start and end, its thread the whole input.
      const fits = escapeSlackText(redactSecrets(whole)).length <= SLACK_SECTION_CAP;
      if (!fits && escapeSlackText(redactSecrets(text)).length > MAX_DETAIL_CHARS) {
        log(`approval for ${input.sessionName} not sent: the ${input.toolName} input is too long even for the card's thread`);
        return null;
      }
      const rule = alwaysRuleFor(input.toolName, input.toolInput);
      const full = alwaysOffer(rule, input.sessionName);
      const always = fits && escapeSlackText(redactSecrets(whole + full.note)).length <= SLACK_SECTION_CAP ? full : alwaysOffer(rule, input.sessionName, true);
      const body = (fits ? whole : `${head}\`\`\`\n${dialogExcerpt(text)}\n\`\`\`\nFull ${input.toolName} input in this card's thread.`) + always.note;
      const humanDetail = fits ? undefined : `Full ${input.toolName} input:\n\`\`\`\n${text}\n\`\`\``;
      const open = deps.queueRepo.list({ tag: "approval-request", state: "pending", limit: 200 }).filter((q) => q.state === "pending" && q.sourceSession === input.sessionName && q.tags?.includes("approval-request"));
      if (open.length >= MAX_PENDING_PER_SEAT) {
        log(`approval for ${input.sessionName} not sent: ${open.length} requests already open`);
        return null;
      }
      const qitemId = `qitem-approval-${createHash("sha256").update(`${input.sessionName}|${Date.now()}|${Math.random()}`).digest("hex").slice(0, 20)}`;
      await deps.queueRepo.create({
        qitemId,
        sourceSession: input.sessionName,
        destinationSession: human,
        humanIntent: "decision",
        summary: `Approve ${input.toolName} for ${input.sessionName}?`,
        body,
        ...(humanDetail ? { humanDetail } : {}),
        tags: ["approval-request", ...always.tags, ...promptTitleTags(approvalTitle(input.toolInput)?.text)],
        humanQuestions: [{ id: QUESTION_ID, question: `Allow ${input.sessionName} to run this ${input.toolName}?`, options: always.options }],
        nudge: false,
      });
      asked.set(qitemId, input);
      return qitemId;
    },
    async sweep() {
      const open = deps.queueRepo.list({ tag: "approval-request", state: "pending", limit: 200 }).filter((q) => q.state === "pending" && q.tags?.includes("approval-request"));
      for (const item of open) {
        if (now() - (lastAsked.get(item.qitemId) ?? Math.max(startedAt, Date.parse(item.tsCreated))) >= APPROVAL_ABANDONED_MS) await expire(item.qitemId, "the seat stopped waiting for it");
        else if (now() - Date.parse(item.tsCreated) >= repingMs() && !item.humanAnswers?.[QUESTION_ID]) await reping(item);
      }
    },
    async wait(requestId, sessionName, sliceMs) {
      const sliceEnd = Date.now() + sliceMs;
      lastAsked.set(requestId, now());
      for (;;) {
        const item = deps.queueRepo.getById(requestId);
        if (!item?.tags?.includes("approval-request") || item.sourceSession !== sessionName) return "expired";
        const ruled = item.state === "canceled" ? ruledBy(requestId) : null;
        if (ruled) return ruled.decision;
        const clicked = item.humanAnswers?.[QUESTION_ID];
        const answer = clicked === "always_allow" ? "allow" : clicked === "always_deny" ? "deny" : clicked;
        // A card split over its thread: its buttons count only once every part, the full input included, is in Slack.
        if ((answer === "allow" || answer === "deny") && (!item.humanDetail || item.deliveryOutcome === "posted")) {
          if (!deps.queueRepo.transitionLog.listForQitem(requestId).some((t) => t.transitionNote?.startsWith("approval "))) {
            const saved = clicked !== answer ? saveAlways(requestId, item.tags, answer, sessionName) : null;
            deps.queueRepo.update({ qitemId: requestId, actorSession: "daemon@kernel",
              transitionNote: `approval ${answer} by ${item.destinationSession} for ${item.summary ?? "the request"}${saved ? `; saved ${answer} rule ${saved}` : ""}` });
          }
          return answer;
        }
        // Answered from the card's excerpt while its thread still posts: the answer stands once the thread lands.
        const threadPending = (answer === "allow" || answer === "deny") && !!item.humanDetail && item.deliveryOutcome !== "transport-failed" && item.deliveryOutcome !== "never-posted";
        if (!threadPending && (item.state !== "pending" || item.deliveryOutcome === "transport-failed")) return "expired";
        if (Date.now() >= sliceEnd) { lastAsked.set(requestId, now()); return "pending"; }
        await new Promise((r) => setTimeout(r, deps.pollMs ?? 500));
      }
    },
  };
  return service;
}
