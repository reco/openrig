import { describe, expect, it } from "vitest";
import { answerPrompt, makeStuckPromptWatch, promptChoices, readPrompt, type StuckPrompt } from "../src/domain/stuck-prompt-watch.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const prompt = (question: string) => ["", "  Edit file", question, "❯ 1. Yes", "  2. Yes, and don't ask again", "  3. No", ""].join("\n");

describe("stuck-prompt watch", () => {
  it("notifies once per prompt episode after five minutes, with the question and the attach command", async () => {
    let t = 0;
    const panes = new Map<string, string>([["dev@rig", prompt("Do you want to make this edit to a.ts?")]]);
    const sent: StuckPrompt[] = [];
    const watch = makeStuckPromptWatch({ runningSessions: () => [...panes.keys()], capture: async (s) => panes.get(s) ?? null, notify: async (p) => { sent.push(p); }, now: () => t });
    await watch.tick();
    t = 4 * 60_000; await watch.tick();
    expect(sent).toHaveLength(0);
    t = 5 * 60_000; await watch.tick();
    t = 9 * 60_000; await watch.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ session: "dev@rig", reason: "selection_prompt", promptLine: "Do you want to make this edit to a.ts?", attach: "tmux attach -t dev@rig" });

    panes.set("dev@rig", prompt("Do you want to make this edit to b.ts?"));
    t = 10 * 60_000; await watch.tick();
    t = 16 * 60_000; await watch.tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.promptLine).toContain("b.ts");
  });

  it("forgets the episode once the seat moves on, and says nothing for a working seat", async () => {
    let t = 0;
    const panes = new Map<string, string>([["dev@rig", prompt("Run npm test?")]]);
    const sent: StuckPrompt[] = [];
    const watch = makeStuckPromptWatch({ runningSessions: () => [...panes.keys()], capture: async (s) => panes.get(s) ?? null, notify: async (p) => { sent.push(p); }, now: () => t });
    await watch.tick();
    t = 3 * 60_000; panes.set("dev@rig", "✻ Working… (esc to interrupt)"); await watch.tick();
    t = 4 * 60_000; panes.set("dev@rig", prompt("Run npm test?")); await watch.tick();
    t = 8 * 60_000; await watch.tick();
    expect(sent).toHaveLength(0);
  });

  it("names a Codex approval by its question and masks credentials the command carries", async () => {
    let t = 0;
    const codex = [
      "  Would you like to run the following command?", "",
      "  Reason: Do you want to allow running exactly `API_TOKEN=s3cr3tvalue123 deploy --password hunter22`?", "",
      "  $ API_TOKEN=s3cr3tvalue123 deploy --password hunter22", "",
      "› 1. Yes, proceed (y)", "  2. Yes, and don't ask again (p)", "  3. No, and tell Codex what to do differently (esc)", "",
      "  Press enter to confirm or esc to cancel",
    ].join("\n");
    const sent: StuckPrompt[] = [];
    const watch = makeStuckPromptWatch({ runningSessions: () => ["ops@rig"], capture: async () => codex, notify: async (p) => { sent.push(p); }, now: () => t });
    await watch.tick();
    t = 6 * 60_000; await watch.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.promptLine).toContain("Do you want to allow running exactly");
    expect(sent[0]!.promptLine).not.toContain("s3cr3tvalue123");
    expect(sent[0]!.promptLine).not.toContain("hunter22");
  });

  it("keeps the episode through an unreadable capture", async () => {
    let t = 0;
    let pane: string | null = prompt("Run npm test?");
    const sent: StuckPrompt[] = [];
    const watch = makeStuckPromptWatch({ runningSessions: () => ["dev@rig"], capture: async () => pane, notify: async (p) => { sent.push(p); }, now: () => t });
    await watch.tick();
    t = 3 * 60_000; pane = null; await watch.tick();
    t = 5 * 60_000; pane = prompt("Run npm test?"); await watch.tick();
    expect(sent).toHaveLength(1);
  });

  it("a new Claude approval with the same question is a new episode; the same prompt is reminded hourly", async () => {
    let t = 0;
    const claude = (command: string) => ["", " Bash command", "", `   ${command}`, "   Run the command", "", " Do you want to proceed?",
      " ❯ 1. Yes", "   2. Yes, and don't ask again for this command", "   3. No, and tell Claude what to do differently (esc)", ""].join("\n");
    let pane = claude("npm test");
    const sent: StuckPrompt[] = [];
    const watch = makeStuckPromptWatch({ runningSessions: () => ["lead@rig"], capture: async () => pane, notify: async (p) => { sent.push(p); }, now: () => t });
    await watch.tick();
    t = 6 * 60_000; await watch.tick();
    pane = claude("git push origin feature"); t = 7 * 60_000; await watch.tick();
    t = 13 * 60_000; await watch.tick();
    expect(sent.map((p) => p.promptLine)).toEqual(["Do you want to proceed?", "Do you want to proceed?"]);
    expect(sent[0]!.episodeId).not.toBe(sent[1]!.episodeId);
    t = 72 * 60_000; await watch.tick();
    expect(sent).toHaveLength(2);
    t = 73 * 60_000; await watch.tick();
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ episodeId: sent[1]!.episodeId, waitingMinutes: 66 });
  });

  it("a resized pane and output above the dialog are the same prompt", async () => {
    let t = 0;
    const dialog = (width: number, above: string) => [above, "─".repeat(width), " Bash command", "",
      ...(width > 60 ? ["   npm run test:repo -- --reporter verbose"] : ["   npm run test:repo --", "   --reporter verbose"]),
      "", " Do you want to   proceed?", " ❯ 1. Yes", "   2. No", ""].join("\n");
    let pane = dialog(80, "Task(explore) · 1.2k tokens · 3s");
    const sent: StuckPrompt[] = [];
    const watch = makeStuckPromptWatch({ runningSessions: () => ["lead@rig"], capture: async () => pane, notify: async (p) => { sent.push(p); }, now: () => t });
    await watch.tick();
    t = 2 * 60_000; pane = dialog(40, "Task(explore) · 4.8k tokens · 61s"); await watch.tick();
    t = 6 * 60_000; await watch.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.promptLine).toBe("Do you want to   proceed?");
  });

  const claude = readFileSync(resolve(__dirname, "fixtures/claude-permission-prompt-2.1.295.txt"), "utf8");
  const codex = ["  Would you like to run the following command?", "", "  $ touch /tmp/x", "",
    "› 1. Yes, proceed (y)", "  2. Yes, and don't ask again for commands that start with `touch` (p)", "  3. No, and tell Codex what to do differently (esc)", "",
    "  Press enter to confirm or esc to cancel"].join("\n");

  it("Approve is the plain Yes and Deny the No, never always-allow or switch-to-auto (Claude 2.1.295, Codex 0.161)", () => {
    expect(promptChoices(claude)).toEqual({ allow: { key: "1", label: "Yes" }, deny: { key: "4", label: "No" } });
    expect(promptChoices(codex)).toEqual({ allow: { key: "1", label: "Yes, proceed" }, deny: { key: "3", label: "No, and tell Codex what to do differently" } });
    expect(promptChoices(["Which color?", "❯ 1. Red", "  2. Blue"].join("\n"))).toBeUndefined();
    expect(promptChoices(["Allow network access?", "› 1. Yes, just this once (y)", "  2. No (n)"].join("\n"))).toBeUndefined();
  });

  it("a stuck permission prompt's notice carries its fingerprint and choices", async () => {
    let t = 0;
    const sent: StuckPrompt[] = [];
    const watch = makeStuckPromptWatch({ runningSessions: () => ["cfo@finance"], capture: async () => claude, notify: async (p) => { sent.push(p); }, now: () => t });
    await watch.tick(); t = 6 * 60_000; await watch.tick();
    expect(sent[0]).toMatchObject({ key: readPrompt(claude)!.key, choices: { allow: { key: "1" }, deny: { key: "4" } } });
  });

  it("an answer is typed only while the same prompt is up", async () => {
    const keys: string[] = [];
    let pane = claude;
    let inMode = false;
    const deps = { capture: async () => pane, sendKey: async (_s: string, k: string) => { keys.push(k); }, inMode: async () => inMode };
    const key = readPrompt(claude)!.key;
    inMode = true;
    expect((await answerPrompt(deps, "cfo@finance", key, "allow")).outcome).toBe("pane-busy");
    inMode = false;
    expect(await answerPrompt(deps, "cfo@finance", key, "allow")).toEqual({ outcome: "sent", key: "1" });
    expect(await answerPrompt(deps, "cfo@finance", key, "deny")).toEqual({ outcome: "sent", key: "4" });
    keys.length = 0; keys.push("1");
    expect(readPrompt(claude.replace("\n touch digit-probe-1.txt\n", "\n rm -rf /work/project\n"))!.key).not.toBe(key);
    pane = claude.replaceAll("touch digit-probe-1.txt", "rm -rf /work/project");
    expect((await answerPrompt(deps, "cfo@finance", key, "allow")).outcome).toBe("moved-on");
    pane = "✻ Working… (esc to interrupt)";
    expect((await answerPrompt(deps, "cfo@finance", key, "allow")).outcome).toBe("moved-on");
    expect(keys).toEqual(["1"]);
  });

  it("prompts differing only in a long command's top, or with a rule inside the command, differ", () => {
    const dialog = (command: string[]) => ["─".repeat(80), " Bash command", "", ...command.map((l) => `   ${l}`), "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", ""].join("\n");
    const tail = Array.from({ length: 30 }, (_, i) => `echo line ${i}`);
    expect(readPrompt(dialog(["rm -rf /", ...tail]))!.key).not.toBe(readPrompt(dialog(["ls", ...tail]))!.key);
    expect(readPrompt(dialog(["rm -rf /", "───────", "echo done"]))!.key).not.toBe(readPrompt(dialog(["ls", "───────", "echo done"]))!.key);
  });

  it("offers no buttons when the cursor is not on the plain Yes", () => {
    expect(promptChoices(claude.replace(" ❯ 1. Yes", "   1. Yes").replace("   4. No", " ❯ 4. No"))).toBeUndefined();
  });
});

