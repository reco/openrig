#!/usr/bin/env node
"use strict";
// PreToolUse deny check for Bash: the daemon's own deny matcher (quote-aware, git-normalizing) sees every command
// before the runtime's own rules, so a broad allow such as Bash(git *) cannot outrun the human's denies.
// An unreachable daemon decides nothing: the runtime's own deny rules still apply.
const { parseJson, resolveEndpoint } = require("./activity-relay.cjs");

function commandOf(input) {
  const command = input?.tool_input?.command;
  if (typeof command === "string") return command;
  return Array.isArray(command) && command.every((c) => typeof c === "string") ? command.join(" ") : null;
}

function decisionOutput(reply) {
  if (reply?.deny !== true) return null;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: typeof reply.message === "string" && reply.message ? reply.message : "Denied by an OpenRig approval rule." } };
}

async function main(env = process.env) {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const command = commandOf(parseJson(raw));
  const sessionName = env.OPENRIG_SESSION_NAME || env.RIGGED_SESSION_NAME;
  const { baseUrl, token } = resolveEndpoint(env);
  if (!command || !sessionName || !baseUrl || !token || typeof fetch !== "function") return;
  const reply = await (await fetch(new URL("/api/activity/deny-check", baseUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionName, command }),
    signal: AbortSignal.timeout(3_000),
  })).json();
  const out = decisionOutput(reply);
  if (out) process.stdout.write(JSON.stringify(out));
}

if (require.main === module) main().catch(() => {});

module.exports = { commandOf, decisionOutput };
