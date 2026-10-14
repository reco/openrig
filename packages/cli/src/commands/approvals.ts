import { Command } from "commander";
import { getOpenRigHome } from "../openrig-compat.js";

type RulesSurface = typeof import("@openrig/daemon/approval-rules");
type Rule = Awaited<ReturnType<RulesSurface["readApprovalRules"]>>[number];

export interface ApprovalsDeps {
  home?: string;
  log?: (msg: string) => void;
}

const APPLIES =
  "Rules answer permission prompts at once. A deny rule also reaches a Claude seat's own settings at its next launch or restore.";

export function approvalsCommand(deps: ApprovalsDeps = {}): Command {
  const log = deps.log ?? ((m: string) => console.log(m));
  const home = () => deps.home ?? getOpenRigHome();
  const surface = async () => (await import("@openrig/daemon/approval-rules")) as RulesSurface;
  const describe = (r: Rule, i: number) => `${i + 1}. ${r.effect} ${r.match}${r.seats ? ` seats=${r.seats}` : ""}${r.note ? ` (${r.note})` : ""}`;
  const skippedNote = (skipped: unknown[], verb: string) =>
    skipped.length ? `\n${verb} ${skipped.length} invalid allow rule(s): ${skipped.map((r) => JSON.stringify(r)).join(" ")}` : "";

  const cmd = new Command("approvals").description(
    "Allow/deny rules for agent permission prompts (Claude and Codex seats). Deny wins over allow; a prompt no rule matches asks the human as before.",
  );

  cmd.command("list").description("List the rules, numbered").option("--json", "JSON output").action(async (opts: { json?: boolean }) => {
    const { rules, skipped } = (await surface()).readRulesFile(home());
    if (opts.json) return log(JSON.stringify({ rules, skipped }, null, 2));
    log((rules.length ? rules.map(describe).join("\n") : "No approval rules.") + skippedNote(skipped, "Skipped"));
  });

  for (const effect of ["allow", "deny"] as const) {
    cmd.command(`${effect} <match>`)
      .description(`Add a rule that ${effect === "allow" ? "approves" : "refuses"} matching prompts. <match> is Tool or Tool(pattern), * matches anything: "Bash(ps *)", "Bash(git push *)", "Edit(~/dev/**)", "mcp__slack__*"`)
      .option("--seats <glob>", "only these seats, e.g. '*@openrig-dev' (default: every seat)")
      .option("--note <text>", "why; a deny shows it to the agent")
      .action(async (match: string, opts: { seats?: string; note?: string }) => {
        const s = await surface();
        const rule: Rule = { effect, match, ...(opts.seats ? { seats: opts.seats } : {}), ...(opts.note ? { note: opts.note } : {}) };
        if (!s.isValidRule(rule)) throw new Error(`not a rule: ${match} (expected Tool or Tool(pattern))`);
        const file = s.readRulesFile(home());
        const rules = [...file.rules, rule];
        s.writeApprovalRules(home(), rules);
        log(`${describe(rule, rules.length - 1)}\n${APPLIES}${skippedNote(file.skipped, "Dropped")}`);
      });
  }

  cmd.command("remove <number>").description("Remove a rule by its number in `rig approvals list`").action(async (n: string) => {
    const s = await surface();
    const { rules, skipped } = s.readRulesFile(home());
    const index = Number(n) - 1;
    if (!Number.isInteger(index) || !rules[index]) throw new Error(`no rule ${n}; see rig approvals list`);
    s.writeApprovalRules(home(), rules.filter((_, i) => i !== index));
    log(`removed ${describe(rules[index]!, index)}${skippedNote(skipped, "Dropped")}`);
  });

  return cmd;
}
