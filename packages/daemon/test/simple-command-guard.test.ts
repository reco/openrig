import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const guard = require("../assets/plugins/openrig-core/hooks/scripts/simple-command-guard.cjs") as { decide: (input: unknown) => { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } } | null };
const bash = (command: string) => guard.decide({ tool_name: "Bash", tool_input: { command } });

describe("simple-command guard", () => {
  it("refuses every complex form with a reason to rewrite", () => {
    for (const command of ["echo $(date)", "echo `date`", "echo $HOME", "for f in *; do echo $f; done", "while true; do sleep 1; done",
      "cat <<'EOF'\nhi\nEOF", "echo hi > /tmp/x", "sort < in", "sleep 10 &", "git status\ngit log", "(cd x && ls)", "{ ls; }", "if true; then ls; fi",
      "echo a\\ b", "grep \"$PATH\" x", "grep 'unbalanced", "ls\t-la"]) {
      const out = bash(command);
      expect(out?.hookSpecificOutput.permissionDecision, command).toBe("deny");
      expect(out!.hookSpecificOutput.permissionDecisionReason).toContain("Rewrite it as plain commands");
    }
  });

  it("passes plain commands, quoted literals, chains and script runs to the runtime's own handling", () => {
    for (const command of ["git status", "ls -la src/", "ls *.ts ~/x", "cd /Users/reco/dev/x && npm test", "git log --oneline | grep fix", "a; b || c",
      "sqlite3 -readonly -safe db 'select * from t where a = 1;'", `grep -rn "a && b" src`, "FOO=1 npm test", "./scripts/check.sh", "bash x.sh", "git commit -m 'one\ntwo'"]) {
      expect(bash(command), command).toBeNull();
    }
    expect(guard.decide({ tool_name: "Edit", tool_input: { file_path: "/x" } })).toBeNull();
  });
});
