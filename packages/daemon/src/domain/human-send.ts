// Send an email from Slack. A seat asks with `rig queue create --human-send <payload.json>`; the daemon checks the
// recipients, stores the exact payload under its digest and builds a Send / Edit / Skip card for the configured human,
// with the full text in the card's thread. On Send from that human the daemon re-reads the stored payload, refuses it
// if its digest changed, and sends exactly that message once with its own gws credentials. No agent runs the send.
// Auto-send happens only under rules whose exact file digest the human enabled from a rules card, within a daily cap
// reserved before the send, and only after the auto-send's own Slack report was posted.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { QueueRepository } from "./queue-repository.js";
import type { HumanQuestion } from "./human-questions.js";

export const HUMAN_SEND_TAG = "human-send";
export const HUMAN_SEND_AUTO_TAG = "human-send-auto";
export const HUMAN_SEND_RULES_TAG = "human-send-rules";
export const CARD_NOTE = "human-send card: ";
export const AUTO_NOTE = "human-send auto: ";
export const RULES_CARD_NOTE = "human-send rules card: ";
const RESULT_NOTE = "human-send result: ";
const RULES_DECISION_NOTE = "human-send rules ";
const RESERVED_NOTE = "human-send reserved ";
const DAEMON = "daemon@kernel";

export const DEFAULT_DAILY_CAP = 20;
const MAX_TEXT = 50_000;
const MAX_SUBJECT = 250;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const REPORT_WAIT_MS = 10 * 60_000;

export const SEND_QUESTION: HumanQuestion = {
  id: "send", question: "Send this email exactly as shown?",
  options: [{ id: "send", label: "Send" }, { id: "edit", label: "Edit" }, { id: "skip", label: "Skip" }],
};

export const RULES_QUESTION: HumanQuestion = {
  id: "rules", question: "Enable exactly these auto-send rules?",
  options: [{ id: "enable", label: "Enable" }, { id: "reject", label: "Reject" }],
};

export class HumanSendError extends Error {}

export interface Attachment { name: string; contentType: string; sha256: string; base64: string }
export interface SendPayload { channel: "email"; to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; attachments: Attachment[] }
export interface SendRequest { channel?: unknown; to?: unknown; cc?: unknown; bcc?: unknown; subject?: unknown; text?: unknown; attachments?: unknown }

const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}$/;

/** A bare address, lower-cased; null for anything else (display names, lists, quotes, header breaks). */
export function normalizeAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const address = raw.trim().toLowerCase();
  return ADDRESS.test(address) && !address.includes("..") ? address : null;
}

export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const domain = raw.trim().toLowerCase();
  return DOMAIN.test(domain) ? domain : null;
}

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);
export const recipientsOf = (p: SendPayload) => [...p.to, ...p.cc, ...p.bcc];

function addressList(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new HumanSendError(`${field} must be a list of addresses`);
  return raw.map((a) => {
    const address = normalizeAddress(a);
    if (!address) throw new HumanSendError(`${field} has an address that is not a bare email address: ${JSON.stringify(a)}`);
    return address;
  });
}

