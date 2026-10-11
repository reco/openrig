import { Command } from "commander";

type PromptCardResult = { outcome: string; qitemId?: string; error?: string; message?: string };

const REFUSALS: Record<string, string> = {
  "not-a-seat": "is not a running tmux seat of this daemon",
  unreadable: "pane could not be read",
  "no-prompt": "is not at a prompt",
  "not-answerable": "prompt has no plain Yes/No in full view; answer it in the terminal",
  "no-human": "has no registered human to send the card to",
};

export function promptCardCommand(): Command {
  return new Command("prompt-card")
    .description("Send the registered human an Approve/Deny card for a seat's current prompt now, instead of after five minutes")
    .argument("<seat>", "Canonical session name of the seat at the prompt")
    .requiredOption("--reason <text>", "Why the human should look at it now (shown on the card)")
    .option("--json", "Print the daemon's result as JSON")
    .action(async (seat: string, opts: { reason: string; json?: boolean }) => {
      const { DaemonClient } = await import("../client.js");
      const res = await new DaemonClient().post<PromptCardResult>("/api/prompt-card", { session: seat, reason: opts.reason });
      const data = res.data;
      if (opts.json) console.log(JSON.stringify(data));
      else if (data.outcome === "posted") console.log(`Card sent for ${seat}'s prompt: ${data.qitemId}`);
      else if (data.outcome === "already-posted") console.log(`A card for ${seat}'s current prompt is already with the human.`);
      else console.error(`refused: ${seat} ${REFUSALS[data.outcome] ?? data.message ?? data.error ?? data.outcome}`);
      if (res.status >= 400) process.exitCode = 1;
    });
}
