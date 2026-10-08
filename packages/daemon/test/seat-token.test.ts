import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { activityRoutes } from "../src/routes/activity.js";
import { ensureSeatTokenSecret, seatToken, seatTokenEnv, seatTokenMatches } from "../src/domain/seat-token.js";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

describe("per-seat approval tokens", () => {
  it("bind a token to the seat's node, name and generation, from a 0600 daemon-only secret", () => {
    const home = mkdtempSync(join(tmpdir(), "seat-token-")); homes.push(home);
    const secret = ensureSeatTokenSecret(home);
    expect(statSync(join(home, "seat-token-secret")).mode & 0o777).toBe(0o600);
    expect(ensureSeatTokenSecret(home)).toBe(secret);
    const token = seatToken(secret, "n1", "dev@rig", "g1");
    expect(seatTokenMatches(token, seatToken(secret, "n1", "dev@rig", "g1"))).toBe(true);
    expect(seatTokenMatches(token, seatToken(secret, "n1", "other@rig", "g1"))).toBe(false);
    expect(seatTokenMatches(token, seatToken(secret, "n1", "dev@rig", "g2"))).toBe(false);
    expect(seatTokenMatches(token, null)).toBe(false);
    expect(seatTokenEnv(home, "n1", "dev@rig", "g1")).toEqual({ OPENRIG_SEAT_TOKEN: token });
    expect(seatTokenEnv(home, "n1", "dev@rig", null)).toEqual({});
  });

  it("the approvals route refuses a caller whose seat token is not the named seat's", async () => {
    const asked: string[] = [];
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("activityHookToken" as never, "hook" as never);
      c.set("approvalService" as never, {
        verify: (session: string, token: string | null) => session === "dev@rig" && token === "good",
        start: async () => { asked.push("start"); return "q1"; },
        wait: async () => "allow",
      } as never);
      await next();
    });
    app.route("/api/activity", activityRoutes);
    const call = (body: unknown) => app.request("/api/activity/approvals", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer hook" }, body: JSON.stringify(body) });
    const forged = await call({ sessionName: "dev@rig", seatToken: "stolen", toolName: "Bash", toolInput: { command: "ls" } });
    expect(forged.status).toBe(403);
    expect(asked).toEqual([]);
    const own = await call({ sessionName: "dev@rig", seatToken: "good", toolName: "Bash", toolInput: { command: "ls" } });
    expect(await own.json()).toMatchObject({ decision: "allow", requestId: "q1" });
  });
});

describe("tmux launch errors", () => {
  it("never echo a token from the launch env", async () => {
    const { TmuxAdapter } = await import("../src/adapters/tmux.js");
    const tmux = new TmuxAdapter(async () => { throw new Error("Command failed: tmux new-session -d -s dev@rig -e 'OPENRIG_SEAT_TOKEN=abc123secret' -e 'OPENRIG_ACTIVITY_HOOK_TOKEN=hooksecret'\nduplicate session: dev@rig"); });
    const r = await tmux.createSession("dev@rig", undefined, { OPENRIG_SEAT_TOKEN: "abc123secret" });
    expect(r).toMatchObject({ ok: false, code: "duplicate_session" });
    expect(JSON.stringify(r)).not.toContain("abc123secret");
    expect(JSON.stringify(r)).not.toContain("hooksecret");
  });
});
