// The weekly 👍/👎 report to the human: Monday from 09:00 daemon-local time, once per week (the
// report row's id is the week's Monday), from the human-feedback transitions of the last 7 days.
// Rides the watchdog scheduler on an hourly job; no loop of its own.

import type { QueueRepository } from "../queue-repository.js";
import { isHumanSeatSessionRef } from "../session-name.js";
import type { Policy, PolicyJob, PolicyEvaluation } from "./types.js";

export const HUMAN_FEEDBACK_REPORT_POLICY = "human-feedback-report";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface RegistrySurfaceLike {
  loadHumanRegistry: (home: string) => { ok: boolean; entities?: Array<{ address: string; role?: string }> };
}

export interface HumanFeedbackReportDeps {
  queueRepo: QueueRepository;
  registry: RegistrySurfaceLike;
  home: string;
  permalink?: (channel: string, messageTs: string) => Promise<string | null>;
  now?: () => Date;
}

interface Feedback { qitemId: string; reaction: string; messageTs: string; channel: string | null }

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function feedbackSince(repo: QueueRepository, since: Date): Feedback[] {
  const rows = repo.db.prepare(
    `SELECT qitem_id, transition_note FROM queue_transitions WHERE transition_note LIKE 'human-feedback %' AND ts >= ?`,
  ).all(since.toISOString()) as Array<{ qitem_id: string; transition_note: string }>;
  return rows.map((r) => {
    const field = (name: string) => new RegExp(`\\b${name}=(\\S+)`).exec(r.transition_note)?.[1] ?? null;
    return { qitemId: r.qitem_id, reaction: field("reaction") ?? "", messageTs: field("message_ts") ?? "", channel: field("channel") };
  });
}

export async function runHumanFeedbackReport(deps: HumanFeedbackReportDeps): Promise<{ posted: string | null; reason: string }> {
  const now = deps.now?.() ?? new Date();
  if (now.getDay() !== 1 || now.getHours() < 9) return { posted: null, reason: "not Monday 09:00 yet" };
  const reportId = `qitem-feedback-report-${localDay(now)}`;
  if (deps.queueRepo.getById(reportId)) return { posted: null, reason: "already reported this week" };
  const reg = deps.registry.loadHumanRegistry(deps.home);
  const human = reg.ok ? reg.entities?.find((e) => e.role !== "requester") : undefined;
  if (!human) return { posted: null, reason: "no approver registered" };
  const feedback = feedbackSince(deps.queueRepo, new Date(now.getTime() - WEEK_MS));
  if (feedback.length === 0) return { posted: null, reason: "no feedback this week" };

  const perSeat = new Map<string, { up: number; down: number }>();
  const perMessage = new Map<string, Feedback & { score: number; summary: string }>();
  for (const f of feedback) {
    const item = deps.queueRepo.getById(f.qitemId);
    const seat = item ? (item.blockedOn || isHumanSeatSessionRef(item.sourceSession) ? item.destinationSession : item.sourceSession) : "(unknown seat)";
    const tally = perSeat.get(seat) ?? { up: 0, down: 0 };
    if (f.reaction === "+1") tally.up++; else if (f.reaction === "-1") tally.down++;
    perSeat.set(seat, tally);
    const key = `${f.qitemId}:${f.messageTs}`;
    const message = perMessage.get(key) ?? { ...f, score: 0, summary: item?.summary ?? f.qitemId };
    message.score += f.reaction === "+1" ? 1 : f.reaction === "-1" ? -1 : 0;
    perMessage.set(key, message);
  }
  const seats = [...perSeat.entries()].sort(([a], [b]) => a.localeCompare(b));
  const lowest = [...perMessage.values()].filter((m) => m.score < 0).sort((a, b) => a.score - b.score).slice(0, 3);
  const links = await Promise.all(lowest.map(async (m) => (m.channel && deps.permalink ? await deps.permalink(m.channel, m.messageTs).catch(() => null) : null)));
  const total = seats.reduce((sum, [, t]) => ({ up: sum.up + t.up, down: sum.down + t.down }), { up: 0, down: 0 });

  const items = [
    ...seats.map(([seat, t]) => `*\`${seat}\`:* 👍 ${t.up} · 👎 ${t.down}`),
    ...lowest.map((m, i) => `*Lowest rated:* ${m.summary} (score ${m.score})${links[i] ? ` ${links[i]}` : ""}`),
  ];
  const lines = items.map((item, i) => `${i + 1}. ${item}`);
  await deps.queueRepo.create({
    qitemId: reportId,
    sourceSession: "daemon@kernel",
    destinationSession: human.address,
    humanIntent: "update",
    summary: `Weekly feedback, last 7 days: 👍 ${total.up} · 👎 ${total.down}`,
    body: lines.join("\n"),
    nudge: false,
  });
  return { posted: reportId, reason: `reported ${feedback.length} reactions` };
}

export function makeHumanFeedbackReportPolicy(deps: HumanFeedbackReportDeps): Policy {
  return {
    name: HUMAN_FEEDBACK_REPORT_POLICY,
    async evaluate(_job: PolicyJob): Promise<PolicyEvaluation> {
      const r = await runHumanFeedbackReport(deps);
      return { action: "skip", reason: r.reason };
    },
  } as Policy;
}
