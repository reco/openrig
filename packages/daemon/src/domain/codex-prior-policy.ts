import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import { resolveCodexDbPaths } from "./codex-thread-id.js";
import { shellQuote } from "../adapters/shell-quote.js";
import type { AppliedLaunchObservation } from "./permission-drift.js";

/** What the conversation actually ran with at its newest turn, per Codex's own rollout. */
export interface CodexPriorPolicy {
  sandbox: string;
  approval: string;
  effort: string | null;
  writableRoots: string[];
  networkAccess: boolean;
}

export type CodexPriorPolicyResult = { ok: true; policy: CodexPriorPolicy } | { ok: false; reason: string };

const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const APPROVALS = new Set(["untrusted", "on-failure", "on-request", "never"]);
const CHUNK = 256 * 1024;
const MAX_SCAN = 16 * 1024 * 1024;

export function locateCodexRollout(threadId: string, codexHome?: string): string | null {
  for (const path of resolveCodexDbPaths(homedir(), "state", undefined, codexHome)) {
    let db: Database.Database | undefined;
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
      const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId) as { rollout_path?: string } | undefined;
      if (row?.rollout_path) return row.rollout_path;
    } catch { /* next state db */ } finally { db?.close(); }
  }
  return null;
}

function newestTurnContext(rolloutPath: string): Record<string, unknown> | null {
  const fd = openSync(rolloutPath, "r");
  try {
    const size = fstatSync(fd).size;
    let end = size, carry = "";
    while (end > 0 && size - end < MAX_SCAN) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = (buf.toString("utf8") + carry).split("\n");
      carry = start > 0 ? lines.shift()! : "";
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]!.includes('"turn_context"')) continue;
        try {
          const obj = JSON.parse(lines[i]!) as { type?: string; payload?: Record<string, unknown> };
          if (obj.type === "turn_context" && obj.payload) return obj.payload;
        } catch { /* a torn line */ }
      }
      end = start;
    }
    return null;
  } finally { closeSync(fd); }
}

export function readCodexPriorPolicy(rolloutPath: string): CodexPriorPolicyResult {
  let ctx: Record<string, unknown> | null;
  try { ctx = newestTurnContext(rolloutPath); } catch (e) { return { ok: false, reason: `rollout unreadable: ${(e as Error).message}` }; }
  if (!ctx) return { ok: false, reason: "the rollout has no turn_context" };
  const sandbox = ctx.sandbox_policy as { type?: unknown; writable_roots?: unknown; network_access?: unknown } | undefined;
  const approval = ctx.approval_policy;
  if (typeof sandbox?.type !== "string" || !SANDBOXES.has(sandbox.type)) return { ok: false, reason: `unrecognised sandbox ${JSON.stringify(sandbox?.type)}` };
  if (typeof approval !== "string" || !APPROVALS.has(approval)) return { ok: false, reason: `unrecognised approval policy ${JSON.stringify(approval)}` };
  const roots = Array.isArray(sandbox.writable_roots) ? sandbox.writable_roots : [];
  if (!roots.every((r) => typeof r === "string")) return { ok: false, reason: "unrecognised writable roots" };
  return { ok: true, policy: {
    sandbox: sandbox.type,
    approval,
    effort: typeof ctx.effort === "string" && ctx.effort ? ctx.effort : null,
    writableRoots: roots as string[],
    networkAccess: sandbox.network_access === true,
  } };
}

/** The launch flags that reproduce the prior policy exactly; nothing is left to Codex's or OpenRig's defaults. */
export function codexPriorPolicyArgs(policy: CodexPriorPolicy): string {
  const workspace = policy.sandbox === "workspace-write"
    ? ` -c ${shellQuote(`sandbox_workspace_write.network_access=${policy.networkAccess}`)}${policy.writableRoots.map((r) => ` --add-dir ${shellQuote(r)}`).join("")}`
    : "";
  return ` -s ${policy.sandbox} -a ${policy.approval}${workspace}`;
}

export function observeCodexPriorPolicy(policy: CodexPriorPolicy): AppliedLaunchObservation {
  return { runtime: "codex", axis: "sandbox", state: "observed", value: policy.sandbox, approvalPolicy: policy.approval === "never" ? "never" : null, reason: "emitted_launch_arguments" };
}

export type CodexPriorPolicyReader = (threadId: string) => CodexPriorPolicyResult;

export function makeCodexPriorPolicyReader(codexHome?: string): CodexPriorPolicyReader {
  return (threadId) => {
    const rollout = locateCodexRollout(threadId, codexHome);
    return rollout ? readCodexPriorPolicy(rollout) : { ok: false, reason: `no rollout recorded for thread ${threadId}` };
  };
}

export function priorPolicyRefusal(threadId: string, reason: string): string {
  return `Codex resume of ${threadId} refused: its prior sandbox/approval/effort cannot be established (${reason}). `
    + "Resuming would apply launch defaults instead of what the conversation ran with; relaunch it with explicit flags or start it fresh.";
}
