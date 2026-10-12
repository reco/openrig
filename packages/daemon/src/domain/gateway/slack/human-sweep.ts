// A human's old Slack to-dos, cleared in one pass: a conversation whose row is finished or answered
// closes (its card loses its buttons, its root gets the done reaction, no thread post), and a request
// a newer one from the same seat with the same summary replaced is canceled.
import type { QueueRepository } from "../../queue-repository.js";
import type { ThreadSeatMap } from "./thread-seat-map.js";
import { currentGateResolved } from "./request-lifecycle.js";

export interface HumanSweepEntry {
  qitemId: string;
  summary: string | null;
  tsCreated: string;
  action: "close-thread" | "cancel";
  reason: string;
}

const FINISHED = ["done", "canceled", "handed-off", "failed", "denied"];

export function planHumanSweep(repo: QueueRepository, threadMap: ThreadSeatMap, destination: string, before: string): HumanSweepEntry[] {
  const superseded = repo.db.prepare(
    `SELECT q.qitem_id AS qitemId, q.summary, q.ts_created AS tsCreated,
       (SELECT n.qitem_id FROM queue_items n WHERE n.source_session = q.source_session AND n.destination_session = q.destination_session
          AND n.summary = q.summary AND n.ts_created > q.ts_created ORDER BY n.ts_created DESC LIMIT 1) AS newer
     FROM queue_items q WHERE q.destination_session = ? AND q.state IN ('pending', 'in-progress') AND q.ts_created < ? AND q.summary IS NOT NULL`,
  ).all(destination, before) as Array<{ qitemId: string; summary: string; tsCreated: string; newer: string | null }>;
  const entries: HumanSweepEntry[] = superseded.filter((r) => r.newer)
    .map((r) => ({ qitemId: r.qitemId, summary: r.summary, tsCreated: r.tsCreated, action: "cancel", reason: `superseded by ${r.newer}` }));
  const canceling = new Set(entries.map((e) => e.qitemId));
  for (const root of threadMap.listOpenConversations()) {
    const item = repo.getById(root.conversationId);
    if (root.human !== destination || !item || item.tsCreated >= before || canceling.has(item.qitemId)) continue;
    const finished = FINISHED.includes(item.state);
    if (!finished && !currentGateResolved(repo, item.qitemId)) continue;
    entries.push({ qitemId: item.qitemId, summary: item.summary ?? null, tsCreated: item.tsCreated, action: "close-thread", reason: finished ? `row ${item.state}` : "answered" });
  }
  return entries.sort((a, b) => (a.tsCreated < b.tsCreated ? -1 : 1));
}

export async function applyHumanSweep(entries: HumanSweepEntry[], deps: {
  repo: QueueRepository;
  actorSession: string;
  closeThread: (qitemId: string) => Promise<void>;
  pauseMs: number;
  log: (msg: string) => void;
}): Promise<void> {
  for (const [i, entry] of entries.entries()) {
    try {
      if (entry.action === "cancel") {
        deps.repo.update({ qitemId: entry.qitemId, actorSession: deps.actorSession, state: "canceled", transitionNote: `swept: ${entry.reason}` });
      } else {
        await deps.closeThread(entry.qitemId);
      }
    } catch (error) {
      deps.log(`human sweep ${entry.qitemId} failed: ${(error as Error).message}`);
    }
    // Slack's per-method limits: a card rewrite and a reaction per conversation, spaced out.
    if (i < entries.length - 1) await new Promise((r) => setTimeout(r, deps.pauseMs));
  }
  deps.log(`human sweep finished: ${entries.length} rows`);
}
