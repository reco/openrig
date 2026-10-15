// Operator backfill (reco, Oct 15, qitem ace6c284): cards closed as answered in the terminal before the
// compact format get it now. Planning reads the queue only and selects a row only on its own ledger proof:
// the request was closed with an answered-in-the-terminal reason, nobody answered it, and it was not
// already compacted. Applying reads the card's thread first and writes only what differs: the bot's own
// closing reply becomes the details reply (or one is posted when there is none), then the card becomes one
// bold line. A card or reply already in the compact shape is kept as it is, so a rerun writes nothing.

import type Database from "better-sqlite3";
import { SLACK_SECTION_CAP, buildCompactClosedMessage } from "./message.js";
import { terminalLine, terminalReceipt } from "./request-lifecycle.js";

export const TERMINAL_CLOSE_NOTES = [
  "request-closed reason=prompt-cleared: answered in the terminal",
  "request-closed reason=approval-expired: answered in the terminal",
] as const;

export interface TerminalCardPlan {
  qitemId: string;
  channel: string;
  messageTs: string;
  provenance: "stuck-prompt" | "approval";
  line: string;
  receipt: string;
}

interface Row { qitem_id: string; source_session: string; body: string | null; tags: string | null; human_detail: string | null; human_answers: string | null }

const notesOf = (db: Database.Database, qitemId: string) =>
  (db.prepare("SELECT transition_note AS note FROM queue_transitions WHERE qitem_id = ? AND actor_session = 'daemon@kernel' AND transition_note IS NOT NULL ORDER BY transition_id")
    .all(qitemId) as Array<{ note: string }>).map((r) => r.note);

const field = (note: string | undefined, name: string) => note?.split(/\s+/).find((f) => f.startsWith(`${name}=`))?.slice(name.length + 1);

/** Every card closed as answered in the terminal that is not compact yet, oldest first; `only` narrows to named rows. */
export function planTerminalResolvedCards(db: Database.Database, only?: readonly string[]): TerminalCardPlan[] {
  const rows = db.prepare(`SELECT qitem_id, source_session, body, tags, human_detail, human_answers FROM queue_items q
    WHERE state = 'canceled' AND EXISTS (SELECT 1 FROM queue_transitions t WHERE t.qitem_id = q.qitem_id AND t.actor_session = 'daemon@kernel' AND t.transition_note IN (?, ?))
    ORDER BY ts_created, qitem_id`).all(...TERMINAL_CLOSE_NOTES) as Row[];
  return rows.flatMap((row) => {
    if (only && !only.includes(row.qitem_id)) return [];
    if (Object.keys(row.human_answers ? JSON.parse(row.human_answers) as object : {}).length > 0) return [];
    const notes = notesOf(db, row.qitem_id);
    if (notes.some((n) => n.startsWith("slack-card-closed ") && n.includes(" compact=true "))) return [];
    const receiptNote = [...notes].reverse().find((n) => n.startsWith("slack-owner-notification-posted ") && !/\skind=human-decision-resolved(\s|$)/.test(n));
    const messageTs = field(receiptNote, "message_ts");
    const channel = field(notes.find((n) => field(n, "message_ts") === messageTs && field(n, "channel")), "channel");
    if (!messageTs || !channel) return [];
    const item = { sourceSession: row.source_session, body: row.body ?? "", humanDetail: row.human_detail, tags: row.tags ? JSON.parse(row.tags) as string[] : [] };
    const provenance = notes.includes(TERMINAL_CLOSE_NOTES[1]) ? "approval" as const : "stuck-prompt" as const;
    return [{ qitemId: row.qitem_id, channel, messageTs, provenance, line: terminalLine(item), receipt: terminalReceipt(item) }];
  });
}

export interface SlackThreadOps {
  /** The app's own Slack user: only its messages are ever rewritten. */
  botUser: string;
  replies: (channel: string, ts: string) => Promise<{ ok: true; messages: Array<{ ts: string; user?: string; text?: string }> } | { ok: false; error: string }>;
  update: (channel: string, ts: string, message: { text: string; blocks: unknown[] }) => Promise<{ ok: boolean; error?: string }>;
  post: (channel: string, threadTs: string, text: string) => Promise<{ ok: true; ts: string } | { ok: false; error?: string }>;
}

export interface TerminalCardResult {
  qitemId: string;
  ok: boolean;
  card: "rewritten" | "kept" | "untouched";
  reply: "updated" | "posted" | "kept" | "untouched";
  error?: string;
  /** The ledger note to record on the row once the card is compact. */
  note?: string;
}

/** chat.update keeps a message's old blocks unless new ones are given, so the reply's text goes in sections
 *  (each within Slack's 3,000 limit, cut at a line end). */
function sections(text: string): unknown[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > SLACK_SECTION_CAP) {
    const cut = rest.lastIndexOf("\n", SLACK_SECTION_CAP);
    const at = cut > 0 ? cut : SLACK_SECTION_CAP;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  parts.push(rest);
  return parts.map((part) => ({ type: "section", text: { type: "mrkdwn", text: part } }));
}

const COMPACT_LINE = "Resolved in Terminal · ";
const DETAILS = "*What:* ";

/** The details reply first, then the card; a failure stops before the card, so it never loses its details. */
export async function applyTerminalResolvedCard(card: TerminalCardPlan, slack: SlackThreadOps): Promise<TerminalCardResult> {
  const result: TerminalCardResult = { qitemId: card.qitemId, ok: false, card: "untouched", reply: "untouched" };
  const thread = await slack.replies(card.channel, card.messageTs);
  if (!thread.ok) return { ...result, error: thread.error };
  const root = thread.messages.find((m) => m.ts === card.messageTs);
  if (!root || root.user !== slack.botUser) return { ...result, error: "the card is not the app's own message" };
  const closing = thread.messages.find((m) => m.ts !== root.ts && m.user === slack.botUser && (m.text?.startsWith("Closed: ") || m.text?.startsWith(DETAILS)));
  let replyTs = closing?.ts;
  if (closing?.text?.startsWith(DETAILS)) result.reply = "kept";
  else if (closing) {
    const r = await slack.update(card.channel, closing.ts, { text: card.receipt, blocks: sections(card.receipt) });
    if (!r.ok) return { ...result, error: `details reply: ${r.error ?? "update failed"}` };
    result.reply = "updated";
  } else {
    const r = await slack.post(card.channel, card.messageTs, card.receipt);
    if (!r.ok) return { ...result, error: `details reply: ${r.error ?? "post failed"}` };
    result.reply = "posted";
    replyTs = r.ts;
  }
  if (root.text?.startsWith(COMPACT_LINE)) result.card = "kept";
  else {
    const r = await slack.update(card.channel, card.messageTs, buildCompactClosedMessage(card.line));
    if (!r.ok) return { ...result, error: `card: ${r.error ?? "update failed"}` };
    result.card = "rewritten";
  }
  return { ...result, ok: true,
    note: `slack-card-closed channel=${card.channel} message_ts=${card.messageTs} compact=true line=${JSON.stringify(card.line)} backfill=true reply=${result.reply} reply_ts=${replyTs}` };
}
