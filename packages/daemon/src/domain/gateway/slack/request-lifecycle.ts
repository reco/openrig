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
  log?: (msg: string) => void;
}

/** When the request's current gate opened: its latest park, or its creation for a direct request.
 *  Anything said or offered before this instant belongs to an earlier gate. */
export function gateOpenedAt(repo: QueueRepository, qitemId: string): string {
  const parks = repo.transitionLog.listForQitem(qitemId).filter((t) => t.state === "blocked").map((t) => t.ts).sort();
  return parks.at(-1) ?? repo.getById(qitemId)?.tsCreated ?? "";
}

/** Whether the request's current gate has been answered (an earlier gate's answer does not count). */
export function currentGateResolved(repo: QueueRepository, qitemId: string): boolean {
  const transitions = repo.transitionLog.listForQitem(qitemId);
  const lastPark = Math.max(-1, ...transitions.filter((t) => t.state === "blocked").map((t) => t.transitionId));
  return transitions.some((t) => t.ownerNotificationKind === "human-decision-resolved" && t.transitionId > lastPark);
}

const entityOf = (session: string | null | undefined): string => (session ?? "").split("@")[0] ?? "";

/** The request's asked human, as recorded on its thread when it was posted. */
export function isRequestHuman(root: ThreadMapping, actorSession: string): boolean {
  return entityOf(root.human) !== "" && entityOf(root.human) === entityOf(actorSession);
}

async function stateOf(deps: RequestLifecycleDeps, link: RequestLink): Promise<LinkState> {
  if (link.kind !== "qitem") return deps.linkState(link);
  const state = deps.queueRepo.getById(link.ref)?.state;
  return state === "done" || state === "canceled" ? state : "open";
}

/** Close a request: its thread map rows, an unanswered direct request's row, a note on the row
 *  and a closing line in the thread. `canceled` marks the row canceled instead of done. */
export async function closeRequest(deps: RequestLifecycleDeps, root: ThreadMapping, reason: string, actorSession: string, canceled = false): Promise<void> {
  const item = deps.queueRepo.getById(root.conversationId);
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
  const posted = await deps.postInThread(root.channel, root.threadTs, escapeSlackText(redactSecrets(`Closed: ${reason.replaceAll("-", " ")}.`)));
  if (!posted) deps.log?.(`request ${root.conversationId} closed; the closing line was not posted`);
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
  const text = `Reminder: this is still waiting on you (${days} quiet days). To decide, reply in this thread starting with \`answer:\`, or reply \`cancel\` to close it.`;
  if (!(await deps.postInThread(root.channel, root.threadTs, text))) return;
  deps.queueRepo.update({ qitemId: root.conversationId, actorSession: "daemon@kernel", transitionNote: `${REQUEST_REMINDER_PREFIX} target=human days=${days}` });
}

export async function sweepRequests(deps: RequestLifecycleDeps, now = new Date()): Promise<{ closed: string[]; reminded: string[] }> {
  const closed: string[] = [];
  const reminded: string[] = [];
  for (const root of deps.threadMap.listOpenConversations()) {
    if (Number(root.threadTs) * 1000 < (deps.floorMs ?? 0)) continue;
    try {
      const item = deps.queueRepo.getById(root.conversationId);
      if (!item || item.humanIntent === "update") continue;
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
