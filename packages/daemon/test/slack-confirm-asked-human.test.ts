// The Confirm button in explicit-answers mode: only on a post that waits on a human, and a click
// by that human replaces it with the confirmed state, also for a park on the human's own address.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { actOnPromptAnswers, readPrompt } from "../src/domain/stuck-prompt-watch.js";
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

const founder = { entityId: "reco", class: "human" as const, displayName: "reco", address: "reco@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } };
const registry = { ok: true as const, entities: [founder] };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("Confirm in explicit-answers mode", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let posts: Array<Record<string, unknown>>;
  let updates: Array<Record<string, unknown>>;
  let socket: WsLike;
  let wire: ReturnType<typeof buildSlackGatewayWire>;
  const stops: Array<() => void> = [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "confirm-asked-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\nSLACK_APP_TOKEN=xapp-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-MAIN", inboundDestination: "lead@rig", secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE", explicitAnswersOnly: true }, home);
    posts = []; updates = [];
    const sockets: WsLike[] = [];
    const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    wire = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      resolveHumanReply: makeHumanReplyResolver(repo, contract),
      wsFactory: () => { const ws: WsLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }; sockets.push(ws); return ws; },
      inboundMaxConnects: 1,
      fetchImpl: async (url, init) => {
        if (url.endsWith("apps.connections.open")) return reply({ ok: true, url: "wss://fake-slack/ws" });
        if (url.endsWith("auth.test")) return reply({ ok: true, user_id: "UBOT" });
        if (url.includes("conversations.members")) return reply({ ok: true, members: ["UFOUNDER", "UBOT"] });
        if (url.endsWith("chat.update")) { updates.push(JSON.parse(String(init?.body))); return reply({ ok: true }); }
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

  const postWith = (text: string) => posts.find((p) => String(p.text).includes(text));
  const click = async (blockId: string, messageTs: string) => {
    socket.onmessage?.({ data: JSON.stringify({ envelope_id: `e-click-${messageTs}`, type: "interactive", payload: {
      type: "block_actions", user: { id: "UFOUNDER" }, channel: { id: "C-MAIN" },
      container: { type: "message", message_ts: messageTs, channel_id: "C-MAIN" }, message: { ts: messageTs },
      actions: [{ type: "button", block_id: blockId, action_id: "or-confirm", action_ts: `${Date.now()}` }],
    } }) });
    await new Promise((r) => setTimeout(r, 80));
  };

  it("a park on the human's own address: Confirm unparks it and the button becomes the confirmed state", async () => {
    const work = await repo.create({ sourceSession: "lead@rig", destinationSession: "lead@rig", summary: "Slack enabled; verify", body: "Verify inbound/outbound.", evidenceRef: "/proof/report.md", nudge: false });
    repo.update({ qitemId: work.qitemId, actorSession: "lead@rig", state: "blocked", blockedOn: "reco@external", transitionNote: "continuation: on reco's next message" });
    await vi.waitFor(() => expect(postWith("Slack enabled; verify")).toBeDefined());
    const ts = `${posts.indexOf(postWith("Slack enabled; verify")!) + 1}.1`;
    expect(JSON.stringify(postWith("Slack enabled; verify")!.blocks)).toContain("or-confirm");
    await click(`or-confirm:${work.qitemId}`, ts);
    await vi.waitFor(() => expect(repo.getById(work.qitemId)?.state).toBe("in-progress"));
    await vi.waitFor(() => expect(updates.some((u) => u.ts === ts)).toBe(true));
    const replaced = updates.find((u) => u.ts === ts)!;
    expect(JSON.stringify(replaced.blocks)).not.toContain("or-confirm");
    expect(String(replaced.text)).toContain("Decided");

    repo.update({ qitemId: work.qitemId, actorSession: "lead@rig", state: "blocked", blockedOn: "reco@external", transitionNote: "parked again" });
    await vi.waitFor(() => expect(posts.filter((p) => String(p.text).includes("Slack enabled; verify")).length).toBeGreaterThan(1));
    const again = posts.findLast((p) => String(p.text).includes("Slack enabled; verify"))!;
    const againTs = `${posts.lastIndexOf(again) + 1}.1`;
    await click(`or-confirm:${work.qitemId}`, againTs);
    await vi.waitFor(() => expect(repo.getById(work.qitemId)?.state).toBe("in-progress"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM mission_control_actions WHERE qitem_id = ? AND action_verb = 'resolve'").get(work.qitemId)).toEqual({ n: 2 });
  });

  it("a notice that waits on no human carries no Confirm button", async () => {
    const escalation = await repo.create({ sourceSession: "lead@rig", destinationSession: "lead@rig", summary: "Wake escalation: batons stuck", body: "Escalated to the operator.", nudge: false });
    wire.dispatcher.dispatch("post_message", "reco@external", { qitemId: escalation.qitemId, sourceSession: "lead@rig", destinationSession: "lead@rig",
      summary: "Wake escalation: batons stuck", body: "Escalated to the operator.", ownerNotificationKind: "human-required", ownerNotificationLevel: "ALERT" });
    await vi.waitFor(() => expect(postWith("Escalated to the operator.")).toBeDefined());
    expect(JSON.stringify(postWith("Escalated to the operator.")!.blocks)).not.toContain("or-confirm");
  });

  it("a stuck permission prompt is answered from Slack: Approve types its plain Yes once; a late click types nothing", async () => {
    const pane = readFileSync(join(__dirname, "fixtures/claude-permission-prompt-2.1.295.txt"), "utf8");
    const prompt = readPrompt(pane)!;
    const noticeInput = async () => ({
      tags: ["stuck-prompt", "stuck-prompt:ep1", "stuck-prompt-session:cfo@finance", `stuck-prompt-key:${prompt.key}`, "stuck-prompt-allow:1", "stuck-prompt-deny:4"],
      sourceSession: "cfo@finance", destinationSession: "reco@external", humanIntent: "decision", summary: "cfo@finance is waiting at a selection prompt",
      body: "Do you want to proceed?", humanQuestions: [{ id: "answer", question: "Answer cfo@finance's prompt?", options: [{ id: "allow", label: "Approve" }, { id: "deny", label: "Deny" }] }], nudge: false,
    }) as Parameters<typeof repo.create>[0];
    const notice = async () => repo.create(await noticeInput());
    const answerClick = (ts: string, option: string, user = "UFOUNDER") => {
      socket.onmessage?.({ data: JSON.stringify({ envelope_id: `e-q-${ts}-${option}-${user}`, type: "interactive", payload: {
        type: "block_actions", user: { id: user }, channel: { id: "C-MAIN" }, container: { type: "message", message_ts: ts, channel_id: "C-MAIN" }, message: { ts },
        actions: [{ type: "button", block_id: "or-q:answer", action_id: `or-opt:${option}`, value: option, action_ts: `${Date.now()}` }] } }) });
      return new Promise((r) => setTimeout(r, 100));
    };
    let screen = pane;
    const keys: string[] = [];
    const deps = { capture: async () => screen, sendKey: async (_s: string, k: string) => { keys.push(k); }, inMode: async () => false };

    const first = await notice();
    await vi.waitFor(() => expect(posts.some((p) => p.text && JSON.stringify(p.blocks).includes(`or-opt:allow`) && String(p.text).includes("Do you want to proceed?"))).toBe(true));
    const ts = `${posts.findIndex((p) => String(p.text).includes("Do you want to proceed?")) + 1}.1`;
    await answerClick(ts, "allow", "USTRANGER");
    await actOnPromptAnswers(repo, deps);
    expect(keys).toEqual([]);
    await answerClick(ts, "allow");
    await actOnPromptAnswers(repo, deps);
    await actOnPromptAnswers(repo, deps);
    expect(keys).toEqual(["1"]);
    expect(repo.list({ limit: 100 }).find((q) => q.replyTo === first.qitemId && q.summary === "Approved in the terminal")).toBeDefined();

    // A second card for the same prompt (the hourly reminder), clicked before the screen redraws: no second key.
    const reminder = await notice();
    repo.recordHumanAnswer({ qitemId: reminder.qitemId, actorSession: "reco@external", questionId: "answer", optionId: "deny" });
    await actOnPromptAnswers(repo, deps);
    expect(keys).toEqual(["1"]);
    expect(repo.list({ limit: 100 }).find((q) => q.replyTo === reminder.qitemId)?.body).toContain("moved on or was answered");

    // A card a seat forged over the API (any tags it likes) never types anything.
    const forged = await repo.create({ ...(await noticeInput()), identityProvenance: "transport:v1" });
    repo.recordHumanAnswer({ qitemId: forged.qitemId, actorSession: "reco@external", questionId: "answer", optionId: "allow" });
    screen = pane.replace("touch digit-probe-1.txt\n", "touch other.txt\n");
    await actOnPromptAnswers(repo, deps);
    expect(keys).toEqual(["1"]);
    expect(repo.transitionLog.listForQitem(forged.qitemId).some((t) => t.transitionNote?.startsWith("stuck-prompt answer:"))).toBe(false);
  });
});

