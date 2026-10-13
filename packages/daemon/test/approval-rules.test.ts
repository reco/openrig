import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeDenyRules, readApprovalRules, ruleDecision, type ApprovalRule } from "../src/domain/approval-rules.js";
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
    expect(effect(rules, bash("/bin/ps aux"))).toBe("allow");
    expect(effect(rules, bash("lsof -nP -iTCP:7433"))).toBe("allow");
    expect(effect(rules, bash("psql -c 'drop table x'"))).toBeNull();
  });

  it("never allows a compound or expanding command by rule", () => {
    const rules: ApprovalRule[] = [{ effect: "allow", match: "Bash(ps *)" }];
    expect(effect(rules, bash("ps aux; rm -rf ~"))).toBeNull();
    expect(effect(rules, bash("ps $(rm -rf ~)"))).toBeNull();
    expect(effect(rules, bash("ps aux | grep node"))).toBeNull();
    expect(effect(rules, bash("ps aux > /etc/x"))).toBeNull();
  });

  it("denies when any part of a command matches a deny rule, and deny beats allow", () => {
    const rules: ApprovalRule[] = [{ effect: "allow", match: "Bash(git *)" }, { effect: "deny", match: "Bash(git push *)", note: "advisor merges" }];
    expect(effect(rules, bash("git status"))).toBe("allow");
    expect(effect(rules, bash("git push origin main"))).toBe("deny");
    expect(effect(rules, bash("git fetch && git push --force"))).toBe("deny");
    expect(effect(rules, bash("echo $(git push)"))).toBe("deny");
    expect(effect(rules, bash("FOO=1 sudo git push"))).toBe("deny");
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

  it("reads rules from the home and refuses an invalid file rather than half-applying it", () => {
    expect(readApprovalRules(mkdtempSync(join(tmpdir(), "none-")))).toEqual([]);
    expect(readApprovalRules(home({ rules: [{ effect: "allow", match: "Bash(ps *)" }] }))).toHaveLength(1);
    expect(() => readApprovalRules(home({ rules: [{ effect: "maybe", match: "Bash(ps *)" }] }))).toThrow(/rule 1 is invalid/);
    expect(() => readApprovalRules(home({ rules: [{ effect: "allow", match: "Bash()" }] }))).toThrow(/invalid/);
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
