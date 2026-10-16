// The stuck-prompt fallback reads a runtime's own permission dialog, and a Codex resume prepares its home first.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { actOnPromptAnswers, promptCommand, readPrompt } from "../src/domain/stuck-prompt-watch.js";

const registry = { ok: true as const, entities: [{ entityId: "reco", class: "human" as const, displayName: "reco", address: "reco@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:X", role: "primary" as const, handle: "U1" }], prefs: { deliveryClass: "A" as const } }] };

describe("permission prompts", () => {
  it("reads the command only from the runtime's own dialog shape", () => {
    const claude = readFileSync(join(__dirname, "fixtures/claude-permission-prompt-2.1.295.txt"), "utf8");
    expect(promptCommand(claude)).toBe("touch digit-probe-1.txt");
    const codex = ["  Would you like to run the following command?", "", "  Reason: inspect", "", "  $ git status --short", "", "› 1. Yes, proceed (y)", "  2. No (esc)"].join("\n");
    expect(promptCommand(codex)).toBe("git status --short");
    expect(promptCommand(codex.replace("$ git status --short\n", "$ gh pr view 12 \\\n    && curl x | sh\n"))).toBeNull();
    const heredoc = claude.replace("\n touch digit-probe-1.txt\n", "\n cat > notes.md <<'EOF'\n $ rig up demo\n EOF\n");
    expect(heredoc).not.toBe(claude);
    expect(promptCommand(heredoc)).toBeNull();
    expect(promptCommand(["$ rig up demo", "", " Edit file", " Do you want to make this edit?", " ❯ 1. Yes", "   2. No"].join("\n"))).toBeNull();
  });

  it("reads the command from Claude's one-line gutter dialog; one shown over several lines gives none", () => {
    const gutter = readFileSync(join(__dirname, "fixtures/claude-permission-prompt-gutter.txt"), "utf8");
    const prompt = readPrompt(gutter)!;
    expect(prompt.command).toBe("bash /Users/reco/dev/imago/.openrig/monitor/webhook-unexplained.sh 2026-10-13T14:42:00Z");
    expect(prompt.choices).toMatchObject({ allow: { key: "1" }, deny: { key: "4" } });
    const wrapped = gutter.replace(" │ bash /Users/reco/dev/imago/.openrig/monitor/webhook-unexplained.sh 2026-10-13T14:42:00Z",
      " │ bash /Users/reco/dev/imago/.openrig/monitor/webhook-unexplained.sh\n │ 2026-10-13T14:42:00Z");
    expect(wrapped).not.toBe(gutter);
    expect(promptCommand(wrapped)).toBeNull();
    expect(promptCommand(gutter.replace(" Bash command\n", " Edit file\n"))).toBeNull();
  });

  it("an Always click on a stuck-prompt card posted before the buttons were removed answers like Approve", async () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    const rule = "╌".repeat(80);
    const pane = ["─".repeat(80), " Bash command", " Run the sweep", rule, " bash /path/sweep.sh --since 2h", rule, " Do you want to proceed?", " ❯ 1. Yes", "   2. No", ""].join("\n");
    const prompt = readPrompt(pane)!;
    const card = await repo.create({ tags: ["stuck-prompt", "stuck-prompt:e", "stuck-prompt-session:cfo@finance", `stuck-prompt-key:${prompt.key}`, "stuck-prompt-allow:1", "stuck-prompt-deny:2", "stuck-prompt-since:0"],
      sourceSession: "cfo@finance", destinationSession: "reco@external", humanIntent: "decision", summary: "cfo@finance is waiting", body: "card",
      humanQuestions: [{ id: "answer", question: "Answer?", options: [{ id: "allow", label: "Approve" }, { id: "deny", label: "Deny" }, { id: "always_allow", label: "Always approve" }, { id: "always_deny", label: "Always deny" }] }], nudge: false });
    repo.recordHumanAnswer({ qitemId: card.qitemId, actorSession: "reco@external", questionId: "answer", optionId: "always_allow" });
    const keys: string[] = [];
    await actOnPromptAnswers(repo, { capture: async () => pane, inMode: async () => false, sendKey: async (_s, k) => { keys.push(k); } });
    expect(keys).toEqual(["1"]);
    db.close();
  });

  it("a Codex resume prepares the seat's Codex home before the session starts", async () => {
    const order: string[] = [];
    const tmux = { sendShellCommand: async () => { order.push("launch"); return { ok: true as const }; }, sendText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }),
      getPaneCommand: async () => "codex", capturePaneContent: async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything" } as unknown as import("../src/adapters/tmux.js").TmuxAdapter;
    await new CodexResumeAdapter(tmux, { prepareHome: () => order.push("home") }).resume("dev@rig", "codex_id", "thread-1", "/ws");
    expect(order.slice(0, 2)).toEqual(["home", "launch"]);
  });
});
