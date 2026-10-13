#!/usr/bin/env node
"use strict";
// PreToolUse deny check for Bash: the daemon's own deny matcher (quote-aware, git-normalizing) sees every command
// before the runtime's own rules, so a broad allow such as Bash(git *) cannot outrun the human's denies.
// When the check cannot run (daemon down, slow or failing, rules unreadable), a git command is refused, since a
// broad git allow leaves the denies as its only guard; anything else falls to the runtime's own rules.
const { parseJson, resolveEndpoint } = require("./activity-relay.cjs");

const RUNS_GIT = /(?:^|[;&|(`\s])(?:\S*\/)?git(?:\s|$)/;

function commandOf(input) {
  const command = input?.tool_input?.command;
  if (typeof command === "string") return command;
  return Array.isArray(command) && command.every((c) => typeof c === "string") ? command.join(" ") : null;
}

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

/** The hook's answer: the daemon's deny, or for an unchecked git command (reply null) a refusal. */
function decisionOutput(reply, command = "") {
  if (reply === null) return RUNS_GIT.test(command)
    ? deny("OpenRig could not check this git command against the approval deny rules (the daemon did not answer); try again once it is back.")
    : null;
  if (reply?.deny !== true) return null;
  return deny(typeof reply.message === "string" && reply.message ? reply.message : "Denied by an OpenRig approval rule.");
}

async function main(env = process.env) {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const command = commandOf(parseJson(raw));
  const sessionName = env.OPENRIG_SESSION_NAME || env.RIGGED_SESSION_NAME;
  const { baseUrl, token } = resolveEndpoint(env);
  if (!command || !sessionName || !baseUrl || !token || typeof fetch !== "function") return;
  let reply = null;
  try {
    const response = await fetch(new URL("/api/activity/deny-check", baseUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionName, command }),
      signal: AbortSignal.timeout(3_000),
    });
    if (response.ok) reply = await response.json();
  } catch { /* unchecked */ }
  const out = decisionOutput(reply, command);
  if (out) process.stdout.write(JSON.stringify(out));
}

if (require.main === module) main().catch(() => {});

module.exports = { commandOf, decisionOutput };
