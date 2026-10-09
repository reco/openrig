// A seat waiting at an interactive prompt (a selection or permission question) for more than
// five minutes gets a notice to its human per prompt episode: the seat, the prompt's question
// and the command to attach, and a reminder each hour the prompt stays. The episode is the same
// prompt body (the question, the command it asks about and its options) seen continuously; a
// different body, or the same one after the seat moved on, is a new episode.

import { createHash } from "node:crypto";
import { classifyPaneActivity } from "./session-transport.js";
import { maskSecrets } from "./credential-mask.js";

export const STUCK_PROMPT_AFTER_MS = 5 * 60_000;
const REMIND_AFTER_MS = 60 * 60_000;
const PROMPT_REASONS = new Set(["selection_prompt", "permission_prompt"]);

export interface StuckPrompt {
  session: string;
  reason: string;
  promptLine: string;
  attach: string;
  waitingMinutes: number;
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

/** The prompt as the seat shows it: its block of text above the options, and the options. */
function promptBody(pane: string, evidence: string): string {
  const lines = pane.split("\n").map((l) => l.trim());
  const at = lines.lastIndexOf(evidence.split("\n")[0]!.trim());
  return lines.slice(Math.max(0, at - 20)).filter(Boolean).join("\n");
}


export interface StuckPromptWatch {
  tick: () => Promise<void>;
  start: (intervalMs?: number) => void;
  stop: () => void;
}

export function makeStuckPromptWatch(deps: StuckPromptWatchDeps): StuckPromptWatch {
  const now = deps.now ?? Date.now;
  const afterMs = deps.afterMs ?? STUCK_PROMPT_AFTER_MS;
  const open = new Map<string, { key: string; since: number; notifiedAt?: number }>();
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
        const key = createHash("sha256").update(`${seen.reason}|${promptBody(pane, String(seen.evidence ?? ""))}`).digest("hex");
        const episode = open.get(session);
        if (!episode || episode.key !== key) { open.set(session, { key, since: now() }); continue; }
        if (episode.notifiedAt === undefined ? now() - episode.since < afterMs : now() - episode.notifiedAt < REMIND_AFTER_MS) continue;
        episode.notifiedAt = now();
        const episodeId = createHash("sha256").update(`${session}|${key}`).digest("hex").slice(0, 20);
        await deps.notify({ session, reason: seen.reason!, promptLine, attach: `tmux attach -t ${session}`, episodeId,
          waitingMinutes: Math.floor((now() - episode.since) / 60_000) });
      }
    },
  };
  return watch;
}
