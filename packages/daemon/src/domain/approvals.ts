// Approvals without a terminal: a seat that opted in sends its permission prompt here (its
// PermissionRequest hook waits on the answer). The human gets Approve / Deny buttons with the
// full command or tool input, literal credentials masked; the click is returned to the hook. No
// answer before the deadline (approvalTimeoutSeconds), or a hook that stops asking, expires the
// request with a note in its thread, and the prompt shows in the terminal as before.
// This answers permission prompts only: it cannot override a runtime's own safety denials.

import { createHash } from "node:crypto";
import type { QueueRepository } from "./queue-repository.js";
import { maskSecrets } from "./credential-mask.js";
import { SLACK_SECTION_CAP, escapeSlackText, redactSecrets } from "./gateway/slack/message.js";

export type ApprovalDecision = "allow" | "deny";
export type ApprovalWait = ApprovalDecision | "pending" | "expired";

export interface ApprovalRequest {
  sessionName: string;
  toolName: string;
  toolInput: unknown;
}

export interface ApprovalServiceDeps {
  queueRepo: QueueRepository;
  /** Seats that opted in to Slack approvals (session names). */
  optedIn: () => readonly string[];
  /** The human who may answer: the registered approver's address, or null. */
  approver: () => string | null;
  /** True only when the token is the named seat's own (bound to its node, name and generation). */
  verifySeat: (sessionName: string, seatToken: string | null) => boolean;
  /** The seat's working directory, shown on the card. */
  cwdOf?: (sessionName: string) => string | null;
  /** Read at each check, so a config change applies to open requests too. */
  timeoutMs?: () => number;
  pollMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface ApprovalService {
  verify: (sessionName: string, seatToken: string | null) => boolean;
  start: (input: ApprovalRequest) => Promise<string | null>;
  /** Only the seat that asked may wait on its request. */
  wait: (requestId: string, sessionName: string, sliceMs: number) => Promise<ApprovalWait>;
  /** Expire every open request whose deadline passed or whose hook stopped asking (killed,
   *  answered in the terminal, an older hook that gave up, a daemon restart). */
  sweep: () => Promise<void>;
}

/** A hook asks again within a minute (one wait slice); twice that without a call means it is gone. */
export const APPROVAL_ABANDONED_MS = 120_000;

export const APPROVAL_TIMEOUT_MS = 1_800_000;
const QUESTION_ID = "approval";
const MAX_PENDING_PER_SEAT = 3;

/** What the human approves, in full: the command or patch text as written (Bash, Codex's
 *  apply_patch), else the tool input as JSON. */
export function approvalText(toolName: string, toolInput: unknown): string {
  const input = toolInput as { command?: unknown } | null;
  const raw = typeof input?.command === "string" ? input.command : JSON.stringify(toolInput ?? {}, null, 2);
  return maskSecrets(raw).replace(/```/g, "`​``");
}

/** Codex says why it asks: a network grant ("network-access <target>") or the agent's justification. */
function approvalReason(toolInput: unknown): string | null {
  const description = (toolInput as { description?: unknown } | null)?.description;
  if (typeof description !== "string" || !description.trim()) return null;
  const target = /^network-access\s+(.+)$/.exec(description.trim())?.[1];
  return maskSecrets(target ? `*Network access to ${target}*` : `Reason: ${description.trim()}`).replace(/`/g, "'");
}

export function makeApprovalService(deps: ApprovalServiceDeps): ApprovalService {
  const log = deps.log ?? (() => {});
  const timeoutMs = deps.timeoutMs ?? (() => APPROVAL_TIMEOUT_MS);
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const lastAsked = new Map<string, number>();
  const expire = async (requestId: string, why: string) => {
    lastAsked.delete(requestId);
    const item = deps.queueRepo.getById(requestId);
    // An answer already given stands: the hook returns it, whatever closes the row afterwards.
    if (!item || item.state !== "pending" || item.humanAnswers?.[QUESTION_ID]) return;
    deps.queueRepo.update({ qitemId: requestId, actorSession: "daemon@kernel", state: "canceled", transitionNote: `approval expired: ${why}` });
    await deps.queueRepo.create({
      sourceSession: item.sourceSession, destinationSession: item.destinationSession, humanIntent: "update", replyTo: requestId,
      summary: "Expired", body: `Not used: ${why}. Approve / Deny here no longer does anything; the prompt is waiting in the terminal: tmux attach -t ${item.sourceSession}`, nudge: false,
    }).catch(() => {});
  };
  const service: ApprovalService = {
    verify: (sessionName, seatToken) => deps.verifySeat(sessionName, seatToken),
    async start(input) {
      if (!deps.optedIn().includes(input.sessionName)) return null;
      const human = deps.approver();
      if (!human) return null;
      const cwd = deps.cwdOf?.(input.sessionName);
      const reason = approvalReason(input.toolInput);
      const body = `${cwd ? `In \`${cwd.replace(/`/g, "")}\`\n` : ""}${reason ? `${reason}\n` : ""}\`\`\`\n${approvalText(input.toolName, input.toolInput)}\n\`\`\``;
      if (escapeSlackText(redactSecrets(body)).length > SLACK_SECTION_CAP) {
        log(`approval for ${input.sessionName} not sent: the ${input.toolName} input is too long to show in full`);
        return null;
      }
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
        tags: ["approval-request"],
        humanQuestions: [{ id: QUESTION_ID, question: `Allow ${input.sessionName} to run this ${input.toolName}?`, options: [{ id: "allow", label: "Approve" }, { id: "deny", label: "Deny" }] }],
        nudge: false,
      });
      return qitemId;
    },
    async sweep() {
      const open = deps.queueRepo.list({ tag: "approval-request", state: "pending", limit: 200 }).filter((q) => q.state === "pending" && q.tags?.includes("approval-request"));
      for (const item of open) {
        if (now() - Date.parse(item.tsCreated) >= timeoutMs()) await expire(item.qitemId, "no answer in time");
        else if (now() - (lastAsked.get(item.qitemId) ?? Math.max(startedAt, Date.parse(item.tsCreated))) >= APPROVAL_ABANDONED_MS) await expire(item.qitemId, "the seat stopped waiting for it");
      }
    },
    async wait(requestId, sessionName, sliceMs) {
      const sliceEnd = Date.now() + sliceMs;
      lastAsked.set(requestId, now());
      for (;;) {
        const item = deps.queueRepo.getById(requestId);
        if (!item?.tags?.includes("approval-request") || item.sourceSession !== sessionName) return "expired";
        const answer = item.humanAnswers?.[QUESTION_ID];
        if (answer === "allow" || answer === "deny") {
          if (!deps.queueRepo.transitionLog.listForQitem(requestId).some((t) => t.transitionNote?.startsWith("approval "))) {
            deps.queueRepo.update({ qitemId: requestId, actorSession: "daemon@kernel", transitionNote: `approval ${answer} by ${item.destinationSession} for ${item.summary ?? "the request"}` });
          }
          return answer;
        }
        if (item.state !== "pending" || item.deliveryOutcome === "transport-failed") return "expired";
        if (now() - Date.parse(item.tsCreated) >= timeoutMs()) {
          await expire(requestId, "no answer in time");
          return "expired";
        }
        if (Date.now() >= sliceEnd) { lastAsked.set(requestId, now()); return "pending"; }
        await new Promise((r) => setTimeout(r, deps.pollMs ?? 500));
      }
    },
  };
  return service;
}
