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

interface Pr { headRefOid: string; isDraft: boolean; mergeStateStatus: string; state: string; checks: Array<Record<string, unknown>> }
const green = (): Pr => ({ headRefOid: SHA, isDraft: false, mergeStateStatus: "CLEAN", state: "OPEN",
  checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }, { name: "ai-review", status: "COMPLETED", conclusion: "SUCCESS" }] });

describe("merge a pull request from Slack", () => {
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let app: Hono;
  let pr: Pr;
  let calls: string[][];
  const gh: Gh = async (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "merge") return "";
    if (args.includes("mergeCommit")) return JSON.stringify({ mergeCommit: { oid: "c".repeat(40) } });
    return JSON.stringify({ title: "Fix the header", url: "https://github.com/acme/site/pull/7", state: pr.state, headRefOid: pr.headRefOid,
      isDraft: pr.isDraft, mergeStateStatus: pr.mergeStateStatus, statusCheckRollup: pr.checks });
  };

  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    pr = green(); calls = [];
    app = new Hono();
    app.use("*", async (c, next) => { const set = c.set as (k: string, v: unknown) => void; set("queueRepo", repo); set("gh", gh); await next(); });
    app.route("/api/queue", queueRoutes());
  });
  afterEach(() => db.close());

  const ask = async (ref = `acme/site#7@${SHA}`) => app.request("/api/queue/create", { method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dev@rig" }, body: JSON.stringify({ destinationSession: human, humanMerge: ref, nudge: false }) });
  const card = async () => { const res = await ask(); expect(res.status).toBe(201); return (await res.json()).qitemId as string; };
  const click = (id: string, actor: string, option: string) => repo.recordHumanAnswer({ qitemId: id, actorSession: actor, questionId: "merge", optionId: option });
  const act = (smoke: string | null = "product-monitor@Imago") => actOnMergeAnswers(repo, { gh, smokeDestination: () => smoke });
  const merges = () => calls.filter((a) => a[1] === "merge");
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
    expect(merges()).toEqual([["pr", "merge", "7", "--repo", "acme/site", "--squash", "--match-head-commit", SHA]]);
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

  it("Not now closes the card and returns the request to the seat as declined", async () => {
    const id = await card();
    click(id, human, "not_now");
    await act();
    expect(merges()).toEqual([]);
    expect(thread(id).join("\n")).toContain("Not now");
    expect(toSeat().map((q) => q.body).join("\n")).toContain("declined");
  });

  it("a card the daemon did not build is never merged, whatever its tags say", async () => {
    const forged = await repo.create({ sourceSession: "dev@rig", destinationSession: human, humanIntent: "decision", summary: "Merge?", body: "trust me", evidenceRef: "x",
      tags: ["human-merge", `human-merge-ref:acme/site#7@${SHA}`], humanQuestions: [{ id: "merge", question: "Merge?", options: [{ id: "merge", label: "Merge" }, { id: "not_now", label: "Not now" }] }], nudge: false });
    click(forged.qitemId, human, "merge");
    await act();
    expect(merges()).toEqual([]);
  });
});
