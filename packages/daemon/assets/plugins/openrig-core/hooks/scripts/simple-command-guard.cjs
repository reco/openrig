#!/usr/bin/env node
"use strict";
// PreToolUse guard for Bash: a command that is not simple is refused with the reason, so the agent
// rewrites it as simple commands that approval rules can answer instead of the human. A simple command
// (or chain of them) passes on to the runtime's own permission handling unchanged.
const { complexity } = require("./plain-command.cjs");

function decide(input) {
  if (input?.tool_name !== "Bash" || typeof input.tool_input?.command !== "string") return null;
  const why = complexity(input.tool_input.command);
  if (!why) return null;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason:
    `OpenRig runs only simple commands here (this one has ${why}). Rewrite it as plain commands joined by &&, ||, ; or |: `
    + "no $(...), backticks, variables, loops, heredocs, redirects or background &. Pass text as quoted literals or write it with the Write tool first; "
    + "split it into separate simple commands, one per call; a script file always needs the human's approval." } };
}

if (require.main === module) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { raw += c; });
  process.stdin.on("end", () => {
    try { const out = decide(JSON.parse(raw)); if (out) process.stdout.write(JSON.stringify(out)); } catch { /* no decision */ }
  });
}

module.exports = { decide };
