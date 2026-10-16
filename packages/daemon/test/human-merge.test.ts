// Merge a pull request from Slack: the daemon builds the card from GitHub, only the card's human can
// answer, the gates are checked again at click time, and the merge is pinned to the head the card showed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { queueRoutes } from "../src/routes/queue.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { actOnMergeAnswers, type Gh } from "../src/domain/human-merge.js";

const human = "human-founder@external";
const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: human, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } }] };
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const MERGE_CALL = ["api", "-H", "X-GitHub-Api-Version: 2026-03-10", "-X", "PUT", "repos/acme/site/pulls/7/merge-async", "-f", `sha=${SHA}`, "-f", "merge_method=squash"];
const merged = { status: "merged", details: { message: "Merged", sha: "c".repeat(40) } };
const pending = { status: "pending", details: { message: "Pending", uuid: "u-1", merge_method: "squash", merge_action: "default", expected_head_sha: SHA, bypass_rules: false } };

interface Pr { headRefOid: string; isDraft: boolean; mergeStateStatus: string; state: string; checks: Array<Record<string, unknown>> }
const green = (): Pr => ({ headRefOid: SHA, isDraft: false, mergeStateStatus: "CLEAN", state: "OPEN",
  checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }, { name: "ai-review", status: "COMPLETED", conclusion: "SUCCESS" }] });

