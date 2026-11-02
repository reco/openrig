import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { InboundRouter, readableSlackText, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";
import { lookupUserName } from "../src/domain/gateway/slack/slack-api.js";

it("turns Slack mrkdwn tokens into plain readable text", () => {
  const names = new Map([["U0AVB6WR230", "Reco"]]);
  expect(readableSlackText("hey <@U0AVB6WR230> and <@U0OTHER|sam>, also <@U0GONE>", names)).toBe("hey @Reco and @sam, also @U0GONE");
  expect(readableSlackText("see <#C0C76TB8R2M|psa> and <#C0NONAME>", names)).toBe("see #psa and #C0NONAME");
  expect(readableSlackText("docs <https://example.com/a?b=1&amp;c=2|the guide> or <https://x.dev>", names))
    .toBe("docs the guide (https://example.com/a?b=1&c=2) or https://x.dev");
  expect(readableSlackText("mail <mailto:a@b.co|a@b.co>, <!here> <!subteam^S01|@devs>", names)).toBe("mail a@b.co, @here @devs");
  expect(readableSlackText("1 &lt; 2 &amp;&amp; 3 &gt; 2", names)).toBe("1 < 2 && 3 > 2");
});

it("stores a person's message with mentions resolved to names, looking each user up once and falling back to the id", async () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-slack-readable-"));
  const db = createDb(join(home, "state.sqlite"));
  migrate(db, ALL_MIGRATIONS);
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  const lookups: string[] = [];
  const router = new InboundRouter({
    queue: makeQueuePorts(repo), seen: new SeenStore(join(home, "seen.jsonl")), deadLetter: new DeadLetterStore<SlackEvent>(join(home, "dead.jsonl")),
    destination: "operator-agent@kernel",
    resolveSender: () => ({ admitted: true, source: "human-fixture@external" }),
    userName: async (id) => { lookups.push(id); return id === "U0AVB6WR230" ? "Reco" : null; },
  });
  try {
    const text = "<@U0AVB6WR230> please ping <@U0AVB6WR230> and <@U0FAIL> in <#C0C76TB8R2M|psa>";
    const result = await router.route({ type: "message", user: "U-FIXTURE", channel: "C-FIXTURE", text, ts: "1000.1" });
    expect(result.disposition).toBe("accepted");
    const row = repo.getById(result.qitemId!)!;
    expect(row.body.startsWith("@Reco please ping @Reco and @U0FAIL in #psa\n\n---\nSource: slack")).toBe(true);
    expect(row.summary).toBe("human-fixture@external via Slack: @Reco please ping @Reco and @U0FAIL in #psa");
    expect(lookups.sort()).toEqual(["U0AVB6WR230", "U0FAIL"]);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("names a user by display name, then real name, then handle, and null when users.info fails", async () => {
  const reply = (body: object) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  expect(await lookupUserName("xoxb-test", "U1", reply({ ok: true, user: { name: "reco", profile: { display_name: "Reco", real_name: "R H" } } }))).toBe("Reco");
  expect(await lookupUserName("xoxb-test", "U1", reply({ ok: true, user: { name: "reco", profile: { display_name: "", real_name: "R H" } } }))).toBe("R H");
  expect(await lookupUserName("xoxb-test", "U1", reply({ ok: true, user: { name: "reco", profile: {} } }))).toBe("reco");
  expect(await lookupUserName("xoxb-test", "U1", reply({ ok: false, error: "user_not_found" }))).toBeNull();
});
