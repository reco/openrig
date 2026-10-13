// A stuck-prompt card whose prompt is no longer in view, or that a newer card for the seat replaced,
// is canceled; the request sweep then rewrites its Slack card without buttons, saying why.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { hasRecentPromptCard, retireStalePromptNotices, supersedePromptNotices } from "../src/domain/stuck-prompt-watch.js";

const founder = { entityId: "reco", class: "human" as const, displayName: "reco", address: "reco@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } };
const registry = { ok: true as const, entities: [founder] };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("stale stuck-prompt cards are retired", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let posts: Array<Record<string, unknown>>;
  let updates: Array<Record<string, unknown>>;
  const stops: Array<() => void> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "prompt-retire-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env"); writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-MAIN", secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE" }, home);
    posts = []; updates = [];
    const wire = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, requestSweepIntervalMs: 50,
      fetchImpl: async (url, init) => {
        if (url.endsWith("chat.update")) { updates.push(JSON.parse(String(init?.body))); return reply({ ok: true }); }
        if (url.endsWith("chat.postMessage")) { posts.push(JSON.parse(String(init?.body))); return reply({ ok: true, ts: `${posts.length}.1` }); }
        return reply({ ok: true });
      },
    });
    stops.push(() => wire.stop()); wire.startServices?.();
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  async function postedCard(session: string, key: string) {
    const row = await repo.create({
      tags: ["stuck-prompt", `stuck-prompt:${key}`, `stuck-prompt-session:${session}`, `stuck-prompt-key:${key}`, "stuck-prompt-allow:1", "stuck-prompt-deny:3"],
      sourceSession: session, destinationSession: "reco@external", humanIntent: "decision", summary: `${session} is waiting at a permission prompt`,
      body: `rm -rf build ${key}`, humanQuestions: [{ id: "answer", question: `Answer ${session}'s prompt?`, options: [{ id: "allow", label: "Approve" }, { id: "deny", label: "Deny" }] }], nudge: false,
    });
    await vi.waitFor(() => expect(posts.some((p) => String(p.text).includes(`rm -rf build ${key}`))).toBe(true));
    return { id: row.qitemId, ts: `${posts.findIndex((p) => String(p.text).includes(`rm -rf build ${key}`)) + 1}.1` };
  }
  const actionable = (message: Record<string, unknown>) => JSON.stringify(message.blocks).includes('"type":"actions"');
  const closedWith = async (ts: string, line: string) =>
    vi.waitFor(() => expect(updates.some((u) => u.ts === ts && !actionable(u) && String(u.text).includes(line))).toBe(true));

  it("a card whose prompt is gone or changed closes as answered in the terminal; the card for the prompt in view stays", async () => {
    const gone = await postedCard("cfo@finance", "k1");
    const changed = await postedCard("ops@rig", "k2");
    const current = await postedCard("dev@rig", "k3");
    expect(retireStalePromptNotices(repo, ["cfo@finance", "ops@rig", "dev@rig"], new Map([["cfo@finance", null], ["ops@rig", "k9"], ["dev@rig", "k3"]])).sort()).toEqual([gone.id, changed.id].sort());
    await closedWith(gone.ts, "Closed: answered in the terminal.");
    await closedWith(changed.ts, "Closed: answered in the terminal.");
    expect(repo.getById(current.id)?.state).toBe("pending");
    expect(updates.some((u) => u.ts === current.ts)).toBe(false);
  });

  it("a card for a seat that no longer runs is retired; an unreadable seat's card is kept", async () => {
    const replaced = await postedCard("cfo@finance", "k1");
    const unread = await postedCard("dev@rig", "k3");
    expect(retireStalePromptNotices(repo, ["dev@rig"], new Map())).toEqual([replaced.id]);
    await closedWith(replaced.ts, "Closed: answered in the terminal.");
    expect(repo.getById(unread.id)?.state).toBe("pending");
  });

  it("a newer card for the seat closes its earlier ones, saying a newer card replaced them", async () => {
    const first = await postedCard("cfo@finance", "k1");
    const other = await postedCard("dev@rig", "k3");
    expect(supersedePromptNotices(repo, "cfo@finance")).toEqual([first.id]);
    await closedWith(first.ts, "Closed: replaced by a newer card for this seat.");
    expect(repo.getById(other.id)?.state).toBe("pending");
  });

  it("a card still open for the seat's same prompt blocks a duplicate at any age (a restart); an answered or replaced one does not", async () => {
    const open = await postedCard("cfo@finance", "k1");
    expect(hasRecentPromptCard(repo, { session: "cfo@finance", key: "k1" })).toBe(true);
    expect(hasRecentPromptCard(repo, { session: "dev@rig", key: "k1" })).toBe(false);
    expect(hasRecentPromptCard(repo, { session: "cfo@finance", key: "k1" }, Date.now() + 51 * 60_000)).toBe(true);
    expect(hasRecentPromptCard(repo, { session: "cfo@finance", key: "k1" }, Date.now() + 10 * 3600_000)).toBe(true);
    repo.update({ qitemId: open.id, actorSession: "reco@external", state: "done", closureReason: "no-follow-on" });
    expect(hasRecentPromptCard(repo, { session: "cfo@finance", key: "k1" })).toBe(false);
    const replaced = await postedCard("cfo@finance", "k1");
    supersedePromptNotices(repo, "cfo@finance");
    expect(repo.getById(replaced.id)?.state).toBe("canceled");
    expect(hasRecentPromptCard(repo, { session: "cfo@finance", key: "k1" })).toBe(false);
    await repo.create({ tags: ["stuck-prompt", "stuck-prompt-session:ops@rig", "stuck-prompt-key:k2"], sourceSession: "daemon@kernel", destinationSession: "reco@external",
      humanIntent: "update", summary: "ops@rig is waiting at a selection prompt", body: "Which color?", nudge: false });
    expect(hasRecentPromptCard(repo, { session: "ops@rig", key: "k2" })).toBe(true);
    await vi.waitFor(() => expect(posts.some((p) => String(p.text).includes("Which color?"))).toBe(true));
  });

  it("leaves rows that are not stuck-prompt cards, and closed cards, alone", async () => {
    const plain = await repo.create({ sourceSession: "cfo@finance", destinationSession: "reco@external", humanIntent: "decision", summary: "s", body: "b",
      tags: ["x"], humanQuestions: [{ id: "q", question: "?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }], nudge: false });
    const done = await postedCard("cfo@finance", "k1");
    repo.update({ qitemId: done.id, actorSession: "reco@external", state: "done", closureReason: "no-follow-on" });
    expect(retireStalePromptNotices(repo, [], new Map())).toEqual([]);
    expect(repo.getById(plain.qitemId)?.state).toBe("pending");
  });
});
