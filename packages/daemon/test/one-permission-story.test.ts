// One permission story: the human's approval-rules.json is the single source. It is seeded with OpenRig's
// defaults when absent, projected into each Claude seat's allow/deny and into Codex's own rules file, MCP exec
// calls match by name, and an Always approve / Always deny click saves the rule the card showed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { TEAM_CLAUDE_ASK, operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { alwaysOffer, makeApprovalService } from "../src/domain/approvals.js";
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

  it("writes Codex's own rules file from the deny rules every seat shares (forbidden), literal prefixes only, and nothing else", () => {
    const rules: ApprovalRule[] = [{ effect: "allow", match: "Bash(git status *)" }, { effect: "deny", match: "Bash(git push * main)" },
      { effect: "deny", match: "Bash(rig send *--dangerously-interact*)", note: "no prompt driving" }, { effect: "deny", match: "Bash(rm -rf /)", note: "never" },
      { effect: "allow", match: "Bash(ps *)", seats: "cfo@finance" }, { effect: "allow", match: "Read" }];
    const text = codexRulesText(rules);
    expect(text).not.toContain(`decision="allow"`);
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

  it("derives the Always rule from a single plain command's fixed start, else the exact input; never one carrying a credential", () => {
    const wildcard = (command: string) => alwaysRuleFor("Bash", { command });
    expect(wildcard("bash /path/sweep.sh --since 2h")).toEqual({ match: "Bash(bash /path/sweep.sh *)", exact: false });
    expect(wildcard("git status --short")).toEqual({ match: "Bash(git status *)", exact: false });
    expect(wildcard("gh pr view 496")).toEqual({ match: "Bash(gh pr view *)", exact: false });
    expect(wildcard("gh pr view 496 --json state")).toEqual({ match: "Bash(gh pr view *)", exact: false });
    expect(wildcard("git log -5")).toEqual({ match: "Bash(git log *)", exact: false });
    expect(wildcard("bash /x.sh ts")).toEqual({ match: "Bash(bash /x.sh *)", exact: false });
    expect(wildcard("cat notes.md")).toEqual({ match: "Bash(cat notes.md *)", exact: false });
    expect(wildcard("gh api repos/o/r/pulls")).toEqual({ match: "Bash(gh api *)", exact: false });
    expect(wildcard("npm run build extra more")).toEqual({ match: "Bash(npm run build *)", exact: false });
    for (const command of ["kill 1234", "head -5 x", "rm build", "rmdir out", "kill node", "pkill node", "killall node", "mv a.txt b.txt",
      "chmod 600 key", "chown reco x.txt", "dd if=/dev/zero of=x", "timeout 30 pytest", "find . -name x", "env FOO=1 make", "sudo apt install x", "xargs rm",
      "ls -la src", "rm -rf build", "python3 -c 'x'", "git -C repo push origin x", "make", "ls && rm x", "echo $(id)", "cat <<EOF\nx\nEOF", "./run.sh", "FOO=1 make", "cd /tmp"]) {
      expect(wildcard(` ${command}\n`), command).toEqual({ match: `Bash(${command})`, exact: true });
    }
    expect(wildcard("curl https://deploy:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x/y")).toEqual({ refused: "it carries a credential" });
    expect(alwaysRuleFor("Edit", { file_path: "/x/./y" })).toEqual({ match: "Edit(/x/y)", exact: true });
    expect(alwaysRuleFor("Edit", { file_path: "/x/../y" })).toEqual({ refused: "its path climbs with \"..\"" });
    expect(alwaysRuleFor("WebFetch", { url: "https://example.com/a" })).toEqual({ match: "WebFetch(https://example.com/a)", exact: true });
  });

  it("an exact rule matches only that exact input, compound or destructive, and deny still wins", () => {
    const rules: ApprovalRule[] = [
      { effect: "allow", match: "Bash(ls && rm -rf build/*)", exact: true }, { effect: "allow", match: "Bash(git push origin main)", exact: true },
      { effect: "deny", match: "Bash(kill 1234)", exact: true }, { effect: "allow", match: "Bash(kill *)" }, ...DEFAULT_APPROVAL_RULES];
    expect(ruleDecision(rules, bash(" ls && rm -rf build/* "))?.effect).toBe("allow");
    for (const command of ["ls && rm -rf build/x", "ls && rm -rf build/* && rm -rf /", "ls &&  rm -rf build/*"]) expect(ruleDecision(rules, bash(command))?.effect, command).not.toBe("allow");
    expect(ruleDecision(rules, bash("git push origin main"))?.effect).toBe("deny");
    expect(ruleDecision(rules, bash("kill 1234"))?.effect).toBe("deny");
    expect(ruleDecision(rules, bash("kill 12345"))?.effect).toBe("allow");
    expect(ruleDecision(rules, bash("ls && rm -rf build/*", "other@rig"))?.effect).toBe("allow");
    expect(ruleDecision([{ ...rules[0]!, seats: "cfo@finance" }], bash("ls && rm -rf build/*", "other@rig"))).toBeNull();
    expect(ruleDecision([{ effect: "allow", match: "Edit(/y)", exact: true }], { sessionName: "dev@rig", toolName: "Edit", toolInput: { file_path: "/./y" } })?.effect).toBe("allow");
    expect(ruleDecision([{ effect: "allow", match: "Edit(/repo/y)", exact: true }], { sessionName: "dev@rig", toolName: "Edit", toolInput: { file_path: "/repo/link/../y" } })).toBeNull();
    expect(ruleDecision([{ effect: "deny", match: "Edit(/repo/y)", exact: true }], { sessionName: "dev@rig", toolName: "Edit", toolInput: { file_path: "/repo/link/../y" } })?.effect).toBe("deny");
    expect(ruleDecision([{ effect: "allow", match: "Edit(/y)", exact: true }], { sessionName: "dev@rig", toolName: "Edit", toolInput: { file_path: "/y/z" } })).toBeNull();
  });

  it("with git allowed, a deny sees through quoted operators, escapes, git's -C/-c spellings, -u and long-option prefixes", () => {
    const rules: ApprovalRule[] = [...DEFAULT_APPROVAL_RULES, { effect: "allow", match: "Bash(git *)" }];
    for (const command of ["git fetch 'a;b' --upload-pack=./evil origin", "git fetch \"a|b\" --upload-pack=./evil origin", "git fetch a\\;b --upload-pack=./evil origin",
      "git fetch --upload-pa=./evil origin", "git fetch --upl ./evil origin", "git clone -u ./evil r", "git clone -qu./evil r", "git ls-remote -u ./evil r",
      "git push --forc origin x", "git push origin x --fo", "git -C /repo push origin main", "git -ccore.pager=./evil log", "git -C /repo -c core.pager=x log",
      "git log --outp=x", "git diff --ext", "echo \"$(git push --force)\""])
      expect(ruleDecision(rules, bash(command))?.effect, command).toBe("deny");
    for (const command of ["git fetch --unshallow origin", "git add --update", "git push origin feature", "git log --oneline", "git fetch 'a;b' origin", "git clone r --depth 1"])
      expect(ruleDecision(rules, bash(command))?.effect, command).toBe("allow");
    const native = claudePermissionRules(rules, "dev@rig").deny;
    expect(native).toEqual(expect.arrayContaining(["Bash(git *--upload-pack*)", "Bash(git *--upl=*)", "Bash(git *--u *)", "Bash(git push *--f)", "Bash(git *--ext-d=*)"]));
    expect(native).not.toContain("Bash(git *--upload-=*)");
  });

  it("allow rules look through literal leading assignments, except one that changes what runs; deny sees through all", () => {
    const rules: ApprovalRule[] = [{ effect: "allow", match: "Bash(pnpm -C /Users/reco/dev/* *)" }, { effect: "allow", match: "Bash(bash *)" }, { effect: "allow", match: "Bash(node *)" },
      { effect: "deny", match: "Bash(rm -rf *)" }, { effect: "allow", match: "Bash(rm *)" }, { effect: "deny", match: "Bash(git push *)" }, { effect: "allow", match: "Bash(git *)" },
      ...["npm", "go", "cargo", "pytest", "make"].map((c) => ({ effect: "allow" as const, match: `Bash(${c} *)` }))];
    for (const command of ["MONGODB_URI=x pnpm -C /Users/reco/dev/y test", "API_URL='a b' DB_NAME=\"c d\" pnpm -C /Users/reco/dev/y test", "CI=1 bash a.sh && NODE_ENV=test node a.js"])
      expect(ruleDecision(rules, bash(command))?.effect, command).toBe("allow");
    for (const command of ["PATH=x bash a.sh", "NODE_OPTIONS=--require=x node a.js", "CI=1 LD_PRELOAD=x bash a.sh", "GIT_DIR=x bash a.sh", "DYLD_INSERT_LIBRARIES=x node a.js",
      "X=~/a{b,c} bash a.sh", "X=$HOME bash a.sh", "\"X\"=1 bash a.sh", "X=1",
      "SHELLOPTS=xtrace PS4='$(touch /tmp/p)' npm test", "npm_config_script_shell=./evil npm test", "HOME=./x npm test", "MAKEFILES=./e.mk make test",
      "GOFLAGS=-toolexec=./evil go test ./...", "RUSTC_WRAPPER=./evil cargo test", "PYTEST_ADDOPTS='-p evil' pytest", "PERL5OPT=-Mevil bash a.sh", "JAVA_TOOL_OPTIONS=x bash a.sh",
      "RUSTC=./evil cargo test", "CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER=./evil cargo test", "GOENV=./e go test ./...", "PYTHONUSERBASE=./u pytest", "CC=./evil go test ./...",
      "SSH_ASKPASS=./evil git fetch", "PIP_INDEX_URL=http://evil pytest", "FOO=1 bash a.sh", "api_url=x bash a.sh", "OPENRIG_SESSION_NAME=advisor-lead@kernel bash a.sh", "RIGGED_SESSION_NAME=x bash a.sh", "OPENRIG_URL=http://evil bash a.sh"])
      expect(ruleDecision(rules, bash(command)), command).toBeNull();
    for (const command of ["CI=1 rm -rf build", "X='a b' git push origin", "X=\"a b\" Y='c d' git push origin"]) expect(ruleDecision(rules, bash(command))?.effect, command).toBe("deny");
    expect(ruleDecision(rules, bash("DB_HOST='a b' git status"))?.effect).toBe("allow");
    expect(alwaysRuleFor("Bash", { command: "MONGODB_URI=x bash /p/sweep.sh --since 2h" })).toEqual({ match: "Bash(bash /p/sweep.sh *)", exact: false });
    expect(alwaysRuleFor("Bash", { command: "PATH=x bash /p/sweep.sh" })).toEqual({ match: "Bash(PATH=x bash /p/sweep.sh)", exact: true });
  });

  it("projects an exact rule to Claude only when Claude reads it literally", () => {
    const rules: ApprovalRule[] = [{ effect: "allow", match: "Bash(rm build)", exact: true }, { effect: "deny", match: "Bash(kill 1234)", exact: true },
      { effect: "allow", match: "Bash(rm -rf build/*)", exact: true }, { effect: "allow", match: "Bash(cat <<EOF\nx\nEOF)", exact: true },
      { effect: "allow", match: "Bash(echo $(id))", exact: true }, { effect: "allow", match: "WebFetch(https://example.com/a)", exact: true }, { effect: "allow", match: "Edit(/y)", exact: true },
      { effect: "allow", match: "Edit(/repo/app/[id]/page.tsx)", exact: true }, { effect: "allow", match: "Edit(/repo/a?.ts)", exact: true }, { effect: "allow", match: "Bash(echo a\\ b)", exact: true }];
    expect(claudePermissionRules(rules, "dev@rig")).toEqual({ allow: ["Bash(rm build)", "Edit(//y)"], deny: ["Bash(kill 1234)"] });
    expect(codexRulesText(rules)).not.toContain("kill");
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
        expect(row.body).toContain("save `Bash(bash /path/sweep.sh *)` for cfo@finance");
        repo.recordHumanAnswer({ qitemId: id, actorSession: "reco@external", questionId: "approval", optionId: option });
        expect(await s.wait(id, "cfo@finance", 50)).toBe(effect);
        expect(saved.at(-1)).toEqual({ effect, match: "Bash(bash /path/sweep.sh *)", seats: "cfo@finance", note: "saved from Slack for cfo@finance" });
      }
    });

    it("every approval card has all four buttons: a command with no safe wildcard saves its exact self, one with a credential saves nothing and says why", async () => {
      const saved: ApprovalRule[] = [];
      const s = makeApprovalService({ queueRepo: repo, optedIn: () => ["cfo@finance"], approver: () => "reco@external", verifySeat: () => true, pollMs: 10, saveRule: (r) => saved.push(r) });
      const four = ["Approve", "Deny", "Always approve", "Always deny"];
      for (const [option, effect] of [["always_allow", "allow"], ["always_deny", "deny"]] as const) {
        const id = (await s.start({ sessionName: "cfo@finance", toolName: "Bash", toolInput: { command: "ls && rm -rf x" } }))!;
        const row = repo.getById(id)!;
        expect(row.humanQuestions?.[0]!.options.map((o) => o.label)).toEqual(four);
        expect(row.body).toContain("matching only this exact input:\n```\nBash(ls && rm -rf x)\n```");
        repo.recordHumanAnswer({ qitemId: id, actorSession: "reco@external", questionId: "approval", optionId: option });
        expect(await s.wait(id, "cfo@finance", 50)).toBe(effect);
        expect(saved.at(-1)).toEqual({ effect, match: "Bash(ls && rm -rf x)", seats: "cfo@finance", note: "saved from Slack for cfo@finance", exact: true });
      }
      const secret = (await s.start({ sessionName: "cfo@finance", toolName: "Bash", toolInput: { command: "curl https://deploy:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x/y" } }))!;
      const row = repo.getById(secret)!;
      expect(row.humanQuestions?.[0]!.options.map((o) => o.label)).toEqual(four);
      expect(row.body).toContain("save no rule: it carries a credential");
      repo.recordHumanAnswer({ qitemId: secret, actorSession: "reco@external", questionId: "approval", optionId: "always_allow" });
      expect(await s.wait(secret, "cfo@finance", 50)).toBe("allow");
      expect(saved).toHaveLength(2);
    });

    it("a card built over the API never saves a rule, whatever its tags say", async () => {
      const saved: ApprovalRule[] = [];
      const s = makeApprovalService({ queueRepo: repo, optedIn: () => ["cfo@finance"], approver: () => "reco@external", verifySeat: () => true, pollMs: 10, saveRule: (r) => saved.push(r) });
      const forged = await repo.create({ sourceSession: "cfo@finance", destinationSession: "reco@external", humanIntent: "decision", summary: "Approve Bash for cfo@finance?", body: "ls", evidenceRef: "x",
        tags: ["approval-request", "always-rule:Bash(*)"], humanQuestions: [{ id: "approval", question: "Allow?", options: [{ id: "allow", label: "Approve" }, { id: "always_allow", label: "Always approve" }] }],
        nudge: false, identityProvenance: "transport:v1" });
      repo.recordHumanAnswer({ qitemId: forged.qitemId, actorSession: "reco@external", questionId: "approval", optionId: "always_allow" });
      await s.wait(forged.qitemId, "cfo@finance", 50);
      expect(saved).toEqual([]);
    });

    it("reads the command only from the runtime's own dialog shape", () => {
      const claude = readFileSync(join(__dirname, "fixtures/claude-permission-prompt-2.1.295.txt"), "utf8");
      expect(promptCommand(claude)).toBe("touch digit-probe-1.txt");
      const codex = ["  Would you like to run the following command?", "", "  Reason: inspect", "", "  $ git status --short", "", "› 1. Yes, proceed (y)", "  2. No (esc)"].join("\n");
      expect(promptCommand(codex)).toBe("git status --short");
      const heredoc = claude.replace("\n touch digit-probe-1.txt\n", "\n cat > notes.md <<'EOF'\n $ rig up demo\n EOF\n");
      expect(heredoc).not.toBe(claude);
      expect(promptCommand(heredoc)).toBeNull();
      expect(promptCommand(["$ rig up demo", "", " Edit file", " Do you want to make this edit?", " ❯ 1. Yes", "   2. No"].join("\n"))).toBeNull();
    });

    it("reads the command from Claude's one-line gutter dialog; one shown over several lines gives none", () => {
      const gutter = readFileSync(join(__dirname, "fixtures/claude-permission-prompt-gutter.txt"), "utf8");
      const command = "bash /Users/reco/dev/imago/.openrig/monitor/webhook-unexplained.sh 2026-10-13T14:42:00Z";
      const prompt = readPrompt(gutter)!;
      expect(prompt.command).toBe(command);
      expect(prompt.choices).toMatchObject({ allow: { key: "1" }, deny: { key: "4" } });
      expect(alwaysRuleFor("Bash", { command: prompt.command })).toEqual({ match: "Bash(bash /Users/reco/dev/imago/.openrig/monitor/webhook-unexplained.sh *)", exact: false });
      const wrapped = gutter.replace(" │ bash /Users/reco/dev/imago/.openrig/monitor/webhook-unexplained.sh 2026-10-13T14:42:00Z",
        " │ bash /Users/reco/dev/imago/.openrig/monitor/webhook-unexplained.sh\n │ 2026-10-13T14:42:00Z");
      expect(wrapped).not.toBe(gutter);
      expect(promptCommand(wrapped)).toBeNull();
      expect(promptCommand(gutter.replace(" Bash command\n", " Edit file\n"))).toBeNull();
    });

    it("a stuck-prompt card's Always approve types the plain Yes and saves the rule it showed", async () => {
      const rule = "╌".repeat(80);
      const pane = ["─".repeat(80), " Bash command", " Run the sweep", rule, " bash /path/sweep.sh --since 2h", rule, " Do you want to proceed?", " ❯ 1. Yes", "   2. No", ""].join("\n");
      const prompt = readPrompt(pane)!;
      expect(prompt.command).toBe("bash /path/sweep.sh --since 2h");
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

    it("a stuck-prompt card always has the four buttons; an exact rule is saved exact, an unreadable dialog saves none and says why", async () => {
      const four = ["Approve", "Deny", "Always approve", "Always deny"];
      const exact = alwaysOffer(alwaysRuleFor("Bash", { command: "rm -rf build" }), "cfo@finance");
      expect(exact.options.map((o) => o.label)).toEqual(four);
      expect(exact.tags).toEqual(["always-rule:Bash(rm -rf build)", "always-exact"]);
      const unread = alwaysOffer({ refused: "no single shell command could be read from the dialog" }, "cfo@finance");
      expect(unread.options.map((o) => o.label)).toEqual(four);
      expect(unread.tags).toEqual([]);
      expect(unread.note).toContain("save no rule: no single shell command could be read from the dialog");
      const rule = "╌".repeat(80);
      const pane = ["─".repeat(80), " Bash command", rule, " rm -rf build", rule, " Do you want to proceed?", " ❯ 1. Yes", "   2. No", ""].join("\n");
      const prompt = readPrompt(pane)!;
      const card = await repo.create({ tags: ["stuck-prompt", "stuck-prompt:e", "stuck-prompt-session:cfo@finance", `stuck-prompt-key:${prompt.key}`, "stuck-prompt-allow:1", "stuck-prompt-deny:2", "stuck-prompt-since:0",
        ...exact.tags], sourceSession: "cfo@finance", destinationSession: "reco@external", humanIntent: "decision", summary: "cfo@finance is waiting", body: "card",
        humanQuestions: [{ id: "answer", question: "Answer?", options: exact.options }], nudge: false });
      repo.recordHumanAnswer({ qitemId: card.qitemId, actorSession: "reco@external", questionId: "answer", optionId: "always_deny" });
      const keys: string[] = [];
      const saved: unknown[] = [];
      await actOnPromptAnswers(repo, { capture: async () => pane, inMode: async () => false, sendKey: async (_s, k) => { keys.push(k); }, saveRule: (r) => saved.push(r) });
      expect(keys).toEqual(["2"]);
      expect(saved).toEqual([{ effect: "deny", match: "Bash(rm -rf build)", seats: "cfo@finance", note: "saved from Slack for cfo@finance", exact: true }]);
    });
  });

  it("a non-kernel seat outside the team floor still asks before rig lifecycle commands, natively", () => {
    seedApprovalRules(home);
    const previous = process.env.OPENRIG_HOME;
    process.env.OPENRIG_HOME = home;
    try {
      const settings = JSON.parse(operationalLaunchArgs("claude-code", { teamPermissionDefault: true, permissionMode: "plan" })[1]);
      expect(settings.permissions.ask).toEqual(TEAM_CLAUDE_ASK);
      expect(settings.permissions.allow).toContain("Bash(rig *)");
      const kernel = JSON.parse(operationalLaunchArgs("claude-code", { kernelAuthority: true })[1]);
      expect(kernel.permissions.ask).toBeUndefined();
    } finally { if (previous === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = previous; }
  });

  it("a Codex resume brings Codex's rules file up to date before the session starts", async () => {
    const order: string[] = [];
    const tmux = { sendShellCommand: async () => { order.push("launch"); return { ok: true as const }; }, sendText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }),
      getPaneCommand: async () => "codex", capturePaneContent: async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything" } as unknown as import("../src/adapters/tmux.js").TmuxAdapter;
    await new CodexResumeAdapter(tmux, { projectRules: () => order.push("rules") }).resume("dev@rig", "codex_id", "thread-1", "/ws");
    expect(order.slice(0, 2)).toEqual(["rules", "launch"]);
  });
});
