// #rig-notifications: pure FYI posts (updates with no buttons, not thread replies) go to the
// notifications channel; anything the human answers stays on the default. Through the real wire.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { buildSlackGatewayWire, makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import type { WsLike } from "../src/domain/gateway/slack/socket-inbound.js";
import { DEFAULT_CONFIG, channelsOf, loadConfig, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";

const person = (entityId: string, handle: string) => ({ entityId, class: "human" as const, displayName: entityId, address: `${entityId}@external`, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle }], prefs: { deliveryClass: "A" as const } });
const registry = { ok: true as const, entities: [person("human-founder", "UFOUNDER"), { ...person("lee", "ULEE"), role: "requester" as const, channels: ["C-PSA"] }] };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("Slack notifications channel", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let posts: Array<Record<string, unknown>>;
  let reactions: Array<{ timestamp: string; name: string }>;
  let counted: string[];
  let historyChannels: string[];
  let socket: WsLike;
  const stops: Array<() => void> = [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "notifications-channel-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\nSLACK_APP_TOKEN=xapp-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-MAIN", inboundDestination: "advisor@kernel", extraChannels: [{ id: "C-PSA", inboundDestination: "psa-dev@psa" }], notificationsChannel: "C-NOTE", secretsEnvFile: secrets }, home);
    posts = [];
    reactions = [];
    counted = [];
    historyChannels = [];
    const sockets: WsLike[] = [];
    const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    const wire = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      resolveHumanReply: makeHumanReplyResolver(repo, contract),
      wsFactory: () => { const ws: WsLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }; sockets.push(ws); return ws; },
      inboundMaxConnects: 1,
      fetchImpl: async (url, init) => {
        if (url.endsWith("apps.connections.open")) return reply({ ok: true, url: "wss://fake-slack/ws" });
        if (url.endsWith("auth.test")) return reply({ ok: true, user_id: "UBOT" });
        if (url.includes("conversations.members")) {
          const channel = new URL(url).searchParams.get("channel")!;
          counted.push(channel);
          return reply({ ok: true, members: channel === "C-PSA" ? ["UFOUNDER", "ULEE", "UBOT"] : ["UFOUNDER", "UBOT", "UOTHERBOT"] });
        }
        if (url.includes("users.info")) {
          const user = new URL(url).searchParams.get("user")!;
          return reply({ ok: true, user: { id: user, is_bot: user === "UBOT" || user === "UOTHERBOT" } });
        }
        if (url.endsWith("reactions.add")) { reactions.push(JSON.parse(String(init?.body))); return reply({ ok: true }); }
        if (url.endsWith("chat.postMessage")) { posts.push(JSON.parse(String(init?.body))); return reply({ ok: true, ts: `${posts.length}.1` }); }
        if (url.includes("conversations.history")) historyChannels.push(new URL(url).searchParams.get("channel")!);
        return reply({ ok: true, messages: [] });
      },
    });
    stops.push(() => wire.stop()); wire.startServices?.();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    socket = sockets[0]!;
    socket.onopen?.();
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  const say = async (user: string, channel: string, text: string, ts: string, threadTs?: string) => {
    socket.onmessage?.({ data: JSON.stringify({ envelope_id: `e-${ts}`, type: "events_api", payload: { event: { type: "message", user, text, ts, channel, ...(threadTs ? { thread_ts: threadTs } : {}) } } }) });
    await new Promise((r) => setTimeout(r, 50));
  };
  const rowWith = (text: string) => repo.list({ limit: 100 }).find((q) => q.body.includes(text));

  const posted = async (text: string) => {
    await vi.waitFor(() => expect(posts.some((p) => String(p.text).includes(text))).toBe(true));
    return posts.find((p) => String(p.text).includes(text))!;
  };

  it("an update with no buttons posts to the notifications channel", async () => {
    await repo.create({ sourceSession: "advisor@kernel", destinationSession: "human-founder@external", humanIntent: "update", summary: "Merged", body: "Main is at abc123.", nudge: false });
    expect((await posted("Main is at abc123.")).channel).toBe("C-NOTE");
  });

  it("a decision, with or without its own buttons, stays on the default channel", async () => {
    await repo.create({ sourceSession: "advisor@kernel", destinationSession: "human-founder@external", humanIntent: "decision", summary: "Ship it?", body: "Ready to ship.", nudge: false });
    expect((await posted("Ready to ship.")).channel).toBe("C-MAIN");
    await repo.create({ sourceSession: "advisor@kernel", destinationSession: "human-founder@external", humanIntent: "decision", summary: "Pick one", body: "Choose the plan.",
      humanQuestions: [{ id: "q", question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }], nudge: false });
    expect((await posted("Choose the plan.")).channel).toBe("C-MAIN");
  });

  it("an update replying to a thread stays in that thread's channel", async () => {
    await say("UFOUNDER", "C-MAIN", "How is the build?", "200.1");
    const inbound = rowWith("How is the build?")!;
    await repo.create({ sourceSession: "advisor@kernel", destinationSession: "human-founder@external", humanIntent: "update", summary: "Build", body: "Build is green.", replyTo: inbound.qitemId, nudge: false });
    expect(await posted("Build is green.")).toMatchObject({ channel: "C-MAIN", thread_ts: "200.1" });
  });

  it("a seat with its own channel keeps its FYI there", async () => {
    await repo.create({ sourceSession: "psa-dev@psa", destinationSession: "lee@external", humanIntent: "update", summary: "Done", body: "Theme shipped.", nudge: false });
    expect((await posted("Theme shipped.")).channel).toBe("C-PSA");
  });

  it("missed messages in the notifications channel are recovered like the others", async () => {
    await vi.waitFor(() => expect(Object.keys(JSON.parse(readFileSync(join(home, "state", "slack-channel-coverage.json"), "utf8")).channels ?? JSON.parse(readFileSync(join(home, "state", "slack-channel-coverage.json"), "utf8")))).toEqual(expect.arrayContaining(["C-MAIN", "C-PSA", "C-NOTE"])));
  });

  it("a message written in the notifications channel lands on the inbound destination", async () => {
    await say("UFOUNDER", "C-NOTE", "Thanks, noted", "201.1");
    expect(rowWith("Thanks, noted")?.destinationSession).toBe("advisor@kernel");
  });

  it("is a validated, distinct channel that inbound and verify cover", () => {
    expect(channelsOf(loadConfig(home)).map((c) => c.id)).toEqual(["C-MAIN", "C-PSA", "C-NOTE"]);
    expect(() => saveConfig({ ...loadConfig(home), notificationsChannel: "C-MAIN" }, home)).toThrow(/configured once/);
    expect(() => saveConfig({ ...loadConfig(home), notificationsChannel: "#rig-notifications" }, home)).toThrow(/Slack channel id/);
    saveConfig({ ...loadConfig(home), notificationsChannel: null }, home);
    expect(channelsOf(loadConfig(home)).map((c) => c.id)).toEqual(["C-MAIN", "C-PSA"]);
  });
});
