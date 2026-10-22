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

const human = "lee@external";
const registryWith = (prefs: Record<string, unknown>) => ({
  ok: true as const,
  entities: [{ entityId: "lee", class: "human" as const, displayName: "Lee", address: human, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "ULEE" }], prefs: { deliveryClass: "B" as const, ...prefs } }],
});
const update = { sourceSession: "psa-dev@psa", destinationSession: human, humanIntent: "update" as const, summary: "Projects without write-ups", nudge: false };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const surfaces = (post: Record<string, unknown> | undefined) => `${String(post?.text ?? "")}\n${JSON.stringify(post?.blocks ?? [])}`;
const count = (text: string, form: string) => text.split(form).length - 1;

describe("an update that asks to mention its human", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let posts: Array<Record<string, unknown>>;
  let wire: ReturnType<typeof buildSlackGatewayWire> | undefined;

  const start = (prefs: Record<string, unknown> = {}) => {
    const registry = registryWith(prefs);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    wire = buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, fetchImpl: async (_url, init) => { posts.push(JSON.parse(String(init?.body))); return reply({ ok: true, ts: `${posts.length}.1` }); } });
    wire.startServices?.();
  };
  const post = async (fields: { body: string; tags?: string[] }) => {
    const row = await repo.create({ ...update, ...fields });
    await vi.waitFor(() => expect(repo.getById(row.qitemId)?.deliveryOutcome).toBe("posted"));
    return surfaces(posts.at(-1));
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "update-mention-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    const secrets = join(home, "fake.env"); writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets }, home);
    posts = [];
  });
  afterEach(() => { wire?.stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  it("mentions the registered human once, without the escalation siren", async () => {
    start();
    const posted = await post({ body: "28 of the 60 projects have no write-up.", tags: ["mention"] });
    expect(count(posted, "<@ULEE>")).toBe(2);
    expect(posted).not.toContain("rotating_light");
  });

  it("keeps an update without the tag quiet", async () => {
    start();
    expect(await post({ body: "28 of the 60 projects have no write-up." })).not.toContain("<@ULEE>");
  });

  it("keeps mention syntax in the body inert", async () => {
    start();
    const posted = await post({ body: "<@UOTHER> <!channel> <@ULEE> please check.", tags: ["mention"] });
    expect(count(posted, "<@ULEE>")).toBe(2);
    expect(posted).not.toContain("<@UOTHER>");
    expect(posted).not.toContain("<!channel>");
    expect(posted).toContain("&lt;@UOTHER&gt;");
  });

  it.each(["focus", "away", "off"])("does not mention a human whose availability is %s", async (availability) => {
    start({ availability });
    expect(await post({ body: "28 of the 60 projects have no write-up.", tags: ["mention"] })).not.toContain("<@ULEE>");
  });
});
