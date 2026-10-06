// Phase 1 request lifecycle: a human request (its Slack thread) closes only on its linked
// outcome or an explicit cancel. Stale requests get reminders, and a reminder never closes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { ThreadSeatMap } from "../src/domain/gateway/slack/thread-seat-map.js";
import { Hono } from "hono";
import { queueRoutes } from "../src/routes/queue.js";
import { sweepRequests, type LinkState, type RequestLink } from "../src/domain/gateway/slack/request-lifecycle.js";

const human = "human-founder@external";
const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: human, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } }] };
const request = { sourceSession: "author@rig", destinationSession: human, summary: "Ship the migration?", body: "Tell me whether to ship it.", evidenceRef: "/private/proof.md", nudge: false };
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-06T08:00:00.000Z");

describe("phase 1 request lifecycle sweep", () => {
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let map: ThreadSeatMap;
  let threadPosts: Array<{ threadTs: string; text: string }>;
  let github: Map<string, LinkState>;
  let decisionId: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    map = new ThreadSeatMap(db);
    threadPosts = [];
    github = new Map();
    decisionId = (await repo.create({ ...request, humanIntent: "decision" })).qitemId;
    map.open({ threadTs: "1.1", channel: "C-TEST", human, seat: "author@rig", conversationId: decisionId });
  });
  afterEach(() => { vi.useRealTimers(); db.close(); });

  const sweep = (staleReminderDays = 3, floorMs = 0) => sweepRequests({
    queueRepo: repo, threadMap: map, staleReminderDays, floorMs,
    linkState: async (link: RequestLink) => github.get(link.ref) ?? "open",
    postInThread: async (_channel, threadTs, text) => { threadPosts.push({ threadTs, text }); return true; },
  });
  const link = (ref: string): unknown => repo.addRequestLinks({ qitemId: decisionId, actorSession: "author@rig", links: [ref] });
  const resolve = () => repo.update({ qitemId: decisionId, actorSession: human, state: "done", closureReason: "no-follow-on", transitionNote: "direct human reply received: yes", ownerNotificationKind: "human-decision-resolved" });
  const isOpen = () => map.resolveByThread("1.1")?.state === "open";
  const toSeat = () => repo.list({ limit: 100 }).filter((q) => q.destinationSession === "author@rig");
  const at = (days: number) => vi.setSystemTime(new Date(T0.getTime() + days * DAY));

  describe("links", () => {
    it("records pr, issue and qitem links as typed transitions on the request", async () => {
      const work = await repo.create({ sourceSession: "author@rig", destinationSession: "author@rig", body: "do it", nudge: false });
      link("pr:https://github.com/reco/openrig/pull/1");
      link(`qitem:${work.qitemId}`);
      expect(repo.requestLinks(decisionId)).toEqual([
        { kind: "pr", ref: "https://github.com/reco/openrig/pull/1" },
        { kind: "qitem", ref: work.qitemId },
      ]);
    });

    it("links over HTTP on update and on create, and refuses a bad link before changing anything", async () => {
      const app = new Hono();
      app.use("*", async (c, next) => { (c.set as (k: string, v: unknown) => void)("queueRepo", repo); await next(); });
      app.route("/api/queue", queueRoutes());
      const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "author@rig" }, body: JSON.stringify(body) });
      expect((await post(`/api/queue/${decisionId}/update`, { links: ["pr:https://github.com/reco/openrig/pull/1"] })).status).toBe(200);
      expect(repo.requestLinks(decisionId)).toEqual([{ kind: "pr", ref: "https://github.com/reco/openrig/pull/1" }]);
      const bad = await post(`/api/queue/${decisionId}/update`, { state: "canceled", links: ["pr:nope"] });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: "invalid_request_link" });
      expect(repo.getById(decisionId)?.state).toBe("pending");
      const created = await post("/api/queue/create", { ...request, humanIntent: "decision", links: ["issue:https://github.com/reco/openrig/issues/9"] });
      expect(created.status).toBe(201);
      expect(repo.requestLinks((await created.json()).qitemId)).toEqual([{ kind: "issue", ref: "https://github.com/reco/openrig/issues/9" }]);
      expect((await post("/api/queue/create", { ...request, humanIntent: "decision", links: ["nope"] })).status).toBe(400);
    });

    it.each([["nope:x"], ["pr:"], ["qitem:qitem-missing"], ["pr:not a url"]])("refuses %s with a named error", (bad) => {
      expect(() => link(bad)).toThrow(expect.objectContaining({ code: "invalid_request_link" }));
    });
  });

  describe("closing", () => {
    it("closes when the linked PR merges, and says so in the thread", async () => {
      resolve();
      link("pr:https://github.com/reco/openrig/pull/1");
      await sweep();
      expect(isOpen()).toBe(true);
      github.set("https://github.com/reco/openrig/pull/1", "merged");
      await sweep();
      expect(isOpen()).toBe(false);
      expect(threadPosts.at(-1)).toMatchObject({ threadTs: "1.1" });
      expect(threadPosts.at(-1)?.text).toMatch(/closed/i);
      expect(repo.transitionLog.listForQitem(decisionId).some((t) => t.transitionNote?.startsWith("request-closed "))).toBe(true);
    });

    it("closes when a linked PR or issue is closed unmerged", async () => {
      link("issue:https://github.com/reco/openrig/issues/2");
      github.set("https://github.com/reco/openrig/issues/2", "closed");
      await sweep();
      expect(isOpen()).toBe(false);
    });

    it.each([["done", "no-follow-on"], ["canceled", undefined]])("closes when the linked queue work is %s", async (state, closureReason) => {
      const work = await repo.create({ sourceSession: "author@rig", destinationSession: "author@rig", body: "do it", nudge: false });
      link(`qitem:${work.qitemId}`);
      await sweep();
      expect(isOpen()).toBe(true);
      repo.update({ qitemId: work.qitemId, actorSession: "author@rig", state: state as "done", closureReason, transitionNote: "finished" });
      await sweep();
      expect(isOpen()).toBe(false);
    });

    it("stays open until every link is finished", async () => {
      link("pr:https://github.com/reco/openrig/pull/1");
      link("pr:https://github.com/reco/openrig/pull/3");
      github.set("https://github.com/reco/openrig/pull/1", "merged");
      await sweep();
      expect(isOpen()).toBe(true);
    });

    it("an unanswered decision closed by its outcome is done; nothing else changes it", async () => {
      link("pr:https://github.com/reco/openrig/pull/1");
      github.set("https://github.com/reco/openrig/pull/1", "merged");
      await sweep();
      expect(repo.getById(decisionId)?.state).toBe("done");
    });

    it("closes when a seat cancels the request through the queue", async () => {
      repo.update({ qitemId: decisionId, actorSession: "author@rig", state: "canceled", transitionNote: "no longer needed" });
      await sweep();
      expect(isOpen()).toBe(false);
    });

    it("never closes a request without links, however old", async () => {
      at(60);
      await sweep();
      expect(isOpen()).toBe(true);
      expect(repo.getById(decisionId)?.state).toBe("pending");
    });

    it("an unknown link state keeps the request open", async () => {
      link("pr:https://github.com/reco/openrig/pull/1");
      github.set("https://github.com/reco/openrig/pull/1", "unknown");
      await sweep();
      expect(isOpen()).toBe(true);
    });
  });

  describe("stale reminders", () => {
    it("reminds the human in the thread after 3 quiet days, again 3 days later, and never closes", async () => {
      at(2.9); await sweep();
      expect(threadPosts).toEqual([]);
      at(3.1); await sweep(); await sweep();
      expect(threadPosts).toHaveLength(1);
      expect(threadPosts[0]).toMatchObject({ threadTs: "1.1" });
      expect(threadPosts[0]?.text).toContain("answer:");
      at(5); await sweep();
      expect(threadPosts).toHaveLength(1);
      at(6.2); await sweep();
      expect(threadPosts).toHaveLength(2);
      expect(isOpen()).toBe(true);
      expect(repo.getById(decisionId)?.state).toBe("pending");
    });

    it("counts thread activity as not stale", async () => {
      at(2);
      await repo.create({ sourceSession: human, destinationSession: "author@rig", body: "question", tags: ["founder-slack", "inbound", "thread", `reply-to:${decisionId}`], nudge: false });
      at(4); await sweep();
      expect(threadPosts).toEqual([]);
      at(5.1); await sweep();
      expect(threadPosts).toHaveLength(1);
    });

    it("leaves requests posted before the lifecycle floor alone", async () => {
      link("pr:https://github.com/reco/openrig/pull/1");
      github.set("https://github.com/reco/openrig/pull/1", "merged");
      at(30); await sweep(3, T0.getTime());
      expect(isOpen()).toBe(true);
      expect(threadPosts).toEqual([]);
    });

    it("sends the seat reminder from the daemon, not the human", async () => {
      resolve();
      at(3.1); await sweep();
      expect(toSeat().find((q) => q.tags?.includes("request-reminder"))?.sourceSession).toBe("daemon@kernel");
    });

    it("a re-parked gate reminds the human even though an earlier gate was answered", async () => {
      const work = await repo.create({ sourceSession: "author@rig", destinationSession: "author@rig", body: "Work", nudge: false });
      const parkIt = (summary: string) => repo.update({ qitemId: work.qitemId, actorSession: "author@rig", state: "blocked", blockedOn: "human-founder@kernel", summary, evidenceRef: "/proof.md", transitionNote: "park" });
      parkIt("First gate");
      repo.update({ qitemId: work.qitemId, actorSession: human, state: "in-progress", transitionNote: "approved", ownerNotificationKind: "human-decision-resolved" });
      parkIt("Second gate");
      map.close("1.1");
      map.open({ threadTs: "2.1", channel: "C-TEST", human, seat: "author@rig", conversationId: work.qitemId });
      at(3.1); await sweep();
      expect(threadPosts.some((p) => p.threadTs === "2.1")).toBe(true);
      expect(toSeat().filter((q) => q.tags?.includes("request-reminder"))).toEqual([]);
    });

    it("uses the configured interval", async () => {
      at(1.1); await sweep(1);
      expect(threadPosts).toHaveLength(1);
    });

    it("once resolved, nudges the owning seat through the queue and never the human", async () => {
      resolve();
      at(3.1); await sweep();
      expect(threadPosts).toEqual([]);
      const nudges = toSeat().filter((q) => q.tags?.includes("request-reminder"));
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.body).toContain(decisionId);
      expect(nudges[0]?.body).toContain("--link");
      expect(isOpen()).toBe(true);
    });

    it("closed requests get no reminders", async () => {
      link("pr:https://github.com/reco/openrig/pull/1");
      github.set("https://github.com/reco/openrig/pull/1", "merged");
      await sweep();
      const posted = threadPosts.length;
      at(30); await sweep();
      expect(threadPosts).toHaveLength(posted);
      expect(toSeat().filter((q) => q.tags?.includes("request-reminder"))).toEqual([]);
    });
  });
});
