import { describe, expect, it } from "vitest";
import { answerPrompt, makeStuckPromptWatch, promptBlock, promptCardBody, promptChoices, readPrompt, type StuckPrompt } from "../src/domain/stuck-prompt-watch.js";
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

  it("a requested card is posted at once for an answerable prompt, carrying who asked and why", async () => {
    let t = 0;
    const sent: StuckPrompt[] = [];
    const watch = makeStuckPromptWatch({ runningSessions: () => ["cfo@finance"], capture: async () => claude, notify: async (p) => { sent.push(p); return { qitemId: "q1" }; }, now: () => t });
    expect(await watch.requestCard("cfo@finance", { by: "advisor-lead@kernel", reason: "safe touch in its own worktree" })).toEqual({ outcome: "posted", qitemId: "q1" });
    expect(sent[0]).toMatchObject({ session: "cfo@finance", key: readPrompt(claude)!.key, choices: { allow: { key: "1" }, deny: { key: "4" } },
      requestedBy: "advisor-lead@kernel", requestReason: "safe touch in its own worktree" });
    await watch.tick(); t = 6 * 60_000; await watch.tick();
    expect(sent).toHaveLength(1);
  });

  it("a requested card is refused for a non-seat, a pane at no prompt, or a prompt without a plain Yes/No in full view", async () => {
    let pane = "✻ Working… (esc to interrupt)";
    const sent: StuckPrompt[] = [];
    const watch = makeStuckPromptWatch({ runningSessions: () => ["cfo@finance"], capture: async () => pane, notify: async (p) => { sent.push(p); return { qitemId: "q1" }; } });
    const ask = (s: string) => watch.requestCard(s, { by: "advisor-lead@kernel", reason: "r" });
    expect(await ask("other@rig")).toEqual({ outcome: "not-a-seat" });
    expect(await ask("cfo@finance")).toEqual({ outcome: "no-prompt" });
    pane = ["Which color?", "❯ 1. Red", "  2. Blue"].join("\n");
    expect(await ask("cfo@finance")).toEqual({ outcome: "not-answerable" });
    pane = "─".repeat(80) + "\n" + [" Bash command", "", ...Array.from({ length: 70 }, (_, i) => `   echo ${i}`), "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", ""].join("\n");
    expect(await ask("cfo@finance")).toEqual({ outcome: "not-answerable" });
    expect(sent).toHaveLength(0);
  });

  const webSearch = claude.replace(/ Bash command[\s\S]*?(?= Do you want to proceed\?)/, " Tool use\n\n   WebSearch(query: \"r2 pricing class a operations\")\n   Claude wants to search the web for: r2 pricing class a operations\n\n")
    .replace(/ ❯ 1\. Yes[\s\S]*?4\. No/, " ❯ 1. Yes\n   2. Yes, and don't ask again for WebSearch\n   3. No, and tell Claude what to do differently (esc)");

  it("each answerable prompt gets its own card on the second scan: a Bash dialog, then a WebSearch dialog right after", async () => {
    let t = 0;
    let pane = claude;
    const sent: StuckPrompt[] = [];
    const watch = makeStuckPromptWatch({ runningSessions: () => ["advisor-lead@kernel"], capture: async () => pane, notify: async (p) => { sent.push(p); }, now: () => t });
    await watch.tick();
    t = 15_000; await watch.tick();
    expect(sent.map((p) => p.choices?.allow.key)).toEqual(["1"]);
    pane = webSearch; t = 30_000; await watch.tick();
    t = 45_000; await watch.tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ choices: { allow: { key: "1" }, deny: { key: "3" } }, since: 30_000 });
    expect(sent[1]!.dialog).toContain("WebSearch");
    expect(sent[1]!.key).not.toBe(sent[0]!.key);
  });

  it("a prompt the seat's hook holds in Slack gets no second card; when the hook's request closes, the card follows on the next scan", async () => {
    let t = 0;
    let held = true;
    const sent: StuckPrompt[] = [];
    const watch = makeStuckPromptWatch({ runningSessions: () => ["advisor-lead@kernel"], capture: async () => claude, notify: async (p) => { sent.push(p); }, now: () => t, heldByHook: (_s, dialog) => held && dialog.includes("touch digit-probe-1.txt") });
    await watch.tick(); t = 15_000; await watch.tick(); t = 600_000; await watch.tick();
    expect(sent).toHaveLength(0);
    expect(await watch.requestCard("advisor-lead@kernel", { by: "operator-agent@kernel", reason: "r" })).toEqual({ outcome: "already-posted" });
    held = false; t = 615_000; await watch.tick();
    expect(sent).toHaveLength(1);
  });

  it("the same prompt shown again after the seat moved on is a new episode with its own start", async () => {
    let t = 0;
    let pane = claude;
    const sent: StuckPrompt[] = [];
    const watch = makeStuckPromptWatch({ runningSessions: () => ["advisor-lead@kernel"], capture: async () => pane, notify: async (p) => { sent.push(p); }, now: () => t });
    await watch.tick(); t = 15_000; await watch.tick();
    pane = "✻ Working… (esc to interrupt)"; t = 30_000; await watch.tick();
    pane = claude; t = 45_000; await watch.tick(); t = 60_000; await watch.tick();
    expect(sent.map((p) => p.since)).toEqual([0, 45_000]);
  });

  it("the same prompt asked again before the next scan, after its answer was typed, is a new episode with its own card", async () => {
    let t = 0;
    const sent: StuckPrompt[] = [];
    const watch = makeStuckPromptWatch({ runningSessions: () => ["advisor-lead@kernel"], capture: async () => claude, notify: async (p) => { sent.push(p); }, now: () => t });
    await watch.tick(); t = 15_000; await watch.tick();
    t = 20_000; watch.forget("advisor-lead@kernel");
    t = 30_000; await watch.tick(); t = 45_000; await watch.tick();
    expect(sent.map((p) => p.since)).toEqual([0, 30_000]);
  });

  it("a requested card that fails leaves the prompt to the next scans", async () => {
    let t = 0;
    let fail = true;
    const sent: StuckPrompt[] = [];
    const watch = makeStuckPromptWatch({ runningSessions: () => ["cfo@finance"], capture: async () => claude, now: () => t,
      notify: async (p) => { if (fail) throw new Error("db busy"); sent.push(p); } });
    await expect(watch.requestCard("cfo@finance", { by: "advisor-lead@kernel", reason: "r" })).rejects.toThrow("db busy");
    fail = false;
    await watch.tick(); t = 15_000; await watch.tick();
    expect(sent).toHaveLength(1);
  });

  it("a notice that fails is logged and posted on the next scan, and the other seats are still scanned", async () => {
    let t = 0;
    let fail = true;
    const sent: string[] = [];
    const logs: string[] = [];
    const watch = makeStuckPromptWatch({ runningSessions: () => ["a@rig", "b@rig"], capture: async () => claude, now: () => t, log: (m) => logs.push(m),
      notify: async (p) => { if (fail && p.session === "a@rig") throw new Error("slack down"); sent.push(p.session); } });
    await watch.tick(); t = 15_000; await watch.tick();
    expect(sent).toEqual(["b@rig"]);
    expect(logs).toEqual(["notice for a@rig failed, retrying next scan: slack down"]);
    fail = false; t = 30_000; await watch.tick();
    expect(sent).toEqual(["b@rig", "a@rig"]);
  });

  it("a requested card says so when one for the same prompt is already with the human", async () => {
    const watch = makeStuckPromptWatch({ runningSessions: () => ["cfo@finance"], capture: async () => claude, notify: async () => ({ skipped: "recent" as const }) });
    expect(await watch.requestCard("cfo@finance", { by: "advisor-lead@kernel", reason: "r" })).toEqual({ outcome: "already-posted" });
  });

  it("each tick reports what every readable seat shows, so notices for prompts no longer in view can be retired", async () => {
    let pane: string | null = claude;
    const reports: Array<{ running: string[]; shown: Array<[string, string | null]> }> = [];
    const watch = makeStuckPromptWatch({ runningSessions: () => ["cfo@finance", "dev@rig"], capture: async (s) => (s === "dev@rig" ? "✻ Working…" : pane), notify: async () => {},
      retire: (running, shown) => { reports.push({ running, shown: [...shown] }); } });
    await watch.tick();
    pane = null; await watch.tick();
    expect(reports).toEqual([
      { running: ["cfo@finance", "dev@rig"], shown: [["cfo@finance", readPrompt(claude)!.key], ["dev@rig", null]] },
      { running: ["cfo@finance", "dev@rig"], shown: [["dev@rig", null]] },
    ]);
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

  it("offers no buttons when the dialog's top is cut off (a command longer than the window)", () => {
    const long = [" Bash command", "", ...Array.from({ length: 70 }, (_, i) => `   echo ${i}`), "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", ""].join("\n");
    expect(readPrompt("─".repeat(80) + "\n" + long)!.choices).toBeUndefined();
  });

  it("offers no buttons when the cursor is not on the plain Yes", () => {
    expect(promptChoices(claude.replace(" ❯ 1. Yes", "   1. Yes").replace("   4. No", " ❯ 4. No"))).toBeUndefined();
  });

  it("the notice shows what the prompt runs, credentials masked; a dialog too long to show in full gets no buttons", () => {
    const dialog = (command: string[]) => ["─".repeat(80), " Bash command", "", ...command.map((l) => `   ${l}`), "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", ""].join("\n");
    const shown = readPrompt(dialog(["API_TOKEN=s3cr3tvalue123 ./deploy --env prod"]))!;
    expect(shown.choices).toBeDefined();
    const block = promptBlock(shown);
    expect(block).toContain("./deploy --env prod");
    expect(block).toContain("Do you want to proceed?");
    expect(block).not.toContain("s3cr3tvalue123");
    expect(block.startsWith("```\n")).toBe(true);
    const long = readPrompt(dialog(Array.from({ length: 40 }, (_, i) => `echo this is line number ${i} of a long generated deployment script`)))!;
    expect(long.dialogCut).toBe(true);
    expect(long.choices).toBeUndefined();
    expect(long.dialog).toContain("(earlier lines cut)");
    expect(long.dialog).toContain("line number 39");
    expect(long.dialog).toContain("Do you want to proceed?");
  });

  it("an unbordered dialog under a long scrollback shows its question, not the top of the scrollback", () => {
    const pane = [...Array.from({ length: 50 }, (_, i) => `⏺ Bash(rig queue show row-${i} --json) scrollback output line ${i} with enough text to fill`),
      " Bash command", "   rm -rf build/cache", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", ""].join("\n");
    const shown = readPrompt(pane)!;
    expect(shown.dialog).toContain("rm -rf build/cache");
    expect(shown.dialog).toContain("Do you want to proceed?");
  });
});


describe("prompt card text", () => {
  const prompt: StuckPrompt = { session: "dev@rig", reason: "permission_prompt", promptLine: "Do you want to proceed?", attach: "tmux attach -t dev@rig", waitingMinutes: 6, episodeId: "e", key: "k",
    choices: { allow: { key: "1", label: "Yes" }, deny: { key: "3", label: "No" } } };

  it("a requested card ends with the requester's reason on its own line, right above the buttons", () => {
    const body = promptCardBody({ ...prompt, requestedBy: "advisor-lead@kernel", requestReason: "read-only git status\n in the worktree" });
    expect(body.split("\n").at(-1)).toBe("*Why advisor-lead@kernel asks:* read-only git status in the worktree");
    expect(body).toContain('Approve selects "Yes" in the terminal, Deny selects "No"');
    expect(body).not.toContain("Waiting for");
  });

  it("a card the watch posts says how long the prompt has waited and carries no reason", () => {
    const body = promptCardBody(prompt);
    expect(body).toContain("Waiting for 6 minutes. Attach: `tmux attach -t dev@rig`");
    expect(body).not.toContain("asks:");
  });
});
