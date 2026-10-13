import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalsCommand } from "../src/commands/approvals.js";

describe("rig approvals", () => {
  const homes: string[] = [];
  afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
  const run = async (home: string, args: string[]) => {
    const out: string[] = [];
    await approvalsCommand({ home, log: (m) => out.push(m) }).exitOverride().parseAsync(args, { from: "user" });
    return out.join("\n");
  };

  it("adds, lists and removes rules in the home's approval-rules.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "approvals-")); homes.push(home);
    expect(await run(home, ["list"])).toBe("No approval rules.");
    expect(await run(home, ["allow", "Bash(ps *)"])).toContain("1. allow Bash(ps *)");
    await run(home, ["deny", "Bash(git push *)", "--seats", "*@openrig-dev", "--note", "advisor merges"]);
    expect(await run(home, ["list"])).toBe("1. allow Bash(ps *)\n2. deny Bash(git push *) seats=*@openrig-dev (advisor merges)");
    await run(home, ["remove", "1"]);
    expect(JSON.parse(readFileSync(join(home, "approval-rules.json"), "utf8"))).toEqual({ rules: [{ effect: "deny", match: "Bash(git push *)", seats: "*@openrig-dev", note: "advisor merges" }] });
    await expect(run(home, ["allow", "Bash()"])).rejects.toThrow(/not a rule/);
    await expect(run(home, ["remove", "9"])).rejects.toThrow(/no rule 9/);
  });
});
