import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { promptCardRoutes } from "../src/routes/prompt-card.js";
import type { StuckPromptWatch } from "../src/domain/stuck-prompt-watch.js";

function appWith(watch: Partial<StuckPromptWatch> | undefined) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("stuckPromptWatch" as never, watch as never); await next(); });
  app.route("/api/prompt-card", promptCardRoutes);
  return app;
}

const post = (app: Hono, body: unknown, headers: Record<string, string> = {}) =>
  app.request("/api/prompt-card", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("POST /api/prompt-card", () => {
  it("asks the watch for a card under the caller's transport identity", async () => {
    const calls: unknown[] = [];
    const app = appWith({ requestCard: async (session, request) => { calls.push({ session, request }); return { outcome: "posted", qitemId: "q1" }; } });
    const res = await post(app, { session: "cfo@finance", reason: "safe read", actor: "someone@else" }, { "x-openrig-session": "advisor-lead@kernel" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "posted", qitemId: "q1" });
    expect(calls).toEqual([{ session: "cfo@finance", request: { by: "advisor-lead@kernel", reason: "safe read" } }]);
  });

  it("returns a refusal as 409 and needs a session, a reason and an actor", async () => {
    const app = appWith({ requestCard: async () => ({ outcome: "not-answerable" }) });
    const refused = await post(app, { session: "cfo@finance", reason: "r" }, { "x-openrig-session": "advisor-lead@kernel" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ outcome: "not-answerable" });
    expect((await post(app, { session: "cfo@finance" }, { "x-openrig-session": "a@b" })).status).toBe(400);
    expect((await post(app, { session: "cfo@finance", reason: "r" })).status).toBe(400);
    expect((await post(appWith(undefined), { session: "cfo@finance", reason: "r" }, { "x-openrig-session": "a@b" })).status).toBe(503);
  });
});
