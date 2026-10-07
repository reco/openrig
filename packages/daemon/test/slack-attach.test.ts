// --attach: a seat's files ride its Slack post, uploaded into that post's thread and channel.
// Hermetic: a fake Slack at the fetch boundary, real files on disk for the default reader.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { SeenStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

function memFs(): StateFsOps {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p)!; },
    appendFileSync: (p, d) => files.set(p, (files.get(p) ?? "") + d),
    writeFileSync: (p, d) => files.set(p, d),
    rename: (a, b) => { files.set(b, files.get(a) ?? ""); files.delete(a); },
    mkdirp: () => {},
  };
}

describe("--attach uploads", () => {
  let dir: string;
  let calls: { url: string; body: string }[];
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "attach-"))); calls = []; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, body: init?.body instanceof Uint8Array ? "<bytes>" : String(init?.body ?? "") });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("files.getUploadURLExternal")) return json({ ok: true, upload_url: "https://files.slack.invalid/put", file_id: `F${calls.length}` });
    if (url === "https://files.slack.invalid/put") return new Response("ok", { status: 200 });
    return json({ ok: true, ts: "9000.1" });
  };
  const deliver = (payload: Record<string, unknown>) => {
    const fsx = memFs();
    const clock = () => new Date("2026-10-07T00:00:00.000Z");
    return subsystemSlackDeliver({
      botToken: "xoxb-EXAMPLE-fake", channel: "C-MAIN", sourceLabel: "vm", fetchImpl,
      delivered: new SeenStore("/del.jsonl", fsx, clock), attempted: new SeenStore("/att.jsonl", fsx, clock),
      outboundSeen: new SeenStore("/seen.jsonl", fsx, clock),
      resolveThreadTs: () => "4242.1",
      resolveChannel: () => "C-PSA",
      log: () => {},
    })({ kind: "outbound_decision", decisionId: `d-${Math.random()}`, op: "post_message", entityBindingRef: "lee#slack",
      payload: { qitemId: "q-1", summary: "Header", body: "New header", destinationSession: "reco@external", ...payload } });
  };
  const completes = () => calls.filter((c) => c.url.endsWith("files.completeUploadExternal")).map((c) => c.body);

  it("uploads each attached file into the post's thread and channel", async () => {
    writeFileSync(join(dir, "before.png"), "png");
    writeFileSync(join(dir, "after.pdf"), "pdf");
    const out = await deliver({ sourceSession: "psa-dev@psa", tags: [`attachment:${join(dir, "before.png")}`, `attachment:${join(dir, "after.pdf")}`] });
    expect(out.ok).toBe(true);
    expect(completes()).toHaveLength(2);
    for (const body of completes()) {
      expect(body).toContain("C-PSA");
      expect(body).toContain("4242.1");
    }
    expect(completes().join()).toContain("before.png");
    expect(completes().join()).toContain("after.pdf");
  });

  it("uploads a file once when the post has a supplemental reply", async () => {
    writeFileSync(join(dir, "shot.png"), "png");
    await deliver({ sourceSession: "psa-dev@psa", humanDetail: "More detail.", tags: [`attachment:${join(dir, "shot.png")}`] });
    expect(completes()).toHaveLength(1);
  });

  it("never follows a symlink, uploads no video by tag, and never uploads from a human's row", async () => {
    writeFileSync(join(dir, "real.png"), "png");
    writeFileSync(join(dir, "clip.mov"), "mov");
    symlinkSync(join(dir, "real.png"), join(dir, "link.png"));
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "inner.png"), "png");
    symlinkSync(join(dir, "real"), join(dir, "via"));
    await deliver({ sourceSession: "psa-dev@psa", tags: [`attachment:${join(dir, "link.png")}`, `attachment:${join(dir, "via", "inner.png")}`, `attachment:${join(dir, "clip.mov")}`] });
    await deliver({ sourceSession: "lee@external", tags: [`attachment:${join(dir, "real.png")}`] });
    expect(completes()).toHaveLength(0);
  });
});

describe("--attach rides only the row's own first post", () => {
  it("a park or later notice of the row carries no attachment", async () => {
    const { createDb } = await import("../src/db/connection.js");
    const { migrate } = await import("../src/db/migrate.js");
    const { ALL_MIGRATIONS } = await import("../src/db/all-migrations.js");
    const { EventBus } = await import("../src/domain/event-bus.js");
    const { QueueRepository } = await import("../src/domain/queue-repository.js");
    const { makeQueuePorts } = await import("../src/domain/gateway/slack/queue-access.js");
    const human = { entityId: "reco", class: "human" as const, displayName: "Reco", address: "reco@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:X", role: "primary" as const, handle: "U1" }], prefs: { deliveryClass: "A" as const } };
    const registry = { ok: true as const, entities: [human] };
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    const repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    const alertsFor = async (id: string) => (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === id);
    const direct = await repo.create({ sourceSession: "psa-dev@psa", destinationSession: "reco@external", humanIntent: "update", summary: "Shot", body: "see", tags: ["attachment:/x/a.png"], nudge: false });
    expect((await alertsFor(direct.qitemId))?.tags).toContain("attachment:/x/a.png");
    const work = await repo.create({ sourceSession: "other@rig", destinationSession: "psa-dev@psa", body: "w", tags: ["attachment:/x/b.png"], nudge: false });
    repo.update({ qitemId: work.qitemId, actorSession: "psa-dev@psa", state: "blocked", blockedOn: "human-reco@kernel", summary: "Merge?", evidenceRef: "/x/p.md", transitionNote: "parked" });
    expect((await alertsFor(work.qitemId))?.tags ?? []).not.toContain("attachment:/x/b.png");
    db.close();
  });
});
