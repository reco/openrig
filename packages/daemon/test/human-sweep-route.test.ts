import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { gatewayRoutes } from "../src/routes/gateway.js";

function appWith(subsystem: unknown) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("gatewaySubsystem" as never, subsystem as never); await next(); });
  app.route("/api/gateway", gatewayRoutes({ home: "/nonexistent" }));
  return app;
}

const post = (app: Hono, body: unknown, headers: Record<string, string> = { "x-openrig-session": "advisor-lead@kernel" }) =>
  app.request("/api/gateway/human-sweep", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("POST /api/gateway/human-sweep", () => {
  it("plans under the caller's transport identity, a dry run unless apply is true", async () => {
    const calls: unknown[] = [];
    const app = appWith({ restart: () => {}, status: () => ({}), sweepHuman: async (input: unknown) => { calls.push(input); return { entries: [], applying: false }; } });
    const res = await post(app, { destination: "reco@external", before: "2026-10-12T00:00:00Z" });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ destination: "reco@external", before: "2026-10-12T00:00:00.000Z", apply: false, actorSession: "advisor-lead@kernel" }]);
  });

  it("needs a destination and a valid time, and an active gateway", async () => {
    const app = appWith({ restart: () => {}, status: () => ({}), sweepHuman: () => null });
    expect((await post(app, { destination: "reco@external", before: "yesterday-ish" })).status).toBe(400);
    expect((await post(app, { before: "2026-10-12T00:00:00Z" })).status).toBe(400);
    expect((await post(app, { destination: "reco@external", before: "2026-10-12T00:00:00Z" })).status).toBe(503);
  });
});
