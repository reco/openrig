// Phase 1 — the lifecycle of a human request: its Slack thread stays open until the outcome it is
// linked to is finished (PR merged or closed, issue closed, queue work done or canceled) or the
// asked human cancels it. Answering a decision does not close it. A request that goes quiet for
// `staleReminderDays` gets one reminder per quiet interval: the human while the decision is
// unanswered, the owning seat (through the queue) once it is answered. Nothing here times out.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { QueueRepository, RequestLink } from "../../queue-repository.js";
import type { ThreadMapping, ThreadSeatMap } from "./thread-seat-map.js";
import { escapeSlackText, redactSecrets } from "./message.js";

export type { RequestLink } from "../../queue-repository.js";
export type LinkState = "open" | "merged" | "closed" | "done" | "canceled" | "unknown";

export const REQUEST_CLOSED_PREFIX = "request-closed";
export const REQUEST_REMINDER_PREFIX = "request-reminder";
export const CARD_CLOSED_PREFIX = "slack-card-closed";
export const CARD_CLOSE_FAILED_PREFIX = "slack-card-close-failed";
const DAY_MS = 24 * 60 * 60 * 1000;
const FINISHED: readonly LinkState[] = ["merged", "closed", "done", "canceled"];

export interface RequestLifecycleDeps {
  queueRepo: QueueRepository;
  threadMap: ThreadSeatMap;
  staleReminderDays: number;
  /** Requests whose root was posted before this instant predate the lifecycle and are left alone. */
  floorMs?: number;
  /** State of a PR or issue link (queue links are read from the queue itself). */
  linkState: (link: RequestLink) => Promise<LinkState>;
  postInThread: (channel: string, threadTs: string, text: string) => Promise<boolean>;
  /** Rewrite the request's own card without buttons and with this closing line; the message ts it
   *  rewrote, null when it has no card, or an error. */
  closeCard?: (qitemId: string, channel: string, line: string) => Promise<{ ok: true; messageTs: string | null } | { ok: false; messageTs: string; error: string }>;
  log?: (msg: string) => void;
}

/** When the request's current gate opened: its latest park, or its creation for a direct request.
 *  Anything said or offered before this instant belongs to an earlier gate. */
export function gateOpenedAt(repo: QueueRepository, qitemId: string): string {
  return lastPark(repo, qitemId)?.ts ?? repo.getById(qitemId)?.tsCreated ?? "";
}

/** Whether the request's current gate has been answered (an earlier gate's answer does not count). */
export function currentGateResolved(repo: QueueRepository, qitemId: string): boolean {
  const parkId = lastPark(repo, qitemId)?.transitionId ?? -1;
  return repo.transitionLog.listForQitem(qitemId).some((t) => t.ownerNotificationKind === "human-decision-resolved" && t.transitionId > parkId);
}

/** The latest transition INTO blocked. Every transition records the row's state, so a note on a
 *  blocked row is not a new park. */
function lastPark(repo: QueueRepository, qitemId: string): { ts: string; transitionId: number } | undefined {
  const transitions = [...repo.transitionLog.listForQitem(qitemId)].sort((a, b) => a.transitionId - b.transitionId);
  return transitions.filter((t, i) => t.state === "blocked" && transitions[i - 1]?.state !== "blocked").at(-1);
}

export const entityOf = (session: string | null | undefined): string => (session ?? "").split("@")[0] ?? "";

/** A request to the thread's human, not a thread the human started (that is conversation: nothing to close or remind). */
export function isRequestToHuman(item: { humanIntent?: string | null; sourceSession: string } | null, root: ThreadMapping): boolean {
  return !!item && item.humanIntent !== "update" && entityOf(item.sourceSession) !== entityOf(root.human);
}

/** The request's asked human, as recorded on its thread when it was posted. */
export function isRequestHuman(root: ThreadMapping, actorSession: string): boolean {
  return entityOf(root.human) !== "" && entityOf(root.human) === entityOf(actorSession);
}

async function stateOf(deps: RequestLifecycleDeps, link: RequestLink): Promise<LinkState> {
  if (link.kind !== "qitem") return deps.linkState(link);
  const state = deps.queueRepo.getById(link.ref)?.state;
  return state === "done" || state === "canceled" ? state : "open";
}

function describeClose(reason: string): string {
  if (reason === "linked-outcome-finished") return "the linked work is finished.";
  const expired = /^approval-expired: (.*)$/s.exec(reason);
  if (expired) return `expired, ${expired[1]}.`;
  if (reason === "canceled-by-seat") return "canceled by the asking seat.";
  const human = /^canceled-by-human(?:: (.*))?$/s.exec(reason);
  if (human) return human[1] ? `canceled (${human[1]})` : "canceled.";
  return reason;
}

