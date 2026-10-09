// A seat waiting at an interactive prompt (a selection or permission question) for more than
// five minutes gets a notice to its human per prompt episode: the seat, the prompt's question
// and the command to attach, and a reminder each hour the prompt stays. The episode is the same
// prompt body (the question, the command it asks about and its options) seen continuously; a
// different body, or the same one after the seat moved on, is a new episode.
// A permission prompt whose plain "Yes" and "No" options can be told apart carries their keys, so
// the human can answer it from the notice: the answer is typed only while that same prompt is up.

import { createHash } from "node:crypto";
import { classifyPaneActivity } from "./session-transport.js";
import { maskSecrets } from "./credential-mask.js";
import type { QueueRepository } from "./queue-repository.js";

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
  /** The prompt's fingerprint, compared again before an answer is typed. */
  key: string;
  /** The keys of its plain "Yes" and "No" options, when both are unambiguous. */
  choices?: PromptChoices;
}

export interface PromptChoices { allow: { key: string; label: string }; deny: { key: string; label: string } }

const CHOICE_LINE = /^\s*[❯›]?\s*(\d)\.\s+(.+?)\s*$/;

/** Approve is only the plain "Yes" ("Yes, proceed" in Codex), never one that also changes what is
 *  allowed later ("always", "don't ask again", "switch to auto mode"); Deny is the "No" option. */
export function promptChoices(pane: string): PromptChoices | undefined {
  const options = new Map<string, string>();
  for (const line of pane.split("\n").slice(-20)) {
    const m = CHOICE_LINE.exec(line);
    if (m) options.set(m[1]!, m[2]!.replace(/\s*\([a-z]+\)$/i, ""));
  }
  const allow = [...options].filter(([, label]) => /^yes(, proceed)?$/i.test(label));
  const deny = [...options].filter(([, label]) => /^no\b/i.test(label));
  if (allow.length !== 1 || deny.length !== 1) return undefined;
  return { allow: { key: allow[0]![0], label: allow[0]![1] }, deny: { key: deny[0]![0], label: deny[0]![1] } };
}

/** What the pane shows now: the prompt's reason, fingerprint, question and choices, or null when
 *  it is not at a prompt. The same reading names an episode and checks it before an answer. */
export function readPrompt(pane: string): { reason: string; key: string; promptLine: string; choices?: PromptChoices } | null {
  const seen = classifyPaneActivity(pane);
  if (seen.state !== "attention" || !PROMPT_REASONS.has(seen.reason ?? "")) return null;
  const evidence = String(seen.evidence ?? "");
  const key = createHash("sha256").update(`${seen.reason}|${promptBody(pane, evidence)}`).digest("hex");
  return { reason: seen.reason!, key, promptLine: questionLine(pane, evidence), choices: promptChoices(pane) };
}

export interface StuckPromptWatchDeps {
  runningSessions: () => string[];
  capture: (session: string) => Promise<string | null>;
  notify: (prompt: StuckPrompt) => Promise<void>;
  now?: () => number;
  afterMs?: number;
}

const OPTION_LINE = /^\s*[❯›]?\s*\d+\.\s/;

const flat = (text: string) => text.replace(/[\s│┃╭╮╰╯─━]+/g, "");

/** The pane line the classifier's evidence starts at; evidence is whitespace-compacted and may be cut. */
function anchorLine(lines: string[], evidence: string): number {
  const target = flat(evidence.replace(/\.\.\.$/, ""));
  for (let i = lines.length - 1; i >= 0; i--) if (flat(lines[i]!) && target.startsWith(flat(lines[i]!))) return i;
  return -1;
}

/** The question above the prompt's options (the nearest line ending in '?', else the nearest
 *  text line), with credentials masked: it may quote the command being approved. */
function questionLine(pane: string, evidence: string): string {
  const lines = pane.split("\n").map((l) => l.trim());
  const at = anchorLine(lines, evidence);
  const above = at > 0 ? lines.slice(Math.max(0, at - 8), at).reverse().filter((l) => l && !OPTION_LINE.test(l) && !/^[─━-]+$/.test(l)) : [];
  return maskSecrets(above.find((l) => l.endsWith("?")) ?? above[0] ?? evidence.split("\n")[0]!.trim());
}

