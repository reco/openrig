// Slack approvals for permission prompts: opt-in seats only, the full command (credentials
// masked), one-shot, only the addressed human answers, nothing on timeout.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeApprovalService } from "../src/domain/approvals.js";

const require = createRequire(import.meta.url);
const hook = require("../assets/plugins/openrig-core/hooks/scripts/approval-request.cjs") as { decisionOutput: (d: unknown) => string | null };
const person = (entityId: string, handle: string) => ({ entityId, class: "human" as const, displayName: entityId, address: `${entityId}@external`, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:X", role: "primary" as const, handle }], prefs: { deliveryClass: "A" as const } });
const registry = { ok: true as const, entities: [person("reco", "U1"), { ...person("lee", "U2"), role: "requester" as const }] };

describe("Slack approvals", () => {
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry }); });
  afterEach(() => db.close());
  const service = (timeoutMs = 2000) => makeApprovalService({ queueRepo: repo, optedIn: () => ["psa-dev@psa"], approver: () => "reco@external", timeoutMs, pollMs: 10 });
  const pending = () => repo.list({ limit: 50 }).find((q) => q.tags?.includes("approval-request"))!;
  const answer = async (actor: string, option: string) => {
    for (let i = 0; i < 100 && !repo.list({ limit: 50 }).some((q) => q.tags?.includes("approval-request")); i++) await new Promise((r) => setTimeout(r, 5));
    return repo.recordHumanAnswer({ qitemId: pending().qitemId, actorSession: actor, questionId: "approval", optionId: option });
  };

  it("asks the approver with the full command, credentials masked, and returns their Approve", async () => {
    const command = "API_TOKEN=s3cr3t-value-123 npm run deploy -- --target staging --verbose";
    const request = service().request({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command } });
    expect(await answer("lee@external", "allow")).toMatchObject({ status: "not-applicable" });
    expect(await answer("reco@external", "allow")).toMatchObject({ status: "recorded" });
    expect(await request).toBe("allow");
    const row = pending();
    expect(row.destinationSession).toBe("reco@external");
    expect(row.body).toContain("npm run deploy -- --target staging --verbose");
    expect(row.body).not.toContain("s3cr3t-value-123");
    expect(repo.transitionLog.listForQitem(row.qitemId).some((t) => t.transitionNote === "approval allow by reco@external for Bash")).toBe(true);
  });

  it("returns Deny, and nothing for a seat that did not opt in", async () => {
    const request = service().request({ sessionName: "psa-dev@psa", toolName: "Write", toolInput: { file_path: "/a.ts", content: "x" } });
    await answer("reco@external", "deny");
    expect(await request).toBe("deny");
    expect(await service().request({ sessionName: "other@rig", toolName: "Bash", toolInput: { command: "ls" } })).toBeNull();
  });

  it("expires with nothing decided: the row is canceled and a later click does nothing", async () => {
    expect(await service(50).request({ sessionName: "psa-dev@psa", toolName: "Bash", toolInput: { command: "rm -rf build" } })).toBeNull();
    expect(pending().state).toBe("canceled");
    expect(repo.recordHumanAnswer({ qitemId: pending().qitemId, actorSession: "reco@external", questionId: "approval", optionId: "allow" })).toMatchObject({ status: "not-applicable" });
  });

  it("the hook prints the runtime's PermissionRequest decision, and nothing without one", () => {
    expect(JSON.parse(hook.decisionOutput("allow")!)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(JSON.parse(hook.decisionOutput("deny")!).hookSpecificOutput.decision.behavior).toBe("deny");
    expect(hook.decisionOutput(null)).toBeNull();
  });
});
