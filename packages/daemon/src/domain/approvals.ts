// Approvals without a terminal: a seat that opted in sends its permission prompt here (its
// PermissionRequest hook waits on the answer). The human gets Approve / Deny buttons with the
// full command or tool input, literal credentials masked; the click is returned to the hook. No
// answer before the hook's timeout returns nothing, and the prompt shows in the terminal as before.
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
  timeoutMs?: number;
  pollMs?: number;
  log?: (msg: string) => void;
}

export interface ApprovalService {
  start: (input: ApprovalRequest) => Promise<string | null>;
  wait: (requestId: string, sliceMs: number) => Promise<ApprovalWait>;
}

export const APPROVAL_TIMEOUT_MS = 570_000;
const QUESTION_ID = "approval";
const MAX_PENDING_PER_SEAT = 3;

/** What the human approves, in full: the shell command, or the tool input as JSON. */
export function approvalText(toolName: string, toolInput: unknown): string {
  const input = toolInput as { command?: unknown } | null;
  const raw = toolName === "Bash" && typeof input?.command === "string" ? input.command : JSON.stringify(toolInput ?? {}, null, 2);
  return maskSecrets(raw).replace(/```/g, "`​``");
}

export function makeApprovalService(deps: ApprovalServiceDeps): ApprovalService {
  const log = deps.log ?? (() => {});
  const timeoutMs = deps.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  const service: ApprovalService = {
    async start(input) {
      if (!deps.optedIn().includes(input.sessionName)) return null;
      const human = deps.approver();
      if (!human) return null;
      const body = `\`\`\`\n${approvalText(input.toolName, input.toolInput)}\n\`\`\``;
      if (escapeSlackText(redactSecrets(body)).length > SLACK_SECTION_CAP) {
        log(`approval for ${input.sessionName} not sent: the ${input.toolName} input is too long to show in full`);
        return null;
      }
      const open = deps.queueRepo.list({ limit: 200 }).filter((q) => q.state === "pending" && q.sourceSession === input.sessionName && q.tags?.includes("approval-request"));
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
    async wait(requestId, sliceMs) {
      const sliceEnd = Date.now() + sliceMs;
      for (;;) {
        const item = deps.queueRepo.getById(requestId);
        if (!item?.tags?.includes("approval-request")) return "expired";
        const answer = item.humanAnswers?.[QUESTION_ID];
        if (answer === "allow" || answer === "deny") {
          if (!deps.queueRepo.transitionLog.listForQitem(requestId).some((t) => t.transitionNote?.startsWith("approval "))) {
            deps.queueRepo.update({ qitemId: requestId, actorSession: "daemon@kernel", transitionNote: `approval ${answer} by ${item.destinationSession} for ${item.summary ?? "the request"}` });
          }
          return answer;
        }
        if (item.state !== "pending" || item.deliveryOutcome === "transport-failed") return "expired";
        if (Date.now() - Date.parse(item.tsCreated) >= timeoutMs) {
          deps.queueRepo.update({ qitemId: requestId, actorSession: "daemon@kernel", state: "canceled", transitionNote: "approval expired: the prompt is in the terminal" });
          await deps.queueRepo.create({
            sourceSession: item.sourceSession, destinationSession: item.destinationSession, humanIntent: "update", replyTo: requestId,
            summary: "Expired", body: `No answer in time; the prompt is waiting in the terminal: tmux attach -t ${item.sourceSession}`, nudge: false,
          }).catch(() => {});
          return "expired";
        }
        if (Date.now() >= sliceEnd) return "pending";
        await new Promise((r) => setTimeout(r, deps.pollMs ?? 500));
      }
    },
  };
  return service;
}
