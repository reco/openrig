// A seat waiting at an interactive prompt (a selection or permission question) for more than
// five minutes gets ONE notice to its human per prompt episode: the seat, the prompt's first
// line and the command to attach. The episode is the same prompt seen continuously; a new
// prompt, or the same one after the seat moved on, is a new episode.

import { createHash } from "node:crypto";
import { classifyPaneActivity } from "./session-transport.js";
import { maskSecrets } from "./credential-mask.js";

export const STUCK_PROMPT_AFTER_MS = 5 * 60_000;
const PROMPT_REASONS = new Set(["selection_prompt", "permission_prompt"]);

export interface StuckPrompt {
  session: string;
  reason: string;
  promptLine: string;
  attach: string;
  /** Same seat and same prompt: the notifier skips one already sent recently (a restart). */
  episodeId: string;
}

export interface StuckPromptWatchDeps {
  runningSessions: () => string[];
  capture: (session: string) => Promise<string | null>;
  notify: (prompt: StuckPrompt) => Promise<void>;
  now?: () => number;
  afterMs?: number;
}

const OPTION_LINE = /^\s*[❯›]?\s*\d+\.\s/;

/** The question above the prompt's options (the nearest line ending in '?', else the nearest
 *  text line), with credentials masked: it may quote the command being approved. */
function questionLine(pane: string, evidence: string): string {
  const lines = pane.split("\n").map((l) => l.trim());
  const at = lines.lastIndexOf(evidence.split("\n")[0]!.trim());
  const above = at > 0 ? lines.slice(Math.max(0, at - 8), at).reverse().filter((l) => l && !OPTION_LINE.test(l) && !/^[─━-]+$/.test(l)) : [];
  return maskSecrets(above.find((l) => l.endsWith("?")) ?? above[0] ?? evidence.split("\n")[0]!.trim());
}



export interface StuckPromptWatch {
  tick: () => Promise<void>;
  start: (intervalMs?: number) => void;
  stop: () => void;
}

export function makeStuckPromptWatch(deps: StuckPromptWatchDeps): StuckPromptWatch {
  const now = deps.now ?? Date.now;
  const afterMs = deps.afterMs ?? STUCK_PROMPT_AFTER_MS;
  const open = new Map<string, { key: string; since: number; notified: boolean }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  const watch: StuckPromptWatch = {
    start(intervalMs = 60_000) {
      timer ??= setInterval(() => {
        if (ticking) return;
        ticking = true;
        void watch.tick().catch(() => {}).finally(() => { ticking = false; });
      }, intervalMs);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = undefined; },
    async tick() {
      const sessions = deps.runningSessions();
      for (const gone of [...open.keys()].filter((s) => !sessions.includes(s))) open.delete(gone);
      for (const session of sessions) {
        const pane = await deps.capture(session).catch(() => null);
        if (pane === null) continue; // an unreadable pane says nothing about the prompt; keep the episode
        const seen = classifyPaneActivity(pane);
        if (seen.state !== "attention" || !PROMPT_REASONS.has(seen.reason ?? "")) { open.delete(session); continue; }
        const promptLine = questionLine(pane, String(seen.evidence ?? ""));
        const key = `${seen.reason}|${promptLine}`;
        const episode = open.get(session);
        if (!episode || episode.key !== key) { open.set(session, { key, since: now(), notified: false }); continue; }
        if (episode.notified || now() - episode.since < afterMs) continue;
        episode.notified = true;
        const episodeId = createHash("sha256").update(`${session}|${key}`).digest("hex").slice(0, 20);
        await deps.notify({ session, reason: seen.reason!, promptLine, attach: `tmux attach -t ${session}`, episodeId });
      }
    },
  };
  return watch;
}
