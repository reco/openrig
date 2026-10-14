import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeDenyRules, readApprovalRules, readRulesFile, ruleDecision, saveAlwaysRule, type ApprovalRule } from "../src/domain/approval-rules.js";
import { makeApprovalService } from "../src/domain/approvals.js";
import { activityRoutes } from "../src/routes/activity.js";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";

const require = createRequire(import.meta.url);
const hook = require("../assets/plugins/openrig-core/hooks/scripts/approval-request.cjs") as { decisionOutput: (d: unknown, m?: unknown) => string | null };

const bash = (command: string, sessionName = "dev-owner@openrig-dev") => ({ sessionName, toolName: "Bash", toolInput: { command } });
const effect = (rules: ApprovalRule[], req: Parameters<typeof ruleDecision>[1]) => ruleDecision(rules, req)?.effect ?? null;

describe("approval rules", () => {
  const homes: string[] = [];
  afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  const home = (rules: unknown) => { const h = mkdtempSync(join(tmpdir(), "rules-")); homes.push(h); writeFileSync(join(h, "approval-rules.json"), JSON.stringify(rules)); return h; };

  it("allows a simple command matching an allow rule, with or without arguments, and Claude's :* form", () => {
    const rules: ApprovalRule[] = [{ effect: "allow", match: "Bash(ps *)" }, { effect: "allow", match: "Bash(lsof:*)" }];
    expect(effect(rules, bash("ps"))).toBe("allow");
    expect(effect(rules, bash("ps -o pid,ppid -p 42"))).toBe("allow");
    expect(effect(rules, bash("lsof -nP -iTCP:7433"))).toBe("allow");
    expect(effect(rules, bash("psql -c 'drop table x'"))).toBeNull();
  });

  it("never allows a chain with an uncovered part, nor any expanding or redirecting command", () => {
    const rules: ApprovalRule[] = [{ effect: "allow", match: "Bash(ps *)" }];
    expect(effect(rules, bash("ps aux; rm -rf ~"))).toBeNull();
    expect(effect(rules, bash("ps $(rm -rf ~)"))).toBeNull();
    expect(effect(rules, bash("ps aux | grep node"))).toBeNull();
    expect(effect(rules, bash("ps aux > /etc/x"))).toBeNull();
    expect(effect(rules, bash("cd /tmp && ./evil"))).toBeNull();
    expect(effect(rules, bash("cd /tmp"))).toBeNull();
    expect(effect(rules, bash("cd $(evil) && ps"))).toBeNull();
    expect(effect(rules, bash("ps & rm x"))).toBeNull();
  });

  it("allows a chain of plain commands when every part is allowed, a cd included, and denies on any denied part", () => {
    const rules: ApprovalRule[] = [{ effect: "allow", match: "Bash(git *)" }, { effect: "allow", match: "Bash(npm test *)" }, { effect: "allow", match: "Bash(grep *)" }, { effect: "deny", match: "Bash(git push *)" }, { effect: "allow", match: "Bash(cd /Users/reco/dev/*)" }];
    expect(effect(rules, bash("cd /Users/reco/dev/x && npm test"))).toBe("allow");
    expect(effect(rules, bash("cd ~ && npm test"))).toBeNull();
    expect(effect(rules, bash("cd /Users/reco/other && npm test"))).toBeNull();
    expect(effect(rules, bash("cd /Users/reco/dev/../.. && npm test"))).toBeNull();
    expect(effect(rules, bash("cd /Users/reco/dev/x / && npm test"))).toBeNull();
    expect(effect(rules, bash("cd /Users/reco/dev/x /"))).toBeNull();
    expect(effect(rules, bash("git status && git log --oneline -3"))).toBe("allow");
    expect(effect(rules, bash("git log | grep fix"))).toBe("allow");
    expect(effect(rules, bash("git fetch; git status || git branch"))).toBe("allow");
    expect(effect(rules, bash("git status && git push origin x"))).toBe("deny");
    expect(effect(rules, bash("git status && npm publish"))).toBeNull();
  });

  it("allows quoted literals: single quotes, or double quotes without $, ` or \\ inside", () => {
    const rules: ApprovalRule[] = [{ effect: "allow", match: "Bash(sqlite3 -readonly -safe *)" }, { effect: "allow", match: "Bash(grep *)" }, { effect: "allow", match: "Bash(git log *)" }];
    expect(effect(rules, bash("sqlite3 -readonly -safe db.sqlite 'select count(*) from t where a = 1;'"))).toBe("allow");
    expect(effect(rules, bash(`grep -rn "a && b | c" src`))).toBe("allow");
    expect(effect(rules, bash(`git log --format='%h %s' | grep 'fix: x'`))).toBe("allow");
    expect(effect(rules, bash(`grep "$PATH" x`))).toBeNull();
    expect(effect(rules, bash("grep 'unbalanced x"))).toBeNull();
    const git: ApprovalRule[] = [{ effect: "allow", match: "Bash(git *)" }, { effect: "deny", match: "Bash(git push*)" }, { effect: "allow", match: "Bash(cat *)" }];
    for (const command of ["git ''{push,origin}", "git add ''*", "cat ~/'.ssh/id_rsa'", "git log 'a'?", "git log x''[ab]"]) expect(effect(git, bash(command)), command).not.toBe("allow");
  });

  it("never allows past an assignment, a wrapper, an executable path, quoting or odd spacing", () => {
    const rules: ApprovalRule[] = [{ effect: "allow", match: "Bash(ps *)" }, { effect: "allow", match: "Bash(ls *)" }];
    for (const command of ["PATH=/tmp/evil ps aux", "LD_PRELOAD=/tmp/x.so ps", "./ps aux", "/tmp/x/ps", "/bin/ps aux", "sudo ls /root", "env ls",
      "ps\taux", "ps a\\ux", "ls *", "ls ~", "'ps' aux", "ps \"$HOME\"", "ps \"a`id`\"", "ps \"a\\b\""]) {
      expect(effect(rules, bash(command)), command).toBeNull();
    }
  });

  it("denies when any part of a command matches a deny rule, and deny beats allow", () => {
    const rules: ApprovalRule[] = [{ effect: "allow", match: "Bash(git *)" }, { effect: "deny", match: "Bash(git push *)", note: "advisor merges" }];
    expect(effect(rules, bash("git status"))).toBe("allow");
    expect(effect(rules, bash("git push origin main"))).toBe("deny");
    expect(effect(rules, bash("git fetch && git push --force"))).toBe("deny");
    expect(effect(rules, bash("echo $(git push)"))).toBe("deny");
    expect(effect(rules, bash("FOO=1 sudo git push"))).toBe("deny");
    for (const command of ["git  push origin main", "git 'push' origin main", "git p\\ush origin", "git \tpush", "/usr/bin/git push", "{ git push; }", "nice git push"]) {
      expect(effect(rules, bash(command)), command).toBe("deny");
    }
  });

  it("matches file paths after normalising them, never allows a path with .., and * stays within one directory", () => {
    const rules: ApprovalRule[] = [{ effect: "allow", match: "Read(~/**)" }, { effect: "deny", match: "Read(~/.ssh/**)" }, { effect: "allow", match: "Edit(/srv/*.txt)" }];
    const tool = (toolName: string, file_path: string) => ({ sessionName: "a@b", toolName, toolInput: { file_path } });
    expect(effect(rules, tool("Read", `${process.env.HOME}/notes.md`))).toBe("allow");
    expect(effect(rules, tool("Read", `${process.env.HOME}/x/../.ssh/id_rsa`))).toBe("deny");
    expect(effect(rules, tool("Read", `${process.env.HOME}/x/../notes.md`))).toBeNull();
    expect(effect(rules, tool("Edit", "/srv/a.txt"))).toBe("allow");
    expect(effect(rules, tool("Edit", "/srv/sub/a.txt"))).toBeNull();
    const env: ApprovalRule[] = [{ effect: "allow", match: "Read(~/**)" }, { effect: "deny", match: "Read(~/**/.env)" }, { effect: "deny", match: "Edit(//etc/**)" }];
    expect(effect(env, tool("Read", `${process.env.HOME}/.env`))).toBe("deny");
    expect(effect(env, tool("Read", `${process.env.HOME}/a/b/.env`))).toBe("deny");
    expect(effect(env, tool("Edit", "/etc/hosts"))).toBe("deny");
    expect(claudeDenyRules(env, null)).toEqual(["Read(~/**/.env)", "Edit(//etc/**)"]);
  });

  it("the git deny rules stop command-running and file-writing options that the subcommand allows would pass", () => {
    const rules: ApprovalRule[] = [
      ...["git status *", "git log *", "git diff *", "git show *", "git fetch *", "git branch *", "git rev-parse *"].map((m) => ({ effect: "allow" as const, match: `Bash(${m})` })),
      ...["git *--upload-pack*", "git *--output*", "git -c *", "git *--ext-diff*"].map((m) => ({ effect: "deny" as const, match: `Bash(${m})` })),
    ];
    for (const command of ["git fetch --upload-pack=/tmp/x origin", "git fetch origin --upload-pack /tmp/x", "git diff --output=/etc/hosts", "git log --output=/tmp/x",
      "git show HEAD --output=x", "git -c core.pager=sh log", "git -c diff.external=/tmp/x diff", "git diff --ext-diff", "cd /Users/reco/dev/x && git log --output=y"]) {
      expect(effect(rules, bash(command)), command).toBe("deny");
    }
    for (const command of ["git fetch origin", "git fetch", "git log --oneline -5", "git diff HEAD~1", "git status"]) {
      expect(effect(rules, bash(command)), command).not.toBe("deny");
    }
    expect(effect(rules, bash("git fetch origin"))).toBe("allow");
  });

  it("matches tools by name and file tools by path, scoped to seats", () => {
    const rules: ApprovalRule[] = [
      { effect: "allow", match: "Edit(/Users/reco/dev/**)", seats: "*@openrig-dev" },
      { effect: "deny", match: "mcp__slack__*" },
      { effect: "allow", match: "WebFetch" },
    ];
    const edit = (file_path: string, sessionName = "dev-owner@openrig-dev") => ({ sessionName, toolName: "Edit", toolInput: { file_path } });
    expect(effect(rules, edit("/Users/reco/dev/openrig/x.ts"))).toBe("allow");
    expect(effect(rules, edit("/etc/hosts"))).toBeNull();
    expect(effect(rules, edit("/Users/reco/dev/x.ts", "dev4-owner@Imago"))).toBeNull();
    expect(effect(rules, { sessionName: "a@b", toolName: "mcp__slack__post", toolInput: {} })).toBe("deny");
    expect(effect(rules, { sessionName: "a@b", toolName: "WebFetch", toolInput: { url: "https://x" } })).toBe("allow");
  });

  it("reads rules from the home, skips an invalid allow, and refuses a file with any other invalid rule", () => {
    expect(readApprovalRules(mkdtempSync(join(tmpdir(), "none-")))).toEqual([]);
    expect(readApprovalRules(home({ rules: [{ effect: "allow", match: "Bash(ps *)" }] }))).toHaveLength(1);
    expect(() => readApprovalRules(home({ rules: [{ effect: "maybe", match: "Bash(ps *)" }] }))).toThrow(/rule 1 is invalid/);
    expect(() => readApprovalRules(home({ rules: [{ effect: "deny", match: "Bash(git push *" }] }))).toThrow(/rule 1 is invalid/);
    const bad = { effect: "allow", match: "Bash(tmux *" };
    const h = home({ rules: [{ effect: "allow", match: "Bash(ps *)" }, bad, { effect: "allow", match: "Bash()" }] });
    expect(readApprovalRules(h)).toEqual([{ effect: "allow", match: "Bash(ps *)" }]);
    expect(readRulesFile(h).skipped).toEqual([bad, { effect: "allow", match: "Bash()" }]);
    expect(() => saveAlwaysRule(h, bad as ApprovalRule)).toThrow(/not a rule/);
    saveAlwaysRule(h, { effect: "allow", match: "Bash(tmux ls *)" });
    expect(readRulesFile(h)).toEqual({ rules: [{ effect: "allow", match: "Bash(ps *)" }, { effect: "allow", match: "Bash(tmux ls *)" }], skipped: [] });
  });

  it("an allow missing its closing paren leaves the deny check working for every seat", async () => {
    const h = home({ rules: [{ effect: "allow", match: "Bash(env -u TMUX tmux *" }, { effect: "allow", match: "Bash(tmux *" },
      { effect: "deny", match: "Bash(git push * main)", note: "merges go through review" }, { effect: "allow", match: "Bash(git status *)" }] });
    const service = makeApprovalService({ queueRepo: {} as never, optedIn: () => [], approver: () => null, verifySeat: () => true, rules: () => readApprovalRules(h) });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("activityHookToken" as never, "hook" as never);
      c.set("approvalService" as never, service as never);
      await next();
    });
    app.route("/api/activity", activityRoutes);
    const check = (command: string) => app.request("/api/activity/deny-check", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer hook" }, body: JSON.stringify({ sessionName: "dev@rig", command }) });
    const pushed = await check("git push origin main");
    expect(pushed.status).toBe(200);
    expect(await pushed.json()).toMatchObject({ ok: true, deny: true });
    expect(await (await check("git status")).json()).toEqual({ ok: true, deny: false });
    expect(service.byRule(bash("tmux ls"))).toBeNull();
  });

  it("the approvals route answers from a rule before any human is asked, and the hook shows the rule's reason", async () => {
    const started: string[] = [];
    const rules: ApprovalRule[] = [{ effect: "deny", match: "Bash(git push *)", note: "advisor merges" }, { effect: "allow", match: "Bash(ps *)" }];
    const service = makeApprovalService({ queueRepo: { list: () => [] } as never, optedIn: () => [], approver: () => null, verifySeat: () => true, rules: () => rules });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("activityHookToken" as never, "hook" as never);
      c.set("approvalService" as never, { ...service, start: async () => { started.push("start"); return null; } } as never);
      await next();
    });
    app.route("/api/activity", activityRoutes);
    const call = async (command: string) => (await app.request("/api/activity/approvals", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer hook" }, body: JSON.stringify({ sessionName: "dev@rig", seatToken: "t", toolName: "Bash", toolInput: { command } }) })).json() as Promise<Record<string, unknown>>;
    expect(await call("ps aux")).toMatchObject({ decision: "allow", pending: false });
    const denied = await call("git push origin main");
    expect(denied).toMatchObject({ decision: "deny" });
    expect(JSON.parse(hook.decisionOutput(denied.decision, denied.message)!).hookSpecificOutput.decision.message).toBe("Denied by the OpenRig approval rule Bash(git push *): advisor merges");
    expect(started).toEqual([]);
    expect(await call("npm publish")).toMatchObject({ decision: null });
    expect(started).toEqual(["start"]);
  });

  it("a broken rules file decides nothing", () => {
    const service = makeApprovalService({ queueRepo: {} as never, optedIn: () => [], approver: () => null, verifySeat: () => true, rules: () => { throw new Error("bad json"); } });
    expect(service.byRule(bash("ps"))).toBeNull();
  });

  it("imports the seat's deny rules into a Claude launch, merged into its one settings flag", () => {
    const rules: ApprovalRule[] = [{ effect: "deny", match: "Bash(git push:*)" }, { effect: "deny", match: "WebFetch", seats: "*@Imago" }, { effect: "allow", match: "Bash(ps *)" }];
    expect(claudeDenyRules(rules, "dev-owner@openrig-dev")).toEqual(["Bash(git push *)"]);
    expect(claudeDenyRules(rules, "dev4-owner@Imago")).toEqual(["Bash(git push *)", "WebFetch"]);
    expect(claudeDenyRules([{ effect: "deny", match: "Edit(/etc/**)" }, { effect: "deny", match: "mcp__slack__post(x)" }, { effect: "deny", match: "mcp__slack__*" }], null)).toEqual(["Edit(//etc/**)", "mcp__slack__*"]);
    vi.stubEnv("OPENRIG_HOME", home({ rules }));
    vi.stubEnv("OPENRIG_YOLO", "0");
    const settingsOf = (args: string[]) => args.flatMap((a, i) => args[i - 1] === "--settings" ? [JSON.parse(a)] : []);
    const team = settingsOf(operationalLaunchArgs("claude-code", { kernelAuthority: false, teamPermissionDefault: true, tmuxSession: "dev4-owner@Imago" } as never));
    expect(team).toHaveLength(1);
    expect(team[0].permissions.deny).toEqual(["Bash(git push *)", "WebFetch"]);
    expect(team[0].permissions.allow.length).toBeGreaterThan(0);
    const bypass = operationalLaunchArgs("claude-code", { kernelAuthority: false, launchPosture: "full_bypass", nonInterruptive: true, tmuxSession: "x@rig" } as never);
    const bypassSettings = settingsOf(bypass);
    expect(bypassSettings).toHaveLength(1);
    expect(bypassSettings[0]).toMatchObject({ skipDangerousModePermissionPrompt: true, permissions: { deny: ["Bash(git push *)"] } });
    expect(settingsOf(operationalLaunchArgs("claude-code", { kernelAuthority: true, tmuxSession: "operator-agent@kernel" } as never))[0].permissions.deny).toEqual(["Bash(git push *)"]);
    expect(operationalLaunchArgs("codex", { kernelAuthority: false, tmuxSession: "x@rig" } as never).join(" ")).not.toContain("deny");
  });
});