const contentTypeOf = (name: string) => ({ pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", txt: "text/plain", csv: "text/csv" })[name.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

/** The exact payload a card approves: addresses checked and normalized, attachments read in by bytes. */
export function buildPayload(input: SendRequest, readFile: (path: string) => Buffer = readFileSync): SendPayload {
  if ((input.channel ?? "email") !== "email") throw new HumanSendError("channel must be email (the only channel this gate sends on)");
  const to = addressList(input.to, "to");
  const cc = addressList(input.cc, "cc");
  const bcc = addressList(input.bcc, "bcc");
  if (!to.length) throw new HumanSendError("to needs at least one address");
  if (new Set([...to, ...cc, ...bcc]).size !== to.length + cc.length + bcc.length) throw new HumanSendError("an address appears more than once across to, cc and bcc");
  if (typeof input.subject !== "string" || !input.subject.trim() || input.subject.length > MAX_SUBJECT || /[\r\n]/.test(input.subject)) {
    throw new HumanSendError(`subject must be one nonempty line of at most ${MAX_SUBJECT} characters`);
  }
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > MAX_TEXT) throw new HumanSendError(`text must be nonempty and at most ${MAX_TEXT} characters`);
  if (input.attachments !== undefined && !Array.isArray(input.attachments)) throw new HumanSendError("attachments must be a list of file paths");
  const attachments = ((input.attachments ?? []) as unknown[]).map((path) => {
    if (typeof path !== "string" || !path.startsWith("/")) throw new HumanSendError("each attachment must be an absolute file path");
    const name = basename(path);
    if (!FILE_NAME.test(name)) throw new HumanSendError(`attachment name ${JSON.stringify(name)} must be plain letters, digits, dots, dashes, underscores or spaces`);
    let bytes: Buffer;
    try { bytes = readFile(path); } catch (e) { throw new HumanSendError(`could not read attachment ${path}: ${(e as Error).message}`); }
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new HumanSendError(`attachment ${name} is over 10 MB`);
    return { name, contentType: contentTypeOf(name), sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") };
  });
  return { channel: "email", to, cc, bcc, subject: input.subject, text: input.text, attachments };
}

const canonical = (p: SendPayload) => JSON.stringify({ channel: p.channel, to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, text: p.text,
  attachments: p.attachments.map((a) => ({ name: a.name, contentType: a.contentType, sha256: a.sha256, base64: a.base64 })) });

export const digestOf = (p: SendPayload) => createHash("sha256").update(canonical(p)).digest("hex");

/** Stored once under its digest, read-only; an existing file is kept. */
export function storePayload(dir: string, payload: SendPayload): string {
  const digest = digestOf(payload);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${digest}.json`);
  if (!existsSync(path)) {
    writeFileSync(path, canonical(payload), { flag: "wx", mode: 0o400 });
  }
  return digest;
}

/** The stored payload, or null when it is missing or no longer matches its digest. */
export function loadPayload(dir: string, digest: string): SendPayload | null {
  try {
    const payload = JSON.parse(readFileSync(join(dir, `${digest}.json`), "utf8")) as SendPayload;
    return digestOf(payload) === digest ? payload : null;
  } catch {
    return null;
  }
}

const encodeWord = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
const wrap = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n");

/** The RFC 5322 message for exactly this payload; the boundary is derived from its digest. */
export function buildMessage(p: SendPayload): string {
  const head = [`To: ${p.to.join(", ")}`, ...(p.cc.length ? [`Cc: ${p.cc.join(", ")}`] : []), ...(p.bcc.length ? [`Bcc: ${p.bcc.join(", ")}`] : []),
    `Subject: ${encodeWord(p.subject)}`, "MIME-Version: 1.0"];
  const textPart = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap(Buffer.from(p.text, "utf8").toString("base64"))];
  if (!p.attachments.length) return [...head, ...textPart].join("\r\n");
  const boundary = `openrig-${digestOf(p).slice(0, 32)}`;
  const parts = p.attachments.map((a) => [`--${boundary}`, `Content-Type: ${a.contentType}; name="${a.name}"`, `Content-Disposition: attachment; filename="${a.name}"`,
    "Content-Transfer-Encoding: base64", "", wrap(a.base64)].join("\r\n"));
  return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, ...textPart, ...parts, `--${boundary}--`, ""].join("\r\n");
}

export function cardFields(p: SendPayload, digest: string, auto?: { ruleId: string }): { summary: string; body: string; humanDetail: string } {
  const line = (label: string, list: string[]) => list.length ? [`${label}: ${list.join(", ")}`] : [];
  const lines = [
    `*${p.subject.replace(/[*_~`]/g, "")}*`,
    ...line("To", p.to), ...line("Cc", p.cc), ...line("Bcc", p.bcc),
    ...(p.attachments.length ? [`Attachments: ${p.attachments.map((a) => `${a.name} (sha256 ${a.sha256.slice(0, 12)})`).join(", ")}`] : []),
    `Payload: \`${digest}\``,
    auto ? `Sending automatically under auto-send rule \`${auto.ruleId}\`; the result follows in this thread.`
      : "The full text is in this thread. Send sends exactly this payload once; Edit sends nothing and asks for a new version; Skip sends nothing.",
  ];
  return {
    summary: `${auto ? "Auto-send" : "Send"} email to ${p.to[0]}${recipientsOf(p).length > 1 ? ` +${recipientsOf(p).length - 1}` : ""}: ${p.subject}`.slice(0, 200),
    body: lines.join("\n"),
    humanDetail: p.text,
  };
}

export interface RecipientConstraint { address?: string; domain?: string }
export interface AutoSendRule { id: string; seat?: string; channel?: string; recipient?: RecipientConstraint; recipientWhitelist?: RecipientConstraint[]; dailyCap: number }
export interface AutoSendRules { enabled: boolean; rules: AutoSendRule[] }

function constraintOf(raw: unknown, where: string): RecipientConstraint {
  const c = raw as Record<string, unknown> | null;
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new HumanSendError(`${where} must be an object`);
  const keys = Object.keys(c);
  if (keys.length !== 1 || !["address", "domain"].includes(keys[0]!)) throw new HumanSendError(`${where} needs exactly one of address or domain`);
  if (c.address !== undefined) {
    const address = normalizeAddress(c.address);
    if (!address) throw new HumanSendError(`${where}.address is not a bare email address`);
    return { address };
  }
  const domain = normalizeDomain(c.domain);
  if (!domain) throw new HumanSendError(`${where}.domain is not a plain domain`);
  return { domain };
}

/** Rules as auto-send-rules.schema.json allows them; anything else throws. */
export function parseRules(text: string): AutoSendRules {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text) as Record<string, unknown>; } catch { throw new HumanSendError("rules are not valid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HumanSendError("rules must be an object");
  const extra = Object.keys(raw).filter((k) => !["version", "enabled", "rules"].includes(k));
  if (extra.length) throw new HumanSendError(`unknown rules keys: ${extra.join(", ")}`);
  if (raw.version !== 1) throw new HumanSendError("rules version must be 1");
  if (typeof raw.enabled !== "boolean") throw new HumanSendError("enabled must be true or false");
  if (!Array.isArray(raw.rules)) throw new HumanSendError("rules must be a list");
  const ids = new Set<string>();
  const rules = raw.rules.map((r, i): AutoSendRule => {
    const where = `rules[${i}]`;
    const rule = r as Record<string, unknown>;
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new HumanSendError(`${where} must be an object`);
    const unknown = Object.keys(rule).filter((k) => !["id", "seat", "channel", "recipient", "recipientWhitelist", "dailyCap"].includes(k));
    if (unknown.length) throw new HumanSendError(`${where} has unknown keys: ${unknown.join(", ")}`);
    if (typeof rule.id !== "string" || !rule.id.trim() || /\s/.test(rule.id)) throw new HumanSendError(`${where}.id must be a nonempty word`);
    if (ids.has(rule.id)) throw new HumanSendError(`${where}.id ${rule.id} is used twice`);
    ids.add(rule.id);
    for (const key of ["seat", "channel"] as const) {
      if (rule[key] !== undefined && (typeof rule[key] !== "string" || !(rule[key] as string).trim())) throw new HumanSendError(`${where}.${key} must be a nonempty string`);
    }
    if (rule.recipient === undefined && rule.recipientWhitelist === undefined) throw new HumanSendError(`${where} needs recipient or recipientWhitelist`);
    if (rule.recipientWhitelist !== undefined && (!Array.isArray(rule.recipientWhitelist) || !rule.recipientWhitelist.length)) {
      throw new HumanSendError(`${where}.recipientWhitelist must be a nonempty list`);
    }
    const cap = rule.dailyCap ?? DEFAULT_DAILY_CAP;
    if (!Number.isInteger(cap) || (cap as number) < 1 || (cap as number) > DEFAULT_DAILY_CAP) throw new HumanSendError(`${where}.dailyCap must be a whole number from 1 to ${DEFAULT_DAILY_CAP}`);
    return {
      id: rule.id,
      ...(rule.seat !== undefined ? { seat: rule.seat as string } : {}),
      ...(rule.channel !== undefined ? { channel: rule.channel as string } : {}),
      ...(rule.recipient !== undefined ? { recipient: constraintOf(rule.recipient, `${where}.recipient`) } : {}),
      ...(rule.recipientWhitelist !== undefined ? { recipientWhitelist: (rule.recipientWhitelist as unknown[]).map((c, j) => constraintOf(c, `${where}.recipientWhitelist[${j}]`)) } : {}),
      dailyCap: cap as number,
    };
  });
  return { enabled: raw.enabled, rules };
}

const permits = (c: RecipientConstraint, address: string) => c.address !== undefined ? c.address === address : c.domain === domainOf(address);

export function ruleMatches(rule: AutoSendRule, seat: string, p: SendPayload): boolean {
  if (rule.seat !== undefined && rule.seat !== seat) return false;
  if (rule.channel !== undefined && rule.channel !== p.channel) return false;
  return recipientsOf(p).every((address) => (!rule.recipient || permits(rule.recipient, address))
    && (!rule.recipientWhitelist || rule.recipientWhitelist.some((c) => permits(c, address))));
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const daemonNotes = (repo: QueueRepository, qitemId: string) => repo.transitionLog.listForQitem(qitemId)
  .filter((t) => t.actorSession === DAEMON && t.identityProvenance === null && t.transitionNote)
  .map((t) => t.transitionNote!);

/** The rules digest the human last decided on, if that decision was Enable. */
export function enabledRulesDigest(repo: QueueRepository): string | null {
  const latest = repo.db.prepare(`SELECT transition_note FROM queue_transitions WHERE actor_session = ? AND identity_provenance IS NULL
      AND (transition_note LIKE 'human-send rules enabled %' OR transition_note LIKE 'human-send rules rejected %')
      ORDER BY transition_id DESC LIMIT 1`).get(DAEMON) as { transition_note: string } | undefined;
  const m = latest ? /^human-send rules enabled ([0-9a-f]{64})$/.exec(latest.transition_note) : null;
  return m ? m[1]! : null;
}

export type AutoSendVerdict = { rule: AutoSendRule; rulesDigest: string } | { none: string };

/** The one rule that auto-sends this payload from this seat, or why none does. */
export function autoSendRuleFor(repo: QueueRepository, rulesPath: string, seat: string, p: SendPayload): AutoSendVerdict {
  let text: string;
  try { text = readFileSync(rulesPath, "utf8"); } catch { return { none: "no rules file" }; }
  const digest = sha256(text);
  if (enabledRulesDigest(repo) !== digest) return { none: "the rules file is not the version the human enabled" };
  let rules: AutoSendRules;
  try { rules = parseRules(text); } catch (e) { return { none: `rules invalid: ${(e as Error).message}` }; }
  if (!rules.enabled) return { none: "auto-send is disabled" };
  const matching = rules.rules.filter((r) => ruleMatches(r, seat, p));
  if (matching.length > 1) return { none: `ambiguous: rules ${matching.map((r) => r.id).join(", ")} all match` };
  return matching[0] ? { rule: matching[0], rulesDigest: digest } : { none: "no rule matches every recipient" };
}

export const sendDay = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);

/** Reserve one of the rule's slots for today before sending. One immediate transaction, so concurrent passes and
 *  daemons on the same database count each other; a reservation is never given back. */
export function reserveSlot(repo: QueueRepository, qitemId: string, rule: AutoSendRule, nowMs: number): boolean {
  const note = `${RESERVED_NOTE}rule=${rule.id} day=${sendDay(nowMs)}`;
  const reserve = repo.db.transaction(() => {
    const own = repo.db.prepare("SELECT 1 FROM queue_transitions WHERE qitem_id = ? AND actor_session = ? AND identity_provenance IS NULL AND transition_note = ?").get(qitemId, DAEMON, note);
    if (own) return true;
    const used = (repo.db.prepare("SELECT COUNT(*) AS n FROM queue_transitions WHERE actor_session = ? AND identity_provenance IS NULL AND transition_note = ?").get(DAEMON, note) as { n: number }).n;
    if (used >= rule.dailyCap) return false;
    repo.transitionLog.append({ qitemId, state: repo.getById(qitemId)!.state, actorSession: DAEMON, transitionNote: note });
    return true;
  });
  return reserve.immediate();
}

export type SendResult = { status: "sent"; id: string } | { status: "failed"; detail: string } | { status: "unknown"; detail: string };
export type Sender = (messagePath: string) => Promise<SendResult>;

const execFileAsync = promisify(execFile);

/** gws sends the stored message file as media: no address, subject or text is ever on its command line. A definite
 *  API refusal is failed; anything else that is not a message id is unknown, never retried. */
export const gwsSender: Sender = async (messagePath) => {
  try {
    const { stdout } = await execFileAsync("gws", ["gmail", "users", "messages", "send", "--params", '{"userId":"me"}',
      "--upload", basename(messagePath), "--upload-content-type", "message/rfc822"], { cwd: dirname(messagePath), timeout: 120_000 });
    const id = (JSON.parse(stdout) as { id?: unknown }).id;
    return typeof id === "string" && id ? { status: "sent", id } : { status: "unknown", detail: "gws returned no message id" };
  } catch (e) {
    const out = String((e as { stdout?: string }).stdout ?? "");
    const code = /"code"\s*:\s*(\d{3})/.exec(out)?.[1];
    if (code && code.startsWith("4")) return { status: "failed", detail: `Gmail refused it (HTTP ${code})` };
    return { status: "unknown", detail: (e as { killed?: boolean }).killed ? "gws timed out" : `gws exited without a result${code ? ` (HTTP ${code})` : ""}` };
  }
};

export interface SendDeps {
  send: Sender;
  /** The configured human who may approve (the registry's approver), as for merge cards. */
  approver: () => string | null;
  storeDir: string;
  rulesPath: string;
  now?: () => number;
  log?: (msg: string) => void;
}

const resultOf = (notes: string[]) => notes.find((n) => n.startsWith(RESULT_NOTE) && !n.endsWith(" pending"));
const pendingOf = (notes: string[]) => notes.some((n) => n.startsWith(RESULT_NOTE) && n.endsWith(" pending"));

async function report(repo: QueueRepository, row: { qitemId: string; sourceSession: string; destinationSession: string }, thread: string, seat: string): Promise<void> {
  await repo.create({ sourceSession: row.sourceSession, destinationSession: row.destinationSession, humanIntent: "update", replyTo: row.qitemId,
    summary: thread.slice(0, 120), body: thread, nudge: false });
  await repo.create({ sourceSession: DAEMON, destinationSession: row.sourceSession, summary: seat.slice(0, 200), body: seat, tags: [HUMAN_SEND_TAG, "human-send-result"], nudge: true });
}

async function sendOnce(repo: QueueRepository, deps: SendDeps, qitemId: string, payload: SendPayload, digest: string): Promise<SendResult> {
  repo.update({ qitemId, actorSession: DAEMON, transitionNote: `${RESULT_NOTE}send pending` });
  const dir = join(deps.storeDir, "outgoing");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${digest}.eml`);
  writeFileSync(path, buildMessage(payload), { mode: 0o600 });
  try {
    return await deps.send(path);
  } catch (e) {
    return { status: "unknown", detail: (e as Error).message.slice(0, 200) };
  } finally {
    rmSync(path, { force: true });
  }
}

const describe = (r: SendResult) => r.status === "sent" ? `sent ${r.id}` : `${r.status} ${r.detail}`;

function sendLines(r: SendResult, to: string): { thread: string; seat: string } {
  if (r.status === "sent") return { thread: `Sent to ${to} (Gmail id \`${r.id}\`).`, seat: `Email to ${to} sent (Gmail id ${r.id}).` };
  if (r.status === "failed") return { thread: `Not sent: ${r.detail}.`, seat: `Email to ${to} not sent: ${r.detail}.` };
  return { thread: `Delivery unknown: ${r.detail}. It is not retried; check the Sent folder before asking again.`,
    seat: `Email to ${to}: delivery unknown (${r.detail}). Not retried; reconcile with the Sent folder before any new card.` };
}

/** Act once on each answered send or rules card and each posted auto-send, as the merge cards do. */
export async function actOnSendAnswers(repo: QueueRepository, deps: SendDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const rows = repo.db.prepare(`SELECT q.qitem_id FROM queue_items q WHERE q.ts_created > ?
      AND (q.tags LIKE '%"${HUMAN_SEND_TAG}"%' OR q.tags LIKE '%"${HUMAN_SEND_AUTO_TAG}"%' OR q.tags LIKE '%"${HUMAN_SEND_RULES_TAG}"%')
      AND NOT EXISTS (SELECT 1 FROM queue_transitions t WHERE t.qitem_id = q.qitem_id AND t.actor_session = '${DAEMON}' AND t.transition_note LIKE '${RESULT_NOTE}%' AND t.transition_note NOT LIKE '% pending')`)
    .all(new Date(now() - 7 * 24 * 3600_000).toISOString()) as Array<{ qitem_id: string }>;
  for (const { qitem_id } of rows) {
    const row = repo.getById(qitem_id);
    if (!row || row.destinationSession !== deps.approver()) continue;
    const notes = daemonNotes(repo, qitem_id);
    if (resultOf(notes)) continue;
    const card = notes.find((n) => n.startsWith(CARD_NOTE));
    const auto = notes.find((n) => n.startsWith(AUTO_NOTE));
    const rulesCard = notes.find((n) => n.startsWith(RULES_CARD_NOTE));
    const finish = async (note: string, thread: string, seat: string) => {
      repo.update({ qitemId: qitem_id, actorSession: DAEMON, transitionNote: `${RESULT_NOTE}${note}` });
      deps.log?.(`${qitem_id}: ${note}`);
      await report(repo, row, thread, seat);
    };
    if (pendingOf(notes)) {
      await finish("unknown the daemon stopped during the send", "Delivery unknown: the daemon stopped during the send. It is not retried; check the Sent folder.",
        "A send was interrupted by a daemon stop: delivery unknown, not retried. Reconcile with the Sent folder before any new card.");
      continue;
    }
    if (rulesCard && row.tags?.includes(HUMAN_SEND_RULES_TAG)) {
      const choice = row.humanAnswers?.[RULES_QUESTION.id];
      const digest = rulesCard.slice(RULES_CARD_NOTE.length);
      if (choice === "enable") {
        let current: string | null = null;
        try { current = sha256(readFileSync(deps.rulesPath, "utf8")); } catch { /* missing file: not enabled */ }
        if (current !== digest) {
          await finish("refused rules changed", "Not enabled: the rules file changed after this card was built.", "Auto-send rules not enabled: the file changed after the card was built; ask again.");
          continue;
        }
        repo.update({ qitemId: qitem_id, actorSession: DAEMON, transitionNote: `${RULES_DECISION_NOTE}enabled ${digest}` });
        await finish("rules enabled", "Enabled exactly these rules. Any change to the file turns auto-send off until a new card is enabled.", `Auto-send rules ${digest.slice(0, 12)} enabled.`);
      } else if (choice === "reject") {
        repo.update({ qitemId: qitem_id, actorSession: DAEMON, transitionNote: `${RULES_DECISION_NOTE}rejected ${digest}` });
        await finish("rules rejected", "Rejected: auto-send stays off.", `Auto-send rules ${digest.slice(0, 12)} rejected; auto-send is off.`);
      }
      continue;
    }
    if (card && row.tags?.includes(HUMAN_SEND_TAG)) {
      const choice = row.humanAnswers?.[SEND_QUESTION.id];
      const digest = card.slice(CARD_NOTE.length);
      if (choice === "skip") await finish("skipped", "Skipped: nothing was sent.", `Email card ${qitem_id} skipped by ${row.destinationSession}: nothing sent.`);
      else if (choice === "edit") {
        await finish("edit requested", "Not sent: Edit asks the seat for a new version, which needs its own Send.",
          `${row.destinationSession} chose Edit on ${qitem_id}: nothing sent. Read their thread reply, then submit the revised payload as a new --human-send card.`);
      } else if (choice === "send") {
        const payload = loadPayload(deps.storeDir, digest);
        if (!payload) {
          await finish("refused payload changed", "Not sent: the stored payload is missing or no longer matches this card.", `Email card ${qitem_id} refused: its stored payload is missing or changed.`);
          continue;
        }
        const result = await sendOnce(repo, deps, qitem_id, payload, digest);
        const lines = sendLines(result, payload.to.join(", "));
        await finish(describe(result), lines.thread, lines.seat);
      }
      continue;
    }
    if (auto && row.tags?.includes(HUMAN_SEND_AUTO_TAG)) {
      const m = /^human-send auto: ([0-9a-f]{64}) rule=(\S+) rules=([0-9a-f]{64})$/.exec(auto);
      if (!m) continue;
      const [, digest, ruleId, rulesDigest] = m as unknown as [string, string, string, string];
      if (row.deliveryOutcome !== "posted") {
        const waited = now() - new Date(row.tsCreated).getTime();
        if (row.deliveryOutcome === "transport-failed" || row.deliveryOutcome === "never-posted" || waited > REPORT_WAIT_MS) {
          await finish("held report not posted", "Held: this auto-send report did not reach Slack, so nothing was sent.",
            `Auto-send ${qitem_id} held before sending: its Slack report was not posted. Nothing sent; submit it again as a --human-send card.`);
        }
        continue;
      }
      const payload = loadPayload(deps.storeDir, digest);
      const verdict = payload ? autoSendRuleFor(repo, deps.rulesPath, row.sourceSession, payload) : { none: "the stored payload is missing or changed" };
      if (!payload || "none" in verdict || verdict.rule.id !== ruleId || verdict.rulesDigest !== rulesDigest) {
        const why = "none" in verdict ? verdict.none : "the enabled rules changed since it was queued";
        await finish(`held ${why}`, `Held: ${why}. Nothing was sent.`, `Auto-send ${qitem_id} held: ${why}. Nothing sent; submit it as a --human-send card.`);
        continue;
      }
      if (!reserveSlot(repo, qitem_id, verdict.rule, now())) {
        await finish(`held cap ${verdict.rule.dailyCap}`, `Held: rule \`${ruleId}\` already used its ${verdict.rule.dailyCap} sends today. Nothing was sent.`,
          `Auto-send ${qitem_id} held: rule ${ruleId} reached its daily cap of ${verdict.rule.dailyCap}. Nothing sent; submit it as a --human-send card.`);
        continue;
      }
      const result = await sendOnce(repo, deps, qitem_id, payload!, digest);
      const lines = sendLines(result, payload!.to.join(", "));
      await finish(`${describe(result)} rule=${ruleId}`, `${lines.thread} Rule \`${ruleId}\`.`, `${lines.seat} Rule ${ruleId}.`);
    }
  }
}

export const humanSendPaths = (home: string) => ({ storeDir: join(home, "human-send", "payloads"), rulesPath: join(home, "human-send", "auto-send-rules.json") });
