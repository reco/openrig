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
  let selected: string | undefined;
  for (const line of pane.split("\n").slice(-20)) {
    const m = CHOICE_LINE.exec(line);
    if (!m) continue;
    options.set(m[1]!, m[2]!.replace(/\s*\([a-z]+\)$/i, ""));
    if (/^\s*[❯›]/.test(line)) selected = m[1];
  }
  const allow = [...options].filter(([, label]) => /^yes(, proceed)?$/i.test(label));
  const deny = [...options].filter(([, label]) => /^no\b/i.test(label));
  // The cursor still on the plain Yes: a digit then picks an option rather than typing into a text row.
  if (allow.length !== 1 || deny.length !== 1 || selected !== allow[0]![0]) return undefined;
  return { allow: { key: allow[0]![0], label: allow[0]![1] }, deny: { key: deny[0]![0], label: deny[0]![1] } };
}

/** What the pane shows now: the prompt's reason, fingerprint, question and choices, or null when
 *  it is not at a prompt. The same reading names an episode and checks it before an answer. */
export function readPrompt(pane: string): { reason: string; key: string; promptLine: string; choices?: PromptChoices } | null {
  const seen = classifyPaneActivity(pane);
  if (seen.state !== "attention" || !PROMPT_REASONS.has(seen.reason ?? "")) return null;
  const evidence = String(seen.evidence ?? "");
  const { body, bordered } = promptBody(pane, evidence);
  const key = createHash("sha256").update(`${seen.reason}|${body}`).digest("hex");
  // Answerable only when the whole dialog is in view: a cut-off top could hide what is being approved.
  return { reason: seen.reason!, key, promptLine: questionLine(pane, evidence), choices: bordered ? promptChoices(pane) : undefined };
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
const DIALOG_BORDER = /^[╭─━]{20,}/;

/** The prompt's text from its dialog's top border (else 60 lines above the options) to the end. The
 *  border starts at the left edge; a rule inside the shown command is indented. */
function promptBody(pane: string, evidence: string): { body: string; bordered: boolean } {
  const raw = pane.split("\n");
  const at = Math.max(0, anchorLine(raw.map((l) => l.trim()), evidence));
  let from = at;
  while (from > Math.max(0, at - 60) && !DIALOG_BORDER.test(raw[from]!)) from--;
  return { body: flat(raw.slice(from).join("")), bordered: DIALOG_BORDER.test(raw[from]!) };
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

export interface AnswerDeps {
  capture: (session: string) => Promise<string | null>;
  sendKey: (session: string, key: string) => Promise<void>;
  /** The pane is in copy-mode or a chooser: a key would not reach the program. */
  inMode: (session: string) => Promise<boolean>;
}

/** Type the chosen option's key, read off the screen now, only while the pane still shows the
 *  prompt the human was asked about. */
export async function answerPrompt(deps: AnswerDeps, session: string, expectedKey: string, choice: "allow" | "deny"): Promise<{ outcome: "sent" | "moved-on" | "pane-busy"; key?: string }> {
  const pane = await deps.capture(session).catch(() => null);
  const prompt = pane === null ? null : readPrompt(pane);
  const option = prompt?.choices?.[choice];
  if (!prompt || prompt.key !== expectedKey || !option || !/^[1-9]$/.test(option.key)) return { outcome: "moved-on" };
  if (await deps.inMode(session)) return { outcome: "pane-busy" };
  await deps.sendKey(session, option.key);
  return { outcome: "sent", key: option.key };
}

const tagValue = (tags: readonly string[] | null | undefined, name: string) => tags?.find((t) => t.startsWith(`${name}:`))?.slice(name.length + 1);

/** A human's Approve / Deny on a stuck-prompt notice is typed into the seat's terminal once, and
 *  only while the same prompt is up; the notice's thread says what happened either way. Only a
 *  notice the daemon itself created counts (a row made over the API carries an identity provenance),
 *  its seat is the row's own source, and the key comes from the screen, never from the row. */
export async function actOnPromptAnswers(repo: QueueRepository, deps: AnswerDeps, now = Date.now()): Promise<void> {
  const rows = repo.db.prepare(`SELECT qitem_id FROM queue_items WHERE ts_created > ? AND tags LIKE '%"stuck-prompt-key:%'`)
    .all(new Date(now - 2 * 3600_000).toISOString()) as Array<{ qitem_id: string }>;
  const answeredKeys = new Set((repo.db.prepare(`SELECT q.tags AS tags FROM queue_items q JOIN queue_transitions t ON t.qitem_id = q.qitem_id
      WHERE q.ts_created > ? AND t.transition_note LIKE 'stuck-prompt answer: % sent%'`).all(new Date(now - 2 * 3600_000).toISOString()) as Array<{ tags: string }>)
    .map((r) => tagValue(JSON.parse(r.tags) as string[], "stuck-prompt-key")));
  for (const { qitem_id } of rows) {
    const row = repo.getById(qitem_id);
    const choice = row?.humanAnswers?.answer;
    if (!row || (choice !== "allow" && choice !== "deny")) continue;
    const transitions = repo.transitionLog.listForQitem(qitem_id);
    if (transitions.some((t) => t.transitionNote?.startsWith("stuck-prompt answer:"))) continue;
    const created = transitions.find((t) => t.transitionNote === "created");
    const session = tagValue(row.tags, "stuck-prompt-session");
    const expected = tagValue(row.tags, "stuck-prompt-key");
    if (!created || created.identityProvenance !== null || !session || session !== row.sourceSession || !expected) continue;
    // Recorded before typing: a crash between the two never types the answer twice.
    repo.update({ qitemId: qitem_id, actorSession: "daemon@kernel", transitionNote: `stuck-prompt answer: ${choice} pending` });
    const result = answeredKeys.has(expected) ? { outcome: "moved-on" as const }
      : await answerPrompt(deps, session, expected, choice).catch((e: Error) => ({ outcome: `failed: ${e.message}` as const, key: undefined }));
    if (result.outcome === "sent") answeredKeys.add(expected);
    repo.update({ qitemId: qitem_id, actorSession: "daemon@kernel", transitionNote: `stuck-prompt answer: ${choice}${result.key ? ` key=${result.key}` : ""} ${result.outcome}` });
    await repo.create({
      sourceSession: row.sourceSession, destinationSession: row.destinationSession, humanIntent: "update", replyTo: qitem_id, nudge: false,
      summary: result.outcome === "sent" ? (choice === "allow" ? "Approved in the terminal" : "Denied in the terminal") : "Nothing typed",
      body: result.outcome === "sent" ? `Selected option ${result.key} in ${session}'s prompt.`
        : result.outcome === "moved-on" ? `Nothing was typed: ${session}'s prompt had already moved on or was answered.`
        : result.outcome === "pane-busy" ? `Nothing was typed: ${session}'s pane is in copy-mode; answer it there: tmux attach -t ${session}`
        : `Nothing was typed into ${session}: ${result.outcome}.`,
    }).catch(() => {});
  }
}
