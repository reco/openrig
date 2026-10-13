// One permission story: the human's approval-rules.json is the single source. It is seeded with OpenRig's
// defaults when absent, projected into each Claude seat's allow/deny and into Codex's own rules file, MCP exec
// calls match by name, and an Always approve / Always deny click saves the rule the card showed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeApprovalService } from "../src/domain/approvals.js";
import { actOnPromptAnswers, promptCommand, readPrompt } from "../src/domain/stuck-prompt-watch.js";
import {
  DEFAULT_APPROVAL_RULES, alwaysRuleFor, claudePermissionRules, codexRulesText, projectCodexRules, readApprovalRules,
  ruleDecision, saveAlwaysRule, seedApprovalRules, type ApprovalRule,
} from "../src/domain/approval-rules.js";

const registry = { ok: true as const, entities: [{ entityId: "reco", class: "human" as const, displayName: "reco", address: "reco@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:X", role: "primary" as const, handle: "U1" }], prefs: { deliveryClass: "A" as const } }] };
const bash = (command: string, sessionName = "dev@rig") => ({ sessionName, toolName: "Bash", toolInput: { command } });

describe("one permission story", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "permission-story-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("seeds the default rules only into a home without a rules file", () => {
    expect(seedApprovalRules(home)).toBe(true);
    expect(readApprovalRules(home)).toEqual(DEFAULT_APPROVAL_RULES);
    writeFileSync(join(home, "approval-rules.json"), JSON.stringify({ rules: [{ effect: "allow", match: "Bash(ps *)" }] }));
    expect(seedApprovalRules(home)).toBe(false);
    expect(readApprovalRules(home)).toEqual([{ effect: "allow", match: "Bash(ps *)" }]);
  });

  it("the defaults allow read-only inspection, git reads, tests and rig, and deny driving another seat's prompt", () => {
    const rules = DEFAULT_APPROVAL_RULES;
    for (const command of ["ls -la src", "cat package.json", "jq .name package.json", "sqlite3 -readonly -safe db.sqlite 'select 1'", "git log --oneline", "npx vitest run x", "rig ps --nodes"]) {
      expect(ruleDecision(rules, bash(command))?.effect, command).toBe("allow");
    }
    for (const command of ["rig send x@y hi --dangerously-interact --reason r", "git push --force origin x", "git -c core.pager=sh log", "rm -rf ~"]) {
      expect(ruleDecision(rules, bash(command))?.effect, command).toBe("deny");
    }
    expect(ruleDecision(rules, bash("sqlite3 db.sqlite 'drop table x'"))).toBeNull();
  });

  it("projects each seat's allow and deny into Claude's syntax, honouring seats", () => {
    const rules: ApprovalRule[] = [{ effect: "allow", match: "Bash(git status *)" }, { effect: "allow", match: "Bash(bash /x/sweep.sh *)", seats: "cfo@finance" },
      { effect: "deny", match: "Edit(/etc/**)" }, { effect: "allow", match: "mcp__exa__*" }, { effect: "allow", match: "mcp__posthog__exec(call *-get *)" }];
    expect(claudePermissionRules(rules, "dev@rig")).toEqual({ allow: ["Bash(git status *)", "mcp__exa__*"], deny: ["Edit(//etc/**)"] });
    expect(claudePermissionRules(rules, "cfo@finance").allow).toContain("Bash(bash /x/sweep.sh *)");
  });

  it("writes Codex's own rules file from the rules every seat shares, literal prefixes only, and nothing else", () => {
    const rules: ApprovalRule[] = [{ effect: "allow", match: "Bash(git status *)" }, { effect: "deny", match: "Bash(git push * main)" },
      { effect: "deny", match: "Bash(rig send *--dangerously-interact*)", note: "no prompt driving" }, { effect: "deny", match: "Bash(rm -rf /)", note: "never" },
      { effect: "allow", match: "Bash(ps *)", seats: "cfo@finance" }, { effect: "allow", match: "Read" }];
    const text = codexRulesText(rules);
    expect(text).toContain(`prefix_rule(pattern=["git","status"], decision="allow")`);
    expect(text).toContain(`prefix_rule(pattern=["rm","-rf","/"], decision="forbidden", justification="never")`);
    expect(text).not.toContain("push");
    expect(text).not.toContain("dangerously");
    expect(text).not.toContain(`"ps"`);
    const codexHome = join(home, "codex");
    mkdirSync(join(codexHome, "rules"), { recursive: true });
    writeFileSync(join(codexHome, "rules", "default.rules"), "user rules\n");
    writeFileSync(join(home, "approval-rules.json"), JSON.stringify({ rules }));
    projectCodexRules(home, codexHome);
    expect(readFileSync(join(codexHome, "rules", "openrig.rules"), "utf8")).toBe(text);
    expect(readFileSync(join(codexHome, "rules", "default.rules"), "utf8")).toBe("user rules\n");
  });

  it("matches an MCP exec call by its name; its JSON arguments are data", () => {
    const rules: ApprovalRule[] = [{ effect: "allow", match: "mcp__plugin_posthog_posthog__exec(call *-get *)" }, { effect: "deny", match: "mcp__plugin_posthog_posthog__exec(call *-delete *)" }];
    const call = (command: string) => ({ sessionName: "dev@rig", toolName: "mcp__plugin_posthog_posthog__exec", toolInput: { command } });
    expect(ruleDecision(rules, call(`call feature-flag-get {"id": 7, "note": "a && b; $(x)"}`))?.effect).toBe("allow");
    expect(ruleDecision(rules, call(`call insight-delete {"id": 7}`))?.effect).toBe("deny");
    expect(ruleDecision(rules, call(`call insight-update {"note": "-get "}`))).toBeNull();
    expect(ruleDecision(rules, call("search docs"))).toBeNull();
  });

  it("derives the Always rule from a single plain command's fixed start, and none from anything else", () => {
    expect(alwaysRuleFor("Bash", { command: "bash /path/sweep.sh --since 2h" })).toBe("Bash(bash /path/sweep.sh *)");
    expect(alwaysRuleFor("Bash", { command: "git status --short" })).toBe("Bash(git status *)");
    expect(alwaysRuleFor("Bash", { command: "ls -la src" })).toBe("Bash(ls *)");
    for (const command of ["ls && rm x", "echo $(id)", "cat <<EOF\nx\nEOF", "./run.sh", "FOO=1 make", "cd /tmp"]) expect(alwaysRuleFor("Bash", { command }), command).toBeNull();
    expect(alwaysRuleFor("Edit", { file_path: "/x" })).toBeNull();
  });

  it("saves an Always rule once, scoped to its seat, keeping every other rule", () => {
    seedApprovalRules(home);
    const rule = { effect: "allow" as const, match: "Bash(bash /x/sweep.sh *)", seats: "cfo@finance", note: "saved" };
    saveAlwaysRule(home, rule);
    saveAlwaysRule(home, rule);
    const rules = readApprovalRules(home);
    expect(rules.filter((r) => r.match === rule.match)).toEqual([rule]);
    expect(rules.length).toBe(DEFAULT_APPROVAL_RULES.length + 1);
  });

  describe("Always approve / Always deny on cards", () => {
    let db: ReturnType<typeof createDb>;
    let repo: QueueRepository;
    beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry }); });
    afterEach(() => db.close());

    it("an approval card offers them for a plain command, shows the rule, and each click saves it for the asking seat", async () => {
      const saved: ApprovalRule[] = [];
      const s = makeApprovalService({ queueRepo: repo, optedIn: () => ["cfo@finance"], approver: () => "reco@external", verifySeat: () => true, pollMs: 10, saveRule: (r) => saved.push(r) });
      for (const [option, effect] of [["always_allow", "allow"], ["always_deny", "deny"]] as const) {
        const id = (await s.start({ sessionName: "cfo@finance", toolName: "Bash", toolInput: { command: "bash /path/sweep.sh --since 2h" } }))!;
        const row = repo.getById(id)!;
        expect(row.humanQuestions?.[0]!.options.map((o) => o.label)).toEqual(["Approve", "Deny", "Always approve", "Always deny"]);
        expect(row.body).toContain("saves `Bash(bash /path/sweep.sh *)` for cfo@finance");
        repo.recordHumanAnswer({ qitemId: id, actorSession: "reco@external", questionId: "approval", optionId: option });
        expect(await s.wait(id, "cfo@finance", 50)).toBe(effect);
        expect(saved.at(-1)).toMatchObject({ effect, match: "Bash(bash /path/sweep.sh *)", seats: "cfo@finance" });
      }
      const plainOnly = (await s.start({ sessionName: "cfo@finance", toolName: "Bash", toolInput: { command: "ls && rm -rf x" } }))!;
      expect(repo.getById(plainOnly)!.humanQuestions?.[0]!.options.map((o) => o.label)).toEqual(["Approve", "Deny"]);
    });

    it("a stuck-prompt card's Always approve types the plain Yes and saves the rule it showed", async () => {
      const pane = ["─".repeat(80), " Bash command", "", " │ bash /path/sweep.sh --since 2h", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", ""].join("\n");
      const prompt = readPrompt(pane)!;
      expect(promptCommand(prompt.dialog)).toBe("bash /path/sweep.sh --since 2h");
      const card = await repo.create({ tags: ["stuck-prompt", "stuck-prompt:e", "stuck-prompt-session:cfo@finance", `stuck-prompt-key:${prompt.key}`, "stuck-prompt-allow:1", "stuck-prompt-deny:2", "stuck-prompt-since:0",
        "always-rule:Bash(bash /path/sweep.sh *)"], sourceSession: "cfo@finance", destinationSession: "reco@external", humanIntent: "decision", summary: "cfo@finance is waiting", body: "card",
        humanQuestions: [{ id: "answer", question: "Answer?", options: [{ id: "allow", label: "Approve" }, { id: "deny", label: "Deny" }, { id: "always_allow", label: "Always approve" }, { id: "always_deny", label: "Always deny" }] }], nudge: false });
      repo.recordHumanAnswer({ qitemId: card.qitemId, actorSession: "reco@external", questionId: "answer", optionId: "always_allow" });
      const keys: string[] = [];
      const saved: unknown[] = [];
      await actOnPromptAnswers(repo, { capture: async () => pane, inMode: async () => false, sendKey: async (_s, k) => { keys.push(k); }, saveRule: (r) => saved.push(r) });
      expect(keys).toEqual(["1"]);
      expect(saved).toEqual([expect.objectContaining({ effect: "allow", match: "Bash(bash /path/sweep.sh *)", seats: "cfo@finance" })]);
    });
  });

  it("a Codex resume brings Codex's rules file up to date before the session starts", async () => {
    const order: string[] = [];
    const tmux = { sendShellCommand: async () => { order.push("launch"); return { ok: true as const }; }, sendText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }),
      getPaneCommand: async () => "codex", capturePaneContent: async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything" } as unknown as import("../src/adapters/tmux.js").TmuxAdapter;
    await new CodexResumeAdapter(tmux, { projectRules: () => order.push("rules") }).resume("dev@rig", "codex_id", "thread-1", "/ws");
    expect(order.slice(0, 2)).toEqual(["rules", "launch"]);
  });
});