/** Close a request: its thread map rows, an unanswered direct request's row, a note on the row
 *  and a closing line in the thread. `canceled` marks the row canceled instead of done. */
export async function closeRequest(deps: RequestLifecycleDeps, root: ThreadMapping, reason: string, actorSession: string, canceled = false): Promise<void> {
  // Closing twice (a sweep that listed the thread before another close landed) says nothing new.
  if (deps.threadMap.resolveByThread(root.threadTs)?.state === "closed") return;
  const item = deps.queueRepo.getById(root.conversationId);
  // An approval the daemon expired was not canceled by its seat: say what happened.
  const expiry = reason === "canceled-by-seat"
    ? [...deps.queueRepo.transitionLog.listForQitem(root.conversationId)].reverse().find((t) => t.transitionNote?.startsWith("approval expired: "))?.transitionNote
    : undefined;
  if (expiry) reason = `approval-expired: ${expiry.slice("approval expired: ".length)}`;
  const active = item && ["pending", "in-progress"].includes(item.state) && item.destinationSession === root.human;
  deps.queueRepo.update({
    qitemId: root.conversationId,
    actorSession,
    transitionNote: `${REQUEST_CLOSED_PREFIX} reason=${reason}`,
    ...(active ? (canceled ? { state: "canceled" as const } : { state: "done" as const, closureReason: "no-follow-on" }) : {}),
  });
  deps.threadMap.closeConversation(root.conversationId);
  if (item?.state === "blocked" && !currentGateResolved(deps.queueRepo, root.conversationId)) {
    await deps.queueRepo.create({
      sourceSession: "daemon@kernel",
      destinationSession: root.seat,
      tags: [REQUEST_CLOSED_PREFIX],
      summary: `Request ${root.conversationId} closed while parked`,
      body: `${root.conversationId} was closed (${reason}) while still parked on the human. Its Slack thread no longer answers the gate, so nothing will resume it from there: unblock it or ask again. Closing authorized nothing.`,
      nudge: true,
    });
  }
  // An expired approval also says where its prompt went, on its card (retried until it lands) and in its
  // thread (the note used to be a separate post, which found this thread closed and became a new top-level message).
  const where = expiry ? ` Approve / Deny here no longer does anything; the prompt is waiting in the terminal: tmux attach -t ${root.seat}` : "";
  await closeCard(deps, root.conversationId, root.channel, `Closed: ${describeClose(reason)}${where}`);
  const posted = await deps.postInThread(root.channel, root.threadTs, escapeSlackText(redactSecrets(`Closed: ${describeClose(reason)}${where}`)));
  if (!posted) deps.log?.(`request ${root.conversationId} closed; the closing line was not posted`);
}

/** Its buttons can no longer do anything, so they go; the outcome is recorded on the row, and a
 *  failed rewrite is retried by the sweep until it lands. */
async function closeCard(deps: RequestLifecycleDeps, qitemId: string, channel: string, line: string): Promise<void> {
  if (!deps.closeCard) return;
  const r = await deps.closeCard(qitemId, channel, line).catch((e: Error) => ({ ok: false as const, messageTs: "?", error: e.message }));
  if (r.ok && r.messageTs === null) return;
  // Only a passing failure (rate limit, timeout, network, Slack trouble) is worth another try.
  const retry = !r.ok && /ratelimit|timeout|timed out|transport|fetch|network|internal_error|service_unavailable|fatal_error|http 5\d\d/i.test(r.error);
  const note = r.ok
    ? `${CARD_CLOSED_PREFIX} channel=${channel} message_ts=${r.messageTs} line=${JSON.stringify(line)}`
    : `${CARD_CLOSE_FAILED_PREFIX} channel=${channel} message_ts=${r.messageTs} retry=${retry} line=${JSON.stringify(line)} error=${r.error}`;
  deps.queueRepo.update({ qitemId, actorSession: "daemon@kernel", transitionNote: note });
  if (!r.ok) deps.log?.(`request ${qitemId}: its card still shows buttons (${r.error})${retry ? "; retried on the next sweep" : ""}`);
}