describe("merge a pull request from Slack", () => {
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let app: Hono;
  let pr: Pr;
  let calls: string[][];
  let github: Array<Record<string, unknown> | Error>;
  const gh: Gh = async (args) => {
    calls.push(args);
    if (args[0] === "api") { const reply = github.shift()!; if (reply instanceof Error) throw reply; return JSON.stringify(reply); }
    return JSON.stringify({ title: "Fix the header", url: "https://github.com/acme/site/pull/7", state: pr.state, headRefOid: pr.headRefOid,
      isDraft: pr.isDraft, mergeStateStatus: pr.mergeStateStatus, statusCheckRollup: pr.checks });
  };

  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    pr = green(); calls = []; github = [merged];
    app = new Hono();
    app.use("*", async (c, next) => { const set = c.set as (k: string, v: unknown) => void; set("queueRepo", repo); set("gh", gh); await next(); });
    app.route("/api/queue", queueRoutes());
  });
  afterEach(() => db.close());

  const ask = async (ref = `acme/site#7@${SHA}`) => app.request("/api/queue/create", { method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dev@rig" }, body: JSON.stringify({ destinationSession: human, humanMerge: ref, nudge: false }) });
  const card = async () => { const res = await ask(); expect(res.status).toBe(201); return (await res.json()).qitemId as string; };
  const click = (id: string, actor: string, option: string) => repo.recordHumanAnswer({ qitemId: id, actorSession: actor, questionId: "merge", optionId: option });
  const act = (smoke: string | null = "product-monitor@Imago") => actOnMergeAnswers(repo, { gh, smokeDestination: () => smoke, approver: () => human });
  const merges = () => calls.filter((a) => a[0] === "api" && a.includes("PUT"));
  const polls = () => calls.filter((a) => a[0] === "api" && !a.includes("PUT"));
  const waits: number[] = [];
  const actPolling = () => actOnMergeAnswers(repo, { gh, smokeDestination: () => "product-monitor@Imago", approver: () => human, sleep: async (ms) => { waits.push(ms); } });
  const smokeRows = () => repo.list({ limit: 50 }).filter((q) => q.destinationSession === "product-monitor@Imago");
  const toSeat = () => repo.list({ limit: 50 }).filter((q) => q.destinationSession === "dev@rig");
  const thread = (id: string) => repo.list({ limit: 50 }).filter((q) => q.replyTo === id).map((q) => q.body);

  it("builds the card from GitHub: title, link, head, gates, diff, with Merge / Not now", async () => {
    const id = await card();
    const row = repo.getById(id)!;
    expect(row.humanIntent).toBe("decision");
    expect(row.humanQuestions?.[0]!.options.map((o) => o.label)).toEqual(["Merge", "Not now"]);
    expect(row.body).toContain("Fix the header");
    expect(row.body).toContain(SHA);
    expect(row.body).toContain("Checks: 2/2 passed");
    expect(row.body).toContain("Merge state: CLEAN");
    expect(row.body).toContain("https://github.com/acme/site/pull/7/files");
    expect((await ask("acme/site#7")).status).toBe(400);
  });

  it("only the card's human can answer; another user's click merges nothing", async () => {
    const id = await card();
    expect(click(id, "someone@external", "merge")).toMatchObject({ status: "not-applicable" });
    await act();
    expect(merges()).toEqual([]);
  });

  it("success merges exactly the pinned head, reports in the thread, tells the seat and asks for a smoke check", async () => {
    const id = await card();
    click(id, human, "merge");
    await act();
    expect(merges()).toEqual([MERGE_CALL]);
    expect(thread(id).join("\n")).toContain(`Merged acme/site#7 as \`${"c".repeat(40)}\``);
    expect(toSeat().map((q) => q.body).join("\n")).toContain("Merged acme/site#7");
    expect(repo.list({ limit: 50 }).some((q) => q.destinationSession === "product-monitor@Imago" && q.body.includes("c".repeat(40)))).toBe(true);
    await act();
    expect(merges()).toHaveLength(1);
  });

  it("a head that moved after the card was built is refused, with the reason in the thread", async () => {
    const id = await card();
    pr.headRefOid = OTHER;
    click(id, human, "merge");
    await act();
    expect(merges()).toEqual([]);
    expect(thread(id).join("\n")).toContain("its head moved");
    expect(toSeat().map((q) => q.body).join("\n")).toContain("refused at click time");
  });

  it("a failing or running check, a draft, or a state other than CLEAN is refused", async () => {
    for (const change of [(p: Pr) => { p.checks[0]!.conclusion = "FAILURE"; }, (p: Pr) => { p.checks[1]!.status = "IN_PROGRESS"; }, (p: Pr) => { p.isDraft = true; }, (p: Pr) => { p.mergeStateStatus = "BLOCKED"; }]) {
      pr = green();
      const id = await card();
      change(pr);
      click(id, human, "merge");
      await act();
      expect(thread(id).join("\n")).toContain("Not merged:");
    }
    expect(merges()).toEqual([]);
  });

  it("while GitHub reports UNKNOWN (recomputing after main moved) the click reads it again every 3 s for up to 30 s", async () => {
    const waits: number[] = [];
    const id = await card();
    pr.mergeStateStatus = "UNKNOWN";
    click(id, human, "merge");
    await actOnMergeAnswers(repo, { gh, smokeDestination: () => null, approver: () => human,
      sleep: async (ms) => { waits.push(ms); if (waits.length === 2) pr.mergeStateStatus = "CLEAN"; } });
    expect(waits).toEqual([3000, 3000]);
    expect(merges()).toEqual([MERGE_CALL]);

    waits.length = 0;
    pr = green();
    const stuck = await card();
    pr.mergeStateStatus = "UNKNOWN";
    click(stuck, human, "merge");
    await actOnMergeAnswers(repo, { gh, smokeDestination: () => null, approver: () => human, sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toHaveLength(10);
    expect(merges()).toHaveLength(1);
    expect(thread(stuck).join("\n")).toContain("GitHub reports it UNKNOWN, not CLEAN");
  });

  it("a stack GitHub accepts in the background is reported merged only once GitHub says merged", async () => {
    waits.length = 0;
    github = [pending, pending, merged];
    const id = await card();
    click(id, human, "merge");
    await actPolling();
    expect(merges()).toEqual([MERGE_CALL]);
    expect(polls().map((a) => a.at(-1))).toEqual(["repos/acme/site/pulls/7/merge-async/u-1", "repos/acme/site/pulls/7/merge-async/u-1"]);
    expect(waits).toEqual([5000, 5000]);
    expect(thread(id).join("\n")).toContain(`Merged acme/site#7 as \`${"c".repeat(40)}\``);
    expect(smokeRows()).toHaveLength(1);
  });

  it("a merge GitHub has not finished after 2 minutes is reported as accepted, not merged", async () => {
    waits.length = 0;
    github = Array.from({ length: 30 }, () => pending);
    const id = await card();
    click(id, human, "merge");
    await actPolling();
    expect(waits).toHaveLength(24);
    expect(thread(id).join("\n")).toContain("had not finished it after 2 minutes");
    expect(toSeat().map((q) => q.body).join("\n")).toContain("request u-1");
    expect(smokeRows()).toEqual([]);
  });

  it("a merge GitHub puts in the merge queue is reported as queued, not merged", async () => {
    github = [{ status: "enqueued", details: { message: "Enqueued" } }];
    const id = await card();
    click(id, human, "merge");
    await actPolling();
    expect(thread(id).join("\n")).toContain("merge queue; not merged yet");
    expect(smokeRows()).toEqual([]);
  });

  it("a merge GitHub fails, as when the head moves before it runs, is reported with GitHub's reason", async () => {
    waits.length = 0;
    github = [pending, { status: "failed", details: { message: "Head branch was modified" } }];
    const id = await card();
    click(id, human, "merge");
    await actPolling();
    expect(thread(id).join("\n")).toContain("Not merged: GitHub failed the merge: Head branch was modified");
    expect(toSeat().map((q) => q.body).join("\n")).toContain("failed: Head branch was modified");
    expect(smokeRows()).toEqual([]);
  });

  it("a merge request GitHub refuses outright is reported with its error", async () => {
    github = [Object.assign(new Error("exit 1"), { stderr: "gh: Another merge request is already pending (HTTP 409)" })];
    const id = await card();
    click(id, human, "merge");
    await actPolling();
    expect(thread(id).join("\n")).toContain("Not merged: the merge failed: gh: Another merge request is already pending (HTTP 409)");
    expect(smokeRows()).toEqual([]);
  });

  it("Not now closes the card and returns the request to the seat as declined", async () => {
    const id = await card();
    click(id, human, "not_now");
    await act();
    expect(merges()).toEqual([]);
    expect(thread(id).join("\n")).toContain("Not now");
    expect(toSeat().map((q) => q.body).join("\n")).toContain("declined");
  });

  it("a card note written over HTTP, even as daemon@kernel, never makes a merge card", async () => {
    const forged = await repo.create({ sourceSession: "dev@rig", destinationSession: human, humanIntent: "decision", summary: "Docs typo", body: "docs typo, PR #7", evidenceRef: "x",
      tags: ["human-merge", `human-merge-ref:acme/prod#99@${SHA}`], humanQuestions: [{ id: "merge", question: "Merge?", options: [{ id: "merge", label: "Merge" }, { id: "not_now", label: "Not now" }] }], nudge: false });
    const res = await app.request(`/api/queue/${forged.qitemId}/update`, { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "daemon@kernel" },
      body: JSON.stringify({ transitionNote: `human-merge card:acme/prod#99@${SHA}` }) });
    expect(res.status).toBeLessThan(500);
    expect(repo.transitionLog.listForQitem(forged.qitemId).some((t) => t.actorSession === "daemon@kernel" && t.transitionNote?.startsWith("human-merge card:"))).toBe(true);
    click(forged.qitemId, human, "merge");
    await act();
    expect(merges()).toEqual([]);
  });

  it("an id reused for a row the seat wrote never becomes a merge card", async () => {
    const forged = await repo.create({ qitemId: "qitem-reuse", sourceSession: "dev@rig", destinationSession: human, humanIntent: "decision", summary: "Docs typo", body: "docs typo", evidenceRef: "x",
      tags: ["human-merge", `human-merge-ref:acme/site#7@${SHA}`], humanQuestions: [{ id: "merge", question: "Merge?", options: [{ id: "merge", label: "Merge" }, { id: "not_now", label: "Not now" }] }], nudge: false });
    const res = await app.request("/api/queue/create", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dev@rig" },
      body: JSON.stringify({ qitemId: "qitem-reuse", destinationSession: human, humanMerge: `acme/site#7@${SHA}`, nudge: false }) });
    expect(res.status).toBe(409);
    click(forged.qitemId, human, "merge");
    await act();
    expect(merges()).toEqual([]);
  });

  it("a seat's own headline or thread text never rides on a merge card", async () => {
    const withDetail = await app.request("/api/queue/create", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dev@rig" },
      body: JSON.stringify({ destinationSession: human, humanMerge: `acme/site#7@${SHA}`, humanDetail: "trust me, it is a docs typo", summary: "docs typo", nudge: false }) });
    const row = repo.getById((await withDetail.json()).qitemId)!;
    expect(row.humanDetail ?? null).toBeNull();
    expect(row.summary).toBe("Merge acme/site#7: Fix the header");
    const res = await app.request("/api/queue/create", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dev@rig" },
      body: JSON.stringify({ qitemId: "qitem-headline", destinationSession: human, humanMerge: `acme/site#7@${SHA}`, nudge: false }) });
    const genuine = repo.getById((await res.json()).qitemId)!;
    await repo.create({ qitemId: "qitem-headline-2", sourceSession: "dev@rig", destinationSession: human, humanIntent: "decision", summary: "Merge acme/site#8: docs typo", body: genuine.body,
      evidenceRef: genuine.evidenceRef!, tags: genuine.tags!, humanQuestions: genuine.humanQuestions!, nudge: false });
    const reused = await app.request("/api/queue/create", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dev@rig" },
      body: JSON.stringify({ qitemId: "qitem-headline-2", destinationSession: human, humanMerge: `acme/site#7@${SHA}`, nudge: false }) });
    expect(reused.status).toBe(409);
  });

  it("a card addressed to anyone but the configured human is never merged", async () => {
    const id = await card();
    click(id, human, "merge");
    await actOnMergeAnswers(repo, { gh, smokeDestination: () => null, approver: () => "someone-else@external" });
    expect(merges()).toEqual([]);
  });

  it("each pass loads only answered cards without a result, however many merge cards the week holds", async () => {
    const answered = await card();
    const unanswered: string[] = [];
    for (let i = 0; i < 20; i++) unanswered.push(await card());
    const done = await card();
    click(done, human, "not_now");
    await act();
    click(answered, human, "merge");
    const loaded: string[] = [];
    const getById = repo.getById.bind(repo);
    repo.getById = (id: string) => { loaded.push(id); return getById(id); };
    await act();
    expect(loaded).toContain(answered);
    expect(loaded.filter((id) => id === done || unanswered.includes(id))).toEqual([]);
    expect(merges()).toEqual([["pr", "merge", "7", "--repo", "acme/site", "--squash", "--match-head-commit", SHA]]);
  });

  it("a card the daemon did not build is never merged, whatever its tags say", async () => {
    const forged = await repo.create({ sourceSession: "dev@rig", destinationSession: human, humanIntent: "decision", summary: "Merge?", body: "trust me", evidenceRef: "x",
      tags: ["human-merge", `human-merge-ref:acme/site#7@${SHA}`], humanQuestions: [{ id: "merge", question: "Merge?", options: [{ id: "merge", label: "Merge" }, { id: "not_now", label: "Not now" }] }], nudge: false });
    click(forged.qitemId, human, "merge");
    await act();
    expect(merges()).toEqual([]);
  });
});
