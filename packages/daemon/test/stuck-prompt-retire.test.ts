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
import { makeApprovalService } from "../src/domain/approvals.js";
import { hasRecentPromptCard, promptCardBody, promptCardDetail, rekeyPromptNotices, retireStalePromptNotices, supersedePromptNotices } from "../src/domain/stuck-prompt-watch.js";

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
  let threadDelayMs = 0;
  let failThreadPosts = 0;
  let failUpdates = 0;

  beforeEach(() => {
    threadDelayMs = 0; failThreadPosts = 0; failUpdates = 0;
    home = mkdtempSync(join(tmpdir(), "prompt-retire-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env"); writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-MAIN", secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE" }, home);
    posts = []; updates = [];
    const wire = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, requestSweepIntervalMs: 50,
      fetchImpl: async (url, init) => {
        if (url.endsWith("chat.update")) {
          if (failUpdates > 0) { failUpdates--; return reply({ ok: false, error: "ratelimited" }); }
          updates.push(JSON.parse(String(init?.body))); return reply({ ok: true });
        }
        if (url.endsWith("chat.postMessage")) {
          const body = JSON.parse(String(init?.body));
          if (body.thread_ts && failThreadPosts > 0) { failThreadPosts--; return reply({ ok: false, error: "channel_not_found" }); }
          if (body.thread_ts && threadDelayMs) await new Promise((r) => setTimeout(r, threadDelayMs));
          posts.push(body); return reply({ ok: true, ts: `${posts.length}.1` });
        }
        return reply({ ok: true });
      },
    });
    stops.push(() => wire.stop()); wire.startServices?.();
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  async function postedCard(session: string, key: string, extraTags: string[] = []) {
    const row = await repo.create({
      tags: ["stuck-prompt", `stuck-prompt:${key}`, `stuck-prompt-session:${session}`, `stuck-prompt-key:${key}`, "stuck-prompt-allow:1", "stuck-prompt-deny:3", ...extraTags],
      sourceSession: session, destinationSession: "reco@external", humanIntent: "decision", summary: `${session} is waiting at a permission prompt`,
      body: `\`\`\`\nrm -rf build ${key}\n\`\`\`\n\nApprove selects "Yes" in the terminal. Waiting for 5 minutes. Attach: \`tmux attach -t ${session}\``, humanQuestions: [{ id: "answer", question: `Answer ${session}'s prompt?`, options: [{ id: "allow", label: "Approve" }, { id: "deny", label: "Deny" }] }], nudge: false,
    });
    await vi.waitFor(() => expect(posts.some((p) => String(p.text).includes(`rm -rf build ${key}`))).toBe(true));
    return { id: row.qitemId, ts: `${posts.findIndex((p) => String(p.text).includes(`rm -rf build ${key}`)) + 1}.1` };
  }
  const actionable = (message: Record<string, unknown>) => JSON.stringify(message.blocks).includes('"type":"actions"');
  const closedWith = async (ts: string, line: string) =>
    vi.waitFor(() => expect(updates.some((u) => u.ts === ts && !actionable(u) && String(u.text).includes(line))).toBe(true));

  const compactRoot = (ts: string, title: string) =>
    vi.waitFor(() => expect(updates.find((u) => u.ts === ts)).toMatchObject({
      text: `Resolved in Terminal · ${title}`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `*Resolved in Terminal · ${title}*` } }],
    }));
  const threadPosts = (ts: string) => posts.filter((p) => p.thread_ts === ts).map((p) => String(p.text));

  it("a card whose prompt is gone or changed becomes one bold line; its details go in one thread reply; the card in view stays", async () => {
    const gone = await postedCard("cfo@finance", "k1", ["prompt-title:Check GitHub Actions status"]);
    const changed = await postedCard("ops@rig", "k2");
    const current = await postedCard("dev@rig", "k3");
    expect(retireStalePromptNotices(repo, ["cfo@finance", "ops@rig", "dev@rig"], new Map([["cfo@finance", null], ["ops@rig", "k9"], ["dev@rig", "k3"]])).sort()).toEqual([gone.id, changed.id].sort());
    await compactRoot(gone.ts, "Check GitHub Actions status");
    await compactRoot(changed.ts, "ops@rig's prompt");
    const [receipt, ...more] = threadPosts(gone.ts);
    expect(more).toEqual([]);
    expect(receipt).toContain("`cfo@finance`");
    expect(receipt).toContain("answered in the terminal");
    expect(receipt).toContain("not known here");
    expect(receipt).toContain("*Why:* Check GitHub Actions status");
    expect(receipt).toContain("```\nrm -rf build k1\n```");
    expect(receipt).toContain("No rule was saved from Slack.");
    expect(receipt).not.toContain("Closed:");
    expect(receipt).not.toContain("tmux attach");
    expect(threadPosts(changed.ts)).toHaveLength(1);
    expect(threadPosts(changed.ts)[0]).not.toContain("*Why:*");
    expect(repo.transitionLog.listForQitem(gone.id).some((t) => t.transitionNote === "request-closed reason=prompt-cleared: answered in the terminal")).toBe(true);
    expect(repo.getById(current.id)?.state).toBe("pending");
    expect(updates.some((u) => u.ts === current.ts)).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(threadPosts(gone.ts)).toHaveLength(1);
    expect(updates.filter((u) => u.ts === gone.ts)).toHaveLength(1);
  });

  it("a compact rewrite that failed is retried as the same bold line, never as a second receipt", async () => {
    const card = await postedCard("cfo@finance", "k1", ["prompt-title:Check GitHub Actions status"]);
    failUpdates = 1;
    retireStalePromptNotices(repo, ["cfo@finance"], new Map([["cfo@finance", null]]));
    await vi.waitFor(() => expect(repo.transitionLog.listForQitem(card.id).some((t) => t.transitionNote?.startsWith("slack-card-close-failed"))).toBe(true));
    await compactRoot(card.ts, "Check GitHub Actions status");
    await new Promise((r) => setTimeout(r, 200));
    expect(threadPosts(card.ts)).toHaveLength(1);
  });

  it("a card answered from Slack before its retirement is never shown as resolved in the terminal", async () => {
    const card = await postedCard("cfo@finance", "k1", ["prompt-title:Check GitHub Actions status"]);
    repo.recordHumanAnswer({ qitemId: card.id, actorSession: "reco@external", questionId: "answer", optionId: "allow" });
    retireStalePromptNotices(repo, ["cfo@finance"], new Map([["cfo@finance", null]]));
    await vi.waitFor(() => expect(updates.some((u) => u.ts === card.ts && !actionable(u))).toBe(true));
    expect(updates.some((u) => String(u.text).includes("Resolved in Terminal"))).toBe(false);
    expect(threadPosts(card.ts).some((t) => t.includes("No rule was saved from Slack"))).toBe(false);
  });

  it("when the details reply cannot be posted the card keeps its details and closes the plain way", async () => {
    const card = await postedCard("cfo@finance", "k1", ["prompt-title:Check GitHub Actions status"]);
    failThreadPosts = 1;
    retireStalePromptNotices(repo, ["cfo@finance"], new Map([["cfo@finance", null]]));
    await closedWith(card.ts, "Closed: answered in the terminal.");
    const root = updates.find((u) => u.ts === card.ts)!;
    expect(String(root.text)).toContain("rm -rf build k1");
    expect(String(root.text)).not.toContain("Resolved in Terminal");
  });

  it("a card for a seat that no longer runs closes saying so, not as answered; an unreadable seat's card is kept", async () => {
    const replaced = await postedCard("cfo@finance", "k1");
    const unread = await postedCard("dev@rig", "k3");
    expect(retireStalePromptNotices(repo, ["dev@rig"], new Map())).toEqual([replaced.id]);
    await closedWith(replaced.ts, "Closed: the seat stopped running.");
    expect(updates.some((u) => String(u.text).includes("Resolved in Terminal"))).toBe(false);
    expect(repo.getById(unread.id)?.state).toBe("pending");
  });

  it("a long dialog's card keeps its buttons and its thread carries the whole dialog in order", async () => {
    const dialog = Array.from({ length: 300 }, (_, i) => `echo line ${String(i).padStart(3, "0")} of the generated script`).join("\n");
    const card = { session: "cfo@finance", reason: "permission_prompt", promptLine: "Do you want to proceed?", attach: "tmux attach -t cfo@finance", waitingMinutes: 0, episodeId: "e1", since: 0, key: "k9", dialog,
      choices: { allow: { key: "1", label: "Yes" }, deny: { key: "3", label: "No" } } };
    await repo.create({ tags: ["stuck-prompt", "stuck-prompt:k9", "stuck-prompt-session:cfo@finance", "stuck-prompt-key:k9", "stuck-prompt-allow:1", "stuck-prompt-deny:3"],
      sourceSession: "cfo@finance", destinationSession: "reco@external", humanIntent: "decision", summary: "cfo@finance is waiting at a permission prompt",
      body: promptCardBody(card), humanDetail: promptCardDetail(card),
      humanQuestions: [{ id: "answer", question: "Answer cfo@finance's prompt?", options: [{ id: "allow", label: "Approve" }, { id: "deny", label: "Deny" }] }], nudge: false });
    await vi.waitFor(() => expect(posts.filter((p) => p.thread_ts).length).toBeGreaterThan(1));
    const primary = posts.find((p) => String(p.text).includes("Full dialog in this card's thread."))!;
    expect(actionable(primary)).toBe(true);
    const thread = posts.filter((p) => p.thread_ts).map((p) => String(p.text)).join("\n");
    const order = Array.from({ length: 300 }, (_, i) => thread.indexOf(`echo line ${String(i).padStart(3, "0")} of`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order.every((at, i) => i === 0 || at > order[i - 1]!)).toBe(true);
  });

  it("a split approval card's click, resolved the way Slack resolves it, returns the answer once its thread is posted", async () => {
    const service = makeApprovalService({ queueRepo: repo, optedIn: () => ["cfo@finance"], approver: () => "reco@external", verifySeat: () => true, pollMs: 10 });
    const command = Array.from({ length: 200 }, (_, i) => `echo step ${i} of the generated migration`).join("\n");
    const id = (await service.start({ sessionName: "cfo@finance", toolName: "Bash", toolInput: { command } }))!;
    expect(repo.getById(id)!.humanDetail).toContain("echo step 100 of");
    await vi.waitFor(() => expect(repo.getById(id)!.deliveryOutcome).toBe("posted"));
    expect(posts.filter((p) => p.thread_ts).length).toBeGreaterThan(0);
    repo.recordHumanAnswer({ qitemId: id, actorSession: "reco@external", questionId: "approval", optionId: "allow" });
    repo.resolveDirectHumanReply({ qitemId: id, actorSession: "reco@external", decision: "allow" });
    expect(await service.wait(id, "cfo@finance", 50)).toBe("allow");
  });

  it("a split approval card answered before its thread finished posting keeps the answer", async () => {
    const service = makeApprovalService({ queueRepo: repo, optedIn: () => ["cfo@finance"], approver: () => "reco@external", verifySeat: () => true, pollMs: 10 });
    const command = Array.from({ length: 200 }, (_, i) => `echo step ${i} of the generated migration`).join("\n");
    threadDelayMs = 100;
    const id = (await service.start({ sessionName: "cfo@finance", toolName: "Bash", toolInput: { command } }))!;
    await vi.waitFor(() => expect(posts.some((p) => String(p.text).includes("Full Bash input in this card's thread."))).toBe(true));
    expect(repo.getById(id)!.deliveryOutcome).not.toBe("posted");
    repo.recordHumanAnswer({ qitemId: id, actorSession: "reco@external", questionId: "approval", optionId: "allow" });
    repo.resolveDirectHumanReply({ qitemId: id, actorSession: "reco@external", decision: "allow" });
    expect(await service.wait(id, "cfo@finance", 3000)).toBe("allow");
  });

  it("a card re-keyed because more requests queued behind its prompt stays open with its buttons; another prompt still retires it", async () => {
    const card = await postedCard("advisor-lead@kernel", "k-one-of-two");
    expect(rekeyPromptNotices(repo, "advisor-lead@kernel", "k-one-of-two", "k-one-of-three")).toEqual([card.id]);
    expect(repo.getById(card.id)!.tags).toContain("stuck-prompt-key:k-one-of-three");
    expect(retireStalePromptNotices(repo, ["advisor-lead@kernel"], new Map([["advisor-lead@kernel", "k-one-of-three"]]))).toEqual([]);
    expect(hasRecentPromptCard(repo, { session: "advisor-lead@kernel", key: "k-one-of-three" })).toBe(true);
    expect(retireStalePromptNotices(repo, ["advisor-lead@kernel"], new Map([["advisor-lead@kernel", "k-other"]]))).toEqual([card.id]);
    await vi.waitFor(() => expect(updates.some((u) => u.ts === card.ts && !actionable(u))).toBe(true));
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