/** The prompt as the seat shows it, from its dialog's top rule (else 20 lines above the options)
 *  to the end, with whitespace and frame characters dropped so a resize or reflow is the same prompt. */
function promptBody(pane: string, evidence: string): string {
  const lines = pane.split("\n").map((l) => l.trim());
  const at = Math.max(0, anchorLine(lines, evidence));
  let from = at;
  while (from > Math.max(0, at - 20) && !/^[╭─━]{3,}/.test(lines[from]!)) from--;
  return flat(lines.slice(from).join(""));
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
        const prompt = readPrompt(pane);
        if (!prompt) { open.delete(session); continue; }
        const { key, promptLine } = prompt;
        const episode = open.get(session);
        if (!episode || episode.key !== key) { open.set(session, { key, since: now() }); continue; }
        if (episode.notifiedAt === undefined ? now() - episode.since < afterMs : now() - episode.notifiedAt < REMIND_AFTER_MS) continue;
        episode.notifiedAt = now();
        const episodeId = createHash("sha256").update(`${session}|${key}`).digest("hex").slice(0, 20);
        await deps.notify({ session, reason: prompt.reason, promptLine, attach: `tmux attach -t ${session}`, episodeId, key,
          ...(prompt.choices ? { choices: prompt.choices } : {}), waitingMinutes: Math.floor((now() - episode.since) / 60_000) });
      }
    },
  };
  return watch;
}

/** Type the chosen key only while the pane still shows the prompt the human was asked about. */
export async function answerPrompt(deps: { capture: (session: string) => Promise<string | null>; sendKey: (session: string, key: string) => Promise<void> },
  session: string, expectedKey: string, key: string): Promise<"sent" | "moved-on"> {
  const pane = await deps.capture(session).catch(() => null);
  if (pane === null || readPrompt(pane)?.key !== expectedKey) return "moved-on";
  await deps.sendKey(session, key);
  return "sent";
}

const tagValue = (tags: readonly string[] | null | undefined, name: string) => tags?.find((t) => t.startsWith(`${name}:`))?.slice(name.length + 1);

/** A human's Approve / Deny on a stuck-prompt notice is typed into the seat's terminal once, and
 *  only while the same prompt is up; the notice's thread says what happened either way. */
export async function actOnPromptAnswers(repo: QueueRepository, deps: Parameters<typeof answerPrompt>[0], now = Date.now()): Promise<void> {
  const rows = repo.db.prepare(`SELECT qitem_id FROM queue_items WHERE ts_created > ? AND tags LIKE '%"stuck-prompt-key:%'`)
    .all(new Date(now - 2 * 3600_000).toISOString()) as Array<{ qitem_id: string }>;
  for (const { qitem_id } of rows) {
    const row = repo.getById(qitem_id);
    const choice = row?.humanAnswers?.answer;
    if (!row || (choice !== "allow" && choice !== "deny")) continue;
    if (repo.transitionLog.listForQitem(qitem_id).some((t) => t.transitionNote?.startsWith("stuck-prompt answer:"))) continue;
    const session = tagValue(row.tags, "stuck-prompt-session");
    const key = tagValue(row.tags, `stuck-prompt-${choice}`);
    const expected = tagValue(row.tags, "stuck-prompt-key");
    if (!session || !key || !expected) continue;
    // Recorded before typing: a crash between the two never types the answer twice.
    repo.update({ qitemId: qitem_id, actorSession: "daemon@kernel", transitionNote: `stuck-prompt answer: ${choice} key=${key} pending` });
    const outcome = await answerPrompt(deps, session, expected, key).catch((e: Error) => `failed: ${e.message}`);
    repo.update({ qitemId: qitem_id, actorSession: "daemon@kernel", transitionNote: `stuck-prompt answer: ${choice} key=${key} ${outcome}` });
    await repo.create({
      sourceSession: row.sourceSession, destinationSession: row.destinationSession, humanIntent: "update", replyTo: qitem_id, nudge: false,
      summary: outcome === "sent" ? (choice === "allow" ? "Approved in the terminal" : "Denied in the terminal") : "Nothing typed",
      body: outcome === "sent" ? `Selected option ${key} in ${session}'s prompt.`
        : outcome === "moved-on" ? `Nothing was typed: ${session}'s prompt had already moved on.` : `Nothing was typed into ${session}: ${outcome}.`,
    }).catch(() => {});
  }
}

