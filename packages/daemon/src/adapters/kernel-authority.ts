import type { NodeBinding } from "../domain/runtime-adapter.js";
import { nonInterruptiveArgs } from "./non-interruptive.js";
import { shellQuote } from "./shell-quote.js";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { getOpenRigHome } from "../openrig-compat.js";
import { claudePermissionRules, readApprovalRules } from "../domain/approval-rules.js";

// One permission story: every Claude seat's allow and deny rules come from the human's approval-rules.json
// (seeded with OpenRig's defaults). Team seats keep the rig lifecycle asks, so those always reach a human.
export const TEAM_CLAUDE_ASK = [
  "up", "down", "start", "launch", "restore", "fork", "bootstrap", "create", "add", "remove",
  "grow", "shrink", "expand", "archive", "unarchive", "destroy", "compact", "setup", "import", "adopt",
  "attach", "bind", "handover", "unclaim", "release", "reconcile-session", "env down",
  "policy apply", "config set", "config reset",
  "daemon start", "daemon stop", "bundle install", "seat launch", "seat continue", "seat stop",
  "seat clean", "seat handover", "seat switch-client", "seat set-permissions", "seat set-model",
].map(command => `Bash(rig ${command}:*)`);

type LaunchChoice = Pick<NodeBinding, "kernelAuthority" | "teamPermissionDefault" | "nonInterruptive" | "launchPosture" | "permissionMode"> & { tmuxSession?: string | null };

/** The human's rules for this seat; a broken rules file adds none (the daemon logs it at each request). */
function seatRules(choice: LaunchChoice): { allow: string[]; deny: string[] } {
  try { return claudePermissionRules(readApprovalRules(getOpenRigHome()), choice.tmuxSession ?? null); } catch { return { allow: [], deny: [] }; }
}

function claudeCommandSettings(rules: { allow: string[]; deny: string[] }, ask: string[]): string[] {
  const permissions = { allow: rules.allow, ...(ask.length ? { ask } : {}), ...(rules.deny.length ? { deny: rules.deny } : {}) };
  const hook = fileURLToPath(new URL("../../assets/claude-team-permissions.cjs", import.meta.url));
  if (!existsSync(hook)) return ["--settings", JSON.stringify({ permissions })];
  const policy = Buffer.from(JSON.stringify({ allow: rules.allow, ask })).toString("base64");
  const command = [process.execPath, hook, policy].map(shellQuote).join(" ");
  return ["--settings", JSON.stringify({
    permissions: { allow: rules.allow, ...(rules.deny.length ? { deny: rules.deny } : {}) },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] }] },
  })];
}

/** One --settings flag carries the seat's rules, merged into a settings flag already present. */
function withRules(args: string[], rules: { allow: string[]; deny: string[] }, ask: string[]): string[] {
  if (!rules.allow.length && !rules.deny.length) return args;
  const permissions = { ...(rules.allow.length ? { allow: rules.allow } : {}), ...(rules.allow.length && ask.length ? { ask } : {}),
    ...(rules.deny.length ? { deny: rules.deny } : {}) };
  const at = args.indexOf("--settings");
  if (at === -1) return [...args, "--settings", JSON.stringify({ permissions })];
  const settings = JSON.parse(args[at + 1]!) as { permissions?: Record<string, unknown> };
  return [...args.slice(0, at + 1), JSON.stringify({ ...settings, permissions: { ...settings.permissions, ...permissions } }), ...args.slice(at + 2)];
}

/** Session flags only; never writes a personal/project permission file. */
export function operationalLaunchArgs(runtime: string, choice: LaunchChoice): string[] {
  if (runtime === "codex") {
    // Managed seats leave Codex upgrades to the operator. This is launch-local;
    // it does not write config or accept a rate-limit model switch.
    return ["-c", "check_for_update_on_startup=false", ...nonInterruptiveArgs(runtime,
      choice.kernelAuthority ? { launchPosture: "full_bypass", nonInterruptive: true } : choice)];
  }
  if (runtime !== "claude-code") return choice.kernelAuthority ? [] : nonInterruptiveArgs(runtime, choice);
  const rules = seatRules(choice);
  if (!choice.kernelAuthority && choice.teamPermissionDefault && !choice.permissionMode
    && (!choice.launchPosture || choice.launchPosture === "floor")) {
    return claudeCommandSettings(rules, TEAM_CLAUDE_ASK);
  }
  // Any other non-kernel seat still asks before rig lifecycle commands, natively (ask beats allow).
  return withRules(choice.kernelAuthority ? [] : nonInterruptiveArgs(runtime, choice), rules, choice.kernelAuthority ? [] : TEAM_CLAUDE_ASK);
}

export function operationalLaunchArg(runtime: string, choice: LaunchChoice): string {
  return operationalLaunchArgs(runtime, choice).map(arg => ` ${shellQuote(arg)}`).join("");
}
