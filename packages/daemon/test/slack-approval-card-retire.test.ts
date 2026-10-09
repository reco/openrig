// An expired or canceled request's card loses its buttons: the original Slack message is rewritten
// with the outcome (answers kept), through the same chat.update path a click uses. A failed rewrite is
// recorded on the row and retried by the request sweep.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeApprovalService } from "../src/domain/approvals.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";

const founder = { entityId: "reco", class: "human" as const, displayName: "reco", address: "reco@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } };
const registry = { ok: true as const, entities: [founder] };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("an expired or canceled approval card loses its buttons", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let posts: Array<Record<string, unknown>>;
  let updates: Array<Record<string, unknown>>;
  let failUpdates: number;
  const stops: Array<() => void> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "card-retire-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env"); writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-MAIN", secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE" }, home);
    posts = []; updates = []; failUpdates = 0;
    const wire = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, requestSweepIntervalMs: 50,
      fetchImpl: async (url, init) => {
        if (url.endsWith("chat.update")) {
          if (failUpdates > 0) { failUpdates--; return reply({ ok: false, error: "ratelimited" }); }
          updates.push(JSON.parse(String(init?.body))); return reply({ ok: true });
        }
        if (url.endsWith("chat.postMessage")) { posts.push(JSON.parse(String(init?.body))); return reply({ ok: true, ts: `${posts.length}.1` }); }
        return reply({ ok: true });
      },
    });
    stops.push(() => wire.stop()); wire.startServices?.();
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  async function postedApproval(t: { now: number }) {
    const service = makeApprovalService({ queueRepo: repo, optedIn: () => ["dev@rig"], approver: () => "reco@external", verifySeat: () => true, timeoutMs: () => 1_800_000, now: () => t.now, pollMs: 5 });
    const id = (await service.start({ sessionName: "dev@rig", toolName: "Bash", toolInput: { command: "rm -rf build" } }))!;
    await vi.waitFor(() => expect(posts.some((p) => String(p.text).includes("rm -rf build"))).toBe(true));
    const card = posts.find((p) => String(p.text).includes("rm -rf build"))!;
    expect(JSON.stringify(card.blocks)).toContain('"type":"actions"');
    return { service, id, ts: `${posts.indexOf(card) + 1}.1` };
  }
  const actionable = (message: Record<string, unknown>) => JSON.stringify(message.blocks).includes('"type":"actions"');

  it("the abandoned-hook expiry rewrites the card: no buttons, the outcome shown, the thread told", async () => {
    const t = { now: Date.now() };
    const { service, id, ts } = await postedApproval(t);
    t.now += 130_000; await service.sweep();
    await vi.waitFor(() => expect(updates.some((u) => u.ts === ts)).toBe(true));
    const card = updates.find((u) => u.ts === ts)!;
    expect(actionable(card)).toBe(false);
    expect(String(card.text)).toContain("Closed: expired, the seat stopped waiting for it.");
    expect(String(card.text)).toContain("rm -rf build");
    await vi.waitFor(() => expect(posts.some((p) => p.thread_ts === ts && String(p.text).includes("Closed: expired"))).toBe(true));
    expect(repo.transitionLog.listForQitem(id).some((x) => x.transitionNote?.startsWith(`slack-card-closed channel=C-MAIN message_ts=${ts}`))).toBe(true);
  });

  it("the deadline expiry rewrites the card too, and a failed rewrite is retried until it lands", async () => {
    const t = { now: Date.now() };
    const { service, id, ts } = await postedApproval(t);
    failUpdates = 1;
    t.now += 1_800_001;
    expect(await service.wait(id, "dev@rig", 1)).toBe("expired");
    await vi.waitFor(() => expect(repo.transitionLog.listForQitem(id).some((x) => x.transitionNote?.startsWith("slack-card-close-failed"))).toBe(true));
    await vi.waitFor(() => expect(updates.some((u) => u.ts === ts && !actionable(u) && String(u.text).includes("Closed: expired, no answer in time."))).toBe(true));
    expect(repo.transitionLog.listForQitem(id).at(-1)?.transitionNote).toMatch(/^slack-card-closed /);
  });

  it("an answered approval is never shown as expired", async () => {
    const t = { now: Date.now() };
    const { service, id, ts } = await postedApproval(t);
    repo.recordHumanAnswer({ qitemId: id, actorSession: "reco@external", questionId: "approval", optionId: "allow" });
    t.now += 1_900_000; await service.sweep();
    await new Promise((r) => setTimeout(r, 150));
    expect(repo.getById(id)?.state).toBe("pending");
    expect(updates.filter((u) => u.ts === ts && String(u.text).includes("expired"))).toEqual([]);
  });
});
