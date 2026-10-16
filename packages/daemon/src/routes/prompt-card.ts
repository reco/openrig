import { Hono } from "hono";
import type { StuckPromptWatch } from "../domain/stuck-prompt-watch.js";
import { requireSenderIdentity } from "./require-sender-identity.js";

export const promptCardRoutes = new Hono();

promptCardRoutes.post("/", async (c) => {
  const watch = c.get("stuckPromptWatch" as never) as StuckPromptWatch | undefined;
  if (!watch) return c.json({ error: "prompt_watch_unavailable", message: "The stuck-prompt watch is not running in this daemon." }, 503);
  const body = await c.req.json<{ session?: string; reason?: string; actor?: string }>().catch(() => ({}) as { session?: string; reason?: string; actor?: string });
  const session = body.session?.trim();
  const reason = body.reason?.trim();
  if (!session || !reason) return c.json({ error: "Missing required fields: session, reason" }, 400);
  const actor = requireSenderIdentity(c, { verb: "a prompt card request", bodyClaim: body.actor });
  if (!actor.ok) return actor.response;
  const result = await watch.requestCard(session, { by: actor.session, reason });
  return c.json(result, result.outcome === "posted" || result.outcome === "already-posted" ? 200 : 409);
});
