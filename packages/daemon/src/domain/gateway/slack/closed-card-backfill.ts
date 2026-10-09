// One-off retirement of approval cards that closed before closed cards lost their buttons: an
// expired, unanswered approval whose thread is already closed, so the request close path never
// runs for it again. Planning reads the queue only; applying rewrites each named card through the
// same render + chat.update a live close uses. Nothing else is selected: no answered or decided
// row, no Confirm offer, no resolved notice, no human-started message, no card already rewritten.

import type Database from "better-sqlite3";
import { attributionFromSession, buildOutboundMessage } from "./message.js";
import type { HumanQuestion } from "../../human-questions.js";
import { updateChatMessage } from "./slack-api.js";
import type { FetchImpl } from "./slack-api.js";

export interface ClosedCard {
  qitemId: string;
  channel: string;
  messageTs: string;
  line: string;
  message: { text: string; blocks: unknown[] };
}

interface Row {
  qitem_id: string; source_session: string; destination_session: string; summary: string | null; body: string;
  human_intent: string | null; human_questions: string | null; human_answers: string | null; human_confirm: string | null; tags: string | null; state: string;
}

const notesOf = (db: Database.Database, qitemId: string) =>
  db.prepare("SELECT actor_session AS actor, transition_note AS note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id").all(qitemId) as Array<{ actor: string; note: string | null }>;

/** The expired, unanswered approval cards still showing buttons; `only` narrows to named rows. */
export function planClosedApprovalCards(db: Database.Database, sourceLabel: string, only?: readonly string[]): ClosedCard[] {
  const rows = db.prepare(`SELECT qitem_id, source_session, destination_session, summary, body, human_intent, human_questions, human_answers, human_confirm, tags, state
    FROM queue_items WHERE state = 'canceled' AND EXISTS (SELECT 1 FROM json_each(queue_items.tags) WHERE value = 'approval-request')`).all() as Row[];
  return rows.flatMap((row) => {
    if (only && !only.includes(row.qitem_id)) return [];
    const answers = row.human_answers ? JSON.parse(row.human_answers) as Record<string, string> : {};
    if (Object.keys(answers).length > 0 || row.human_confirm || row.human_intent !== "decision") return [];
    const daemon = notesOf(db, row.qitem_id).filter((t) => t.actor === "daemon@kernel" && t.note);
    const expiry = daemon.find((t) => t.note!.startsWith("approval expired: "))?.note;
    if (!expiry || daemon.some((t) => t.note!.startsWith("slack-card-closed "))) return [];
    const receipt = [...daemon].reverse().find((t) => t.note!.startsWith("slack-owner-notification-posted ") && !/\skind=human-decision-resolved(\s|$)/.test(t.note!))?.note;
    const messageTs = receipt?.split(/\s+/).find((f) => f.startsWith("message_ts="))?.slice("message_ts=".length);
    const posted = daemon.find((t) => t.note!.startsWith("slack-posted ") && t.note!.includes(` message_ts=${messageTs} `))?.note;
    const channel = posted?.split(/\s+/).find((f) => f.startsWith("channel="))?.slice("channel=".length);
    if (!messageTs || !channel) return [];
    const line = `Closed: expired, ${expiry.slice("approval expired: ".length)}.`;
    const message = buildOutboundMessage({
      qitemId: row.qitem_id, summary: row.summary, body: row.body, humanIntent: row.human_intent,
      humanQuestions: row.human_questions ? JSON.parse(row.human_questions) as HumanQuestion[] : undefined,
      humanAnswers: answers, destinationSession: row.destination_session,
    }, { sourceLabel, attribution: attributionFromSession(row.source_session), closedNote: line });
    return [{ qitemId: row.qitem_id, channel, messageTs, line, message }];
  });
}

/** Rewrite each planned card; the result per card is what the operator records on its row. */
export async function retireClosedApprovalCards(cards: readonly ClosedCard[], botToken: string, fetchImpl?: FetchImpl): Promise<Array<{ qitemId: string; ok: boolean; error?: string; note: string }>> {
  const results = [];
  for (const card of cards) {
    const r = await updateChatMessage(botToken, { channel: card.channel, ts: card.messageTs, ...card.message }, fetchImpl);
    results.push({ qitemId: card.qitemId, ok: r.ok, ...(r.ok ? {} : { error: r.error }),
      note: `${r.ok ? "slack-card-closed" : "slack-card-close-failed"} channel=${card.channel} message_ts=${card.messageTs} line=${JSON.stringify(card.line)} backfill=true${r.ok ? "" : ` error=${r.error}`}` });
  }
  return results;
}
