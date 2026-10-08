#!/usr/bin/env node
// PermissionRequest hook: ask the seat's human in Slack (when the seat opted in) and wait.
// Prints the runtime's allow/deny decision; prints nothing (normal terminal prompt) when there
// is no answer, the seat did not opt in, or OpenRig is unreachable.
const { parseJson, resolveEndpoint } = require("./activity-relay.cjs");

const WAIT_MS = 580_000;

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function decisionOutput(decision) {
  if (decision !== "allow" && decision !== "deny") return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: decision === "allow"
    ? { behavior: "allow" }
    : { behavior: "deny", message: "Denied by the human in Slack." } } });
}

async function main(env = process.env) {
  const payload = parseJson(await readStdin());
  const sessionName = env.OPENRIG_SESSION_NAME || env.RIGGED_SESSION_NAME;
  const { baseUrl, token } = resolveEndpoint(env);
  if (!payload || !sessionName || !baseUrl || !token || typeof fetch !== "function") return;
  const toolName = payload.tool_name || payload.toolName;
  if (!toolName) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WAIT_MS);
  try {
    const res = await fetch(new URL("/api/activity/approvals", baseUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionName, toolName, toolInput: payload.tool_input ?? null }),
      signal: controller.signal,
    });
    const out = decisionOutput((await res.json()).decision);
    if (out) process.stdout.write(out);
  } catch {
    // no decision: the prompt shows in the terminal
  } finally {
    clearTimeout(timer);
  }
}

if (require.main === module) main().catch(() => {});

module.exports = { decisionOutput };
