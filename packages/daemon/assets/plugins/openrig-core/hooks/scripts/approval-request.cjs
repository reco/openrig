#!/usr/bin/env node
// PermissionRequest hook: ask the seat's human in Slack (when the seat opted in) and wait.
// Prints the runtime's allow/deny decision; prints nothing (normal terminal prompt) when there
// is no answer, the seat did not opt in, or OpenRig is unreachable. Each call to the daemon waits
// at most a minute (under fetch's header timeout); the hook repeats it until an answer or until the
// daemon expires the request (its approvalTimeoutSeconds, at most an hour). WAIT_MS only bounds a
// daemon that keeps answering "pending"; the runtimes' hook timeout (3660 s) sits just above it.
const { parseJson, resolveEndpoint } = require("./activity-relay.cjs");

const WAIT_MS = 3_630_000;

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

async function askUntilAnswered(post, first, deadline) {
  let body = first;
  while (Date.now() < deadline) {
    const reply = await post(body);
    if (reply.decision === "allow" || reply.decision === "deny") return reply.decision;
    if (!reply.pending || !reply.requestId) return null;
    body = { sessionName: first.sessionName, seatToken: first.seatToken, requestId: reply.requestId };
  }
  return null;
}

async function main(env = process.env) {
  const payload = parseJson(await readStdin());
  const sessionName = env.OPENRIG_SESSION_NAME || env.RIGGED_SESSION_NAME;
  const { baseUrl, token } = resolveEndpoint(env);
  if (!payload || !sessionName || !baseUrl || !token || typeof fetch !== "function") return;
  const toolName = payload.tool_name || payload.toolName;
  if (!toolName) return;
  const url = new URL("/api/activity/approvals", baseUrl).toString();
  const post = async (body) => (await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  })).json();
  try {
    const seatToken = env.OPENRIG_SEAT_TOKEN || null;
    const out = decisionOutput(await askUntilAnswered(post, { sessionName, seatToken, toolName, toolInput: payload.tool_input ?? null }, Date.now() + WAIT_MS));
    if (out) process.stdout.write(out);
  } catch {
    // no decision: the prompt shows in the terminal
  }
}

if (require.main === module) main().catch(() => {});

module.exports = { decisionOutput, askUntilAnswered };
