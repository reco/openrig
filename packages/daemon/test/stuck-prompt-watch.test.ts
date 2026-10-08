import { describe, expect, it } from "vitest";
import { makeStuckPromptWatch, type StuckPrompt } from "../src/domain/stuck-prompt-watch.js";

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
});
