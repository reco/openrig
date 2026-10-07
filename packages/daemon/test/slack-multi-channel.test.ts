// PSA — several Slack channels, each landing its new messages on its own seat, and a requester
// bound to one channel. Through the real wire: socket inbound, outbound driver, thread map.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { buildSlackGatewayWire, makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import type { WsLike } from "../src/domain/gateway/slack/socket-inbound.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";

const person = (entityId: string, handle: string) => ({ entityId, class: "human" as const, displayName: entityId, address: `${entityId}@external`, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle }], prefs: { deliveryClass: "A" as const } });
const registry = { ok: true as const, entities: [person("human-founder", "UFOUNDER"), { ...person("lee", "ULEE"), role: "requester" as const, channels: ["C-PSA"] }] };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("several Slack channels", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let posts: Array<Record<string, unknown>>;
  let reactions: Array<{ timestamp: string; name: string }>;
  let counted: string[];
  let socket: WsLike;
  const stops: Array<() => void> = [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "multi-channel-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\nSLACK_APP_TOKEN=xapp-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-MAIN", inboundDestination: "advisor@kernel", extraChannels: [{ id: "C-PSA", inboundDestination: "psa-dev@psa" }], secretsEnvFile: secrets }, home);
    posts = [];
    reactions = [];
    counted = [];
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

  it("a new message lands on its channel's seat", async () => {
    await say("UFOUNDER", "C-MAIN", "Main status?", "100.1");
    await say("UFOUNDER", "C-PSA", "PSA status?", "101.1");
    expect(rowWith("Main status?")?.destinationSession).toBe("advisor@kernel");
    expect(rowWith("PSA status?")?.destinationSession).toBe("psa-dev@psa");
  });

  it("a seat's park posts in its own channel, and the human's reply there routes back to it", async () => {
    const work = await repo.create({ sourceSession: "psa-dev@psa", destinationSession: "psa-dev@psa", body: "Merge the theme fix.", nudge: false });
    repo.update({ qitemId: work.qitemId, actorSession: "psa-dev@psa", state: "blocked", blockedOn: "human-founder@kernel", summary: "Merge it?", evidenceRef: "/proof/theme.md", transitionNote: "parked" });
    await vi.waitFor(() => expect(posts.some((p) => String(p.text).includes("Merge it?"))).toBe(true));
    const park = posts.find((p) => String(p.text).includes("Merge it?"))!;
    expect(park.channel).toBe("C-PSA");
    const root = `${posts.indexOf(park) + 1}.1`;
    await say("UFOUNDER", "C-PSA", "Which branch?", "102.1", root);
    expect(rowWith("Which branch?")?.destinationSession).toBe("psa-dev@psa");
  });

  it("a reply to a message in the second channel stays in that channel's thread", async () => {
    await say("UFOUNDER", "C-PSA", "Change the header", "103.1");
    const inbound = rowWith("Change the header")!;
    await repo.create({ sourceSession: "psa-dev@psa", destinationSession: "human-founder@external", humanIntent: "update", summary: "Done", body: "Header changed.", replyTo: inbound.qitemId, nudge: false });
    await vi.waitFor(() => expect(posts.some((p) => String(p.text).includes("Header changed."))).toBe(true));
    expect(posts.find((p) => String(p.text).includes("Header changed."))).toMatchObject({ channel: "C-PSA", thread_ts: "103.1" });
  });

  it("with more than one human in a channel, only an @mention addresses the app, in its threads too", async () => {
    await vi.waitFor(() => expect(counted).toEqual(expect.arrayContaining(["C-PSA", "C-MAIN"])));
    await new Promise((r) => setTimeout(r, 50));
    await say("UFOUNDER", "C-PSA", "Lunch at noon, everyone", "106.1");
    await say("UFOUNDER", "C-PSA", "<@UBOT> please fix the footer", "107.1");
    const quiet = rowWith("Lunch at noon");
    expect(quiet?.destinationSession).toBe("psa-dev@psa");
    expect(quiet?.tags).toEqual(expect.arrayContaining(["not-addressed", "conversation"]));
    const asked = rowWith("please fix the footer");
    expect(asked?.tags).not.toContain("not-addressed");
    await vi.waitFor(() => expect(reactions.some((r) => r.timestamp === "107.1")).toBe(true));
    expect(reactions.some((r) => r.timestamp === "106.1")).toBe(false);
    await say("UFOUNDER", "C-PSA", "And the header too", "109.1", "107.1");
    expect(rowWith("And the header too")?.tags).toContain("not-addressed");
    await say("UFOUNDER", "C-MAIN", "One human here, other members are bots", "108.1");
    expect(rowWith("One human here")?.tags).not.toContain("not-addressed");
    const before = counted.filter((c) => c === "C-PSA").length;
    socket.onmessage?.({ data: JSON.stringify({ envelope_id: "e-join", type: "events_api", payload: { event: { type: "member_joined_channel", user: "UNEW", channel: "C-PSA" } } }) });
    await vi.waitFor(() => expect(counted.filter((c) => c === "C-PSA").length).toBe(before + 1));
  });

  it("a requester bound to one channel is heard only there, as untrusted conversation", async () => {
    await say("ULEE", "C-MAIN", "Hello from main", "104.1");
    await say("ULEE", "C-PSA", "Make the logo bigger", "105.1");
    expect(rowWith("Hello from main")).toBeUndefined();
    const row = rowWith("Make the logo bigger");
    expect(row?.destinationSession).toBe("psa-dev@psa");
    expect(row?.tags).toContain("untrusted-requester");
  });
});
