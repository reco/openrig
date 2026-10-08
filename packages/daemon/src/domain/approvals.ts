// Approvals without a terminal: a seat that opted in sends its permission prompt here (its
// PermissionRequest hook waits on the answer). The human gets Approve / Deny buttons with the
// full command or tool input, credentials masked; the click is returned to the hook. No answer
// before the hook's timeout returns nothing, and the prompt shows in the terminal as before.
// This answers permission prompts only: it cannot override a runtime's own safety denials.

import { createHash } from "node:crypto";
import type { QueueRepository } from "./queue-repository.js";
import { maskSecrets } from "./credential-mask.js";
import { SLACK_SECTION_CAP } from "./gateway/slack/message.js";

export type ApprovalDecision = "allow" | "deny";

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

export const APPROVAL_TIMEOUT_MS = 570_000;
const QUESTION_ID = "approval";

/** What the human approves, in full: the shell command, or the tool input as JSON. */
export function approvalText(toolName: string, toolInput: unknown): string {
  const input = toolInput as { command?: unknown } | null;
  const raw = toolName === "Bash" && typeof input?.command === "string" ? input.command : JSON.stringify(toolInput ?? {}, null, 2);
  return maskSecrets(raw);
}

export function makeApprovalService(deps: ApprovalServiceDeps): { request: (input: ApprovalRequest) => Promise<ApprovalDecision | null> } {
  const log = deps.log ?? (() => {});
  return {
    async request(input) {
      if (!deps.optedIn().includes(input.sessionName)) return null;
      const human = deps.approver();
      if (!human) return null;
      const shown = approvalText(input.toolName, input.toolInput);
      const body = `\`\`\`\n${shown}\n\`\`\``;
      if (body.length > SLACK_SECTION_CAP - 200) {
        log(`approval for ${input.sessionName} not sent: the ${input.toolName} input is too long to show in full`);
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
      const deadline = Date.now() + (deps.timeoutMs ?? APPROVAL_TIMEOUT_MS);
      while (Date.now() < deadline) {
        const item = deps.queueRepo.getById(qitemId);
        const answer = item?.humanAnswers?.[QUESTION_ID];
        if (answer === "allow" || answer === "deny") {
          deps.queueRepo.update({ qitemId, actorSession: "daemon@kernel", transitionNote: `approval ${answer} by ${human} for ${input.toolName}` });
          return answer;
        }
        if (!item || item.state !== "pending") return null;
        await new Promise((r) => setTimeout(r, deps.pollMs ?? 500));
      }
      const item = deps.queueRepo.getById(qitemId);
      if (item?.state === "pending") {
        deps.queueRepo.update({ qitemId, actorSession: "daemon@kernel", state: "canceled", transitionNote: "approval expired: the prompt is in the terminal" });
        await deps.queueRepo.create({
          sourceSession: input.sessionName, destinationSession: human, humanIntent: "update", replyTo: qitemId,
          summary: "Expired", body: `No answer in time; the prompt is waiting in the terminal: tmux attach -t ${input.sessionName}`, nudge: false,
        }).catch(() => {});
      }
      return null;
    },
  };
}