/** Cards whose last rewrite failed, with the line it was to show. */
function cardsToRetry(deps: RequestLifecycleDeps): Array<{ qitemId: string; channel: string; line: string }> {
  const rows = deps.queueRepo.db.prepare(
    `SELECT t.qitem_id AS qitemId, t.transition_note AS note FROM queue_transitions t
      WHERE t.actor_session = 'daemon@kernel' AND (t.transition_note LIKE ? OR t.transition_note LIKE ?)
        AND t.transition_id = (SELECT MAX(u.transition_id) FROM queue_transitions u WHERE u.qitem_id = t.qitem_id AND u.actor_session = 'daemon@kernel'
          AND (u.transition_note LIKE ? OR u.transition_note LIKE ?))`,
  ).all(`${CARD_CLOSED_PREFIX} %`, `${CARD_CLOSE_FAILED_PREFIX} %`, `${CARD_CLOSED_PREFIX} %`, `${CARD_CLOSE_FAILED_PREFIX} %`) as Array<{ qitemId: string; note: string }>;
  return rows.filter((r) => r.note.startsWith(`${CARD_CLOSE_FAILED_PREFIX} `) && r.note.includes(" retry=true ") && deps.queueRepo.getById(r.qitemId)).flatMap((r) => {
    const channel = /\bchannel=(\S+)/.exec(r.note)?.[1];
    const line = /\bline=("(?:[^"\\]|\\.)*")/.exec(r.note)?.[1];
    return channel && line ? [{ qitemId: r.qitemId, channel, line: JSON.parse(line) as string }] : [];
  });
}

async function remind(deps: RequestLifecycleDeps, root: ThreadMapping, days: number): Promise<void> {
  const item = deps.queueRepo.getById(root.conversationId);
  if (currentGateResolved(deps.queueRepo, root.conversationId)) {
    await deps.queueRepo.create({
      sourceSession: "daemon@kernel",
      destinationSession: root.seat,
      tags: [REQUEST_REMINDER_PREFIX],
      summary: `Request ${root.conversationId} answered but still open`,
      body: `The human answered ${root.conversationId} (${item?.summary ?? "no summary"}), but its thread has been quiet for ${days} days and is still open. Link its outcome with rig queue update ${root.conversationId} --link pr:<url>|issue:<url>|qitem:<id>, or cancel it with rig queue update ${root.conversationId} --state canceled. This reminder closes nothing.`,
      nudge: true,
    });
    deps.queueRepo.update({ qitemId: root.conversationId, actorSession: "daemon@kernel", transitionNote: `${REQUEST_REMINDER_PREFIX} target=seat days=${days}` });
    return;
  }
  const text = `⏰ *Still waiting on your decision* (${days} quiet days). Use the buttons above, or reply \`cancel\` to close it.`;
  if (!(await deps.postInThread(root.channel, root.threadTs, text))) return;
  deps.queueRepo.update({ qitemId: root.conversationId, actorSession: "daemon@kernel", transitionNote: `${REQUEST_REMINDER_PREFIX} target=human days=${days}` });
}

export async function sweepRequests(deps: RequestLifecycleDeps, now = new Date()): Promise<{ closed: string[]; reminded: string[] }> {
  const closed: string[] = [];
  const reminded: string[] = [];
  for (const card of cardsToRetry(deps)) await closeCard(deps, card.qitemId, card.channel, card.line);
  for (const root of deps.threadMap.listOpenConversations()) {
    if (Number(root.threadTs) * 1000 < (deps.floorMs ?? 0)) continue;
    try {
      const item = deps.queueRepo.getById(root.conversationId);
      if (!item || !isRequestToHuman(item, root)) continue;
      if (item.state === "canceled") {
        await closeRequest(deps, root, "canceled-by-seat", "daemon@kernel");
        closed.push(root.conversationId);
        continue;
      }
      const links = deps.queueRepo.requestLinks(root.conversationId);
      if (links.length > 0) {
        const states = await Promise.all(links.map((link) => stateOf(deps, link)));
        if (states.every((s) => FINISHED.includes(s))) {
          await closeRequest(deps, root, "linked-outcome-finished", "daemon@kernel");
          closed.push(root.conversationId);
          continue;
        }
      }
      const quietSince = Date.parse(deps.queueRepo.requestActivityAt(root.conversationId) ?? root.openedAt);
      if (now.getTime() - quietSince >= deps.staleReminderDays * DAY_MS) {
        await remind(deps, root, deps.staleReminderDays);
        reminded.push(root.conversationId);
      }
    } catch (e) {
      deps.log?.(`request sweep failed for ${root.conversationId}: ${(e as Error).message}`);
    }
  }
  return { closed, reminded };
}

const execFileAsync = promisify(execFile);

/** Production link state through the GitHub CLI. Any failure is `unknown`: the request stays open. */
export async function githubLinkState(link: RequestLink): Promise<LinkState> {
  try {
    const { stdout } = await execFileAsync("gh", [link.kind === "pr" ? "pr" : "issue", "view", link.ref, "--json", "state"], { timeout: 30_000 });
    const state = String((JSON.parse(stdout) as { state?: unknown }).state ?? "").toUpperCase();
    return state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : state === "OPEN" ? "open" : "unknown";
  } catch {
    return "unknown";
  }
}
