// A seat waiting at an interactive prompt (a selection or permission question) for more than
// five minutes, or ten seconds when its plain Yes and No can be answered from the card, gets a
// notice to its human per prompt episode, once: the seat, the prompt's question and the command to
// attach. The card stays with the human while the prompt stays; no reminders. The episode is the same
// prompt body (the question, the command it asks about and its options) seen continuously; a
// different body, or the same one after the seat moved on, is a new episode.
// A permission prompt whose plain "Yes" and "No" options can be told apart carries their keys, so
// the human can answer it from the notice: the answer is typed only while that same prompt is up.

import { createHash } from "node:crypto";
import { classifyPaneActivity } from "./session-transport.js";
import { maskSecrets } from "./credential-mask.js";
import type { QueueRepository } from "./queue-repository.js";

export const STUCK_PROMPT_AFTER_MS = 5 * 60_000;
export const ANSWERABLE_PROMPT_AFTER_MS = 10_000;
export const STUCK_PROMPT_SCAN_MS = 15_000;
const PROMPT_REASONS = new Set(["selection_prompt", "permission_prompt"]);

export interface StuckPrompt {
  session: string;
  reason: string;
  promptLine: string;
  attach: string;
  waitingMinutes: number;
  /** Same seat and same prompt: the notifier skips one already sent recently (a restart). */
  episodeId: string;
  /** When this episode was first seen; an answer typed after it ends the episode's cards. */
  since: number;
  /** The prompt's fingerprint, compared again before an answer is typed. */
  key: string;
  /** The keys of its plain "Yes" and "No" options, when both are unambiguous. */
  choices?: PromptChoices;
  /** What the prompt asks about (its dialog text: the command, its description), credentials masked. */
  dialog?: string;
  /** The dialog's start is off screen: it cannot be shown in full, so the card has no buttons. */
  dialogCut?: boolean;
  /** The single shell command the dialog asks to run, read from the runtime's own dialog shape. */
  command?: string | null;
  /** A seat asked for this card before the prompt had waited five minutes, and why. */
  requestedBy?: string;
  requestReason?: string;
}

export type NotifyResult = { qitemId: string } | { skipped: "recent" | "no-human" };

export type PromptCardResult =
  | { outcome: "posted"; qitemId: string }
  | { outcome: "already-posted" | "no-human" | "not-a-seat" | "unreadable" | "no-prompt" | "not-answerable" };

/** The most dialog text a notice shows; a longer one is cut, and a cut prompt gets no buttons. */
export const PROMPT_DIALOG_CAP = 1500;

/** The prompt as the notice shows it: its dialog text in a code block, else its question line. */
const fenced = (text: string) => { const fence = "`".repeat(3); return `${fence}\n${text.split(fence).join("` ` `")}\n${fence}`; };

/** A dialog's first and last lines when it is too long for a card; the whole dialog when it fits. */
export function dialogExcerpt(dialog: string, cap = PROMPT_DIALOG_CAP): string {
  if (dialog.length <= cap) return dialog;
  const lines = dialog.split("\n").map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l));
  return [...lines.slice(0, 3), "…", ...lines.slice(-4)].join("\n");
}

export function promptBlock(p: { dialog?: string; promptLine: string }): string {
  return p.dialog ? fenced(dialogExcerpt(p.dialog)) : p.promptLine;
}

/** The whole dialog for the card's thread, when the card shows only an excerpt. */
export function promptCardDetail(p: { dialog?: string }): string | undefined {
  return p.dialog && p.dialog.length > PROMPT_DIALOG_CAP ? `Full dialog:\n${fenced(p.dialog)}` : undefined;
}

/** A prompt card's text: the prompt, what the buttons do, how to attach, and a requester's reason
 *  on its own last line, right above the buttons. */
export function promptCardBody(p: StuckPrompt): string {
  const buttons = p.choices ? `Approve selects "${p.choices.allow.label}" in the terminal, Deny selects "${p.choices.deny.label}", only while this prompt is still up. `
    : p.dialogCut ? "No buttons: the start of this prompt is off screen, so it cannot be shown in full. "
    : "No buttons: its plain Yes and No options could not be told apart on screen. ";
  const full = promptCardDetail(p) ? "Full dialog in this card's thread. " : "";
  const waiting = p.requestedBy ? "" : `Waiting for ${p.waitingMinutes} minutes. `;
  const reason = p.requestedBy ? `\n\n*Why ${p.requestedBy} asks:* ${String(p.requestReason ?? "").replace(/\s+/g, " ").trim()}` : "";
  return `${promptBlock(p)}\n\n${full}${buttons}${waiting}Attach: \`${p.attach}\`${reason}`;
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
export function readPrompt(pane: string): { reason: string; key: string; promptLine: string; choices?: PromptChoices; dialog: string; dialogCut: boolean; command: string | null } | null {
  const seen = classifyPaneActivity(pane);
  if (seen.state !== "attention" || !PROMPT_REASONS.has(seen.reason ?? "")) return null;
  const evidence = String(seen.evidence ?? "");
  const { body, dialog: text, topKnown } = promptBody(pane, evidence);
  const key = createHash("sha256").update(`${seen.reason}|${body}`).digest("hex");
  const dialog = maskSecrets(text);
  const dialogCut = !topKnown;
  // A dialog too long for the card shows in full in the card's thread, so its buttons stay; one whose
  // start is off screen cannot be shown in full, so it gets none.
  return { reason: seen.reason!, key, promptLine: questionLine(pane, evidence), choices: dialogCut ? undefined : promptChoices(pane), dialog, dialogCut,
    command: dialogCut ? null : promptCommand(pane) };
}

const DASHED_RULE = /^[╌┄]{20,}$/;

/** The single shell command the prompt on screen asks to run, read only from the runtime's own dialog
 *  shape: Claude's Bash dialog shows it alone between two dashed rules above "Do you want to proceed?",
 *  Codex shows it as the `$ ` line after "Would you like to run the following command?". Null otherwise. */
export function promptCommand(pane: string): string | null {
  const lines = pane.split("\n").map((l) => l.trim());
  const asked = lines.lastIndexOf("Do you want to proceed?");
  if (asked > 0 && DASHED_RULE.test(lines[asked - 1]!)) {
    const open = lines.slice(0, asked - 1).map((l) => DASHED_RULE.test(l)).lastIndexOf(true);
    // The header must belong to this dialog: below its top border, not somewhere in the scrollback.
    const top = open > 0 ? lines.slice(0, open).map((l) => DIALOG_BORDER.test(l)).lastIndexOf(true) : -1;
    const header = open > 0 ? lines.slice(0, open).lastIndexOf("Bash command") : -1;
    if (top < 0 || header < top) return null;
    const body = open >= 0 ? lines.slice(open + 1, asked - 1).filter(Boolean) : [];
    return header >= 0 && body.length === 1 ? body[0]! : null;
  }
  const codex = lines.lastIndexOf("Would you like to run the following command?");
  if (codex < 0) return null;
  const run = lines.slice(codex + 1).find((l) => l.startsWith("$ "));
  const options = lines.slice(codex + 1).findIndex((l) => /^[❯›]?\s*1\./.test(l));
  return run && (options < 0 || lines.indexOf(run, codex) < codex + 1 + options) ? run.slice(2).trim() : null;
}

export interface StuckPromptWatchDeps {
  runningSessions: () => string[];
  capture: (session: string) => Promise<string | null>;
  notify: (prompt: StuckPrompt) => Promise<NotifyResult | void>;
  /** Each tick: the running seats, and the prompt key each readable one shows (null: no prompt). */
  retire?: (running: string[], shown: Map<string, string | null>, dialogs: Map<string, string | null>) => void;
  now?: () => number;
  afterMs?: number;
  answerableAfterMs?: number;
  log?: (msg: string) => void;
  /** The seat's own PermissionRequest hook holds an open Slack request: its card is the one. */
  heldByHook?: (session: string, dialog: string | null) => boolean;
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
/** The first line of a runtime's permission dialog, when it has no border on screen. */
const DIALOG_HEADER = /^\s*(?:Bash command|Edit file|Create file|Write file|Read file|Tool use|Fetch|Would you like to run the following command\?)\s*$/;

/** The prompt's text from its dialog's top border (else 60 lines above the options) to the end. The
 *  border starts at the left edge; a rule inside the shown command is indented. */
function promptBody(pane: string, evidence: string): { body: string; dialog: string; topKnown: boolean } {
  const raw = pane.split("\n");
  const at = Math.max(0, anchorLine(raw.map((l) => l.trim()), evidence));
  let from = at;
  while (from > Math.max(0, at - 60) && !DIALOG_BORDER.test(raw[from]!)) from--;
  // The dialog's own start, anywhere on the captured screen: its top border, else its header line.
  let top = at;
  while (top > 0 && !DIALOG_BORDER.test(raw[top]!)) top--;
  let start = DIALOG_BORDER.test(raw[top]!) ? top + 1 : -1;
  for (let i = at; start < 0 && i >= 0; i--) if (DIALOG_HEADER.test(raw[i]!)) start = i;
  // The dialog's text above its options: the command and what it says about it.
  const above = raw.slice(start >= 0 ? start : from);
  const firstOption = above.findIndex((l) => OPTION_LINE.test(l));
  const dialog = (firstOption >= 0 ? above.slice(0, firstOption) : above).map((l) => l.trim())
    .filter((l) => l && !/^[╌─━-]+$/.test(l)).join("\n");
  return { body: flat(raw.slice(from).join("")), dialog, topKnown: start >= 0 };
}

export interface StuckPromptWatch {
  tick: () => Promise<void>;
  start: (intervalMs?: number) => void;
  stop: () => void;
  /** Post the Approve/Deny card for the seat's prompt now, only when its plain Yes and No are in full view. */
  requestCard: (session: string, request: { by: string; reason: string }) => Promise<PromptCardResult>;
  /** An answer was typed into the seat: whatever prompt it shows next, even the same one, is a new episode. */
  forget: (session: string) => void;
}

export function makeStuckPromptWatch(deps: StuckPromptWatchDeps): StuckPromptWatch {
  const now = deps.now ?? Date.now;
  const afterMs = deps.afterMs ?? STUCK_PROMPT_AFTER_MS;
  const answerableAfterMs = deps.answerableAfterMs ?? ANSWERABLE_PROMPT_AFTER_MS;
  const log = deps.log ?? ((m: string) => console.log(`[stuck-prompt] ${m}`));
  const open = new Map<string, { key: string; since: number; notifiedAt?: number }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  const episodeIdOf = (session: string, key: string) => createHash("sha256").update(`${session}|${key}`).digest("hex").slice(0, 20);
  const watch: StuckPromptWatch = {
    start(intervalMs = STUCK_PROMPT_SCAN_MS) {
      timer ??= setInterval(() => {
        if (ticking) return;
        ticking = true;
        void watch.tick().catch((e: Error) => log(`tick failed: ${e.message}`)).finally(() => { ticking = false; });
      }, intervalMs);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = undefined; },
    async tick() {
      const sessions = deps.runningSessions();
      for (const gone of [...open.keys()].filter((s) => !sessions.includes(s))) open.delete(gone);
      const shown = new Map<string, string | null>();
      const dialogs = new Map<string, string | null>();
      for (const session of sessions) {
        const pane = await deps.capture(session).catch(() => null);
        if (pane === null) continue; // an unreadable pane says nothing about the prompt; keep the episode
        const prompt = readPrompt(pane);
        shown.set(session, prompt?.key ?? null);
        dialogs.set(session, prompt?.dialog ?? null);
        if (!prompt) { open.delete(session); continue; }
        const { key, promptLine } = prompt;
        const episode = open.get(session);
        if (!episode || episode.key !== key) { open.set(session, { key, since: now() }); continue; }
        const wait = prompt.choices ? answerableAfterMs : afterMs;
        if (deps.heldByHook?.(session, prompt.choices ? prompt.dialog : null)) continue;
        if (episode.notifiedAt !== undefined || now() - episode.since < wait) continue;
        episode.notifiedAt = now();
        try {
          await deps.notify({ session, reason: prompt.reason, promptLine, attach: `tmux attach -t ${session}`, episodeId: episodeIdOf(session, key), since: episode.since, key, dialog: prompt.dialog, dialogCut: prompt.dialogCut, command: prompt.command,
            ...(prompt.choices ? { choices: prompt.choices } : {}), waitingMinutes: Math.floor((now() - episode.since) / 60_000) });
        } catch (e) {
          episode.notifiedAt = undefined;
          log(`notice for ${session} failed, retrying next scan: ${(e as Error).message}`);
        }
      }
      deps.retire?.(sessions, shown, dialogs);
    },
    async requestCard(session, request) {
      if (!deps.runningSessions().includes(session)) return { outcome: "not-a-seat" };
      const pane = await deps.capture(session).catch(() => null);
      if (pane === null) return { outcome: "unreadable" };
      const prompt = readPrompt(pane);
      if (!prompt) return { outcome: "no-prompt" };
      if (!prompt.choices) return { outcome: "not-answerable" };
      if (deps.heldByHook?.(session, prompt.dialog)) return { outcome: "already-posted" };
      const episode = open.get(session);
      const since = episode?.key === prompt.key ? episode.since : now();
      open.set(session, { key: prompt.key, since, notifiedAt: now() });
      const result = await deps.notify({ session, reason: prompt.reason, promptLine: prompt.promptLine, attach: `tmux attach -t ${session}`,
        episodeId: episodeIdOf(session, prompt.key), since, key: prompt.key, dialog: prompt.dialog, choices: prompt.choices, command: prompt.command,
        waitingMinutes: Math.floor((now() - since) / 60_000), requestedBy: request.by, requestReason: maskSecrets(request.reason).slice(0, 300) })
        .catch((e: Error) => { if (episode) open.set(session, episode); else open.delete(session); throw e; });
      if (result && "qitemId" in result) return { outcome: "posted", qitemId: result.qitemId };
      return { outcome: result?.skipped === "no-human" ? "no-human" : "already-posted" };
    },
    forget(session) { open.delete(session); },
  };
  return watch;
}

export interface AnswerDeps {
  capture: (session: string) => Promise<string | null>;
  sendKey: (session: string, key: string) => Promise<void>;
  /** The pane is in copy-mode or a chooser: a key would not reach the program. */
  inMode: (session: string) => Promise<boolean>;
  onSent?: (session: string) => void;
  /** Saves the rule of an Always approve / Always deny click. */
  saveRule?: (rule: { effect: "allow" | "deny"; match: string; seats: string; note: string }) => void;
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

/** The note a retired card's row carries; the request sweep closes its Slack card with the text after it. */
export const PROMPT_CLEARED_PREFIX = "stuck-prompt cleared: ";

function openPromptNotices(repo: QueueRepository): Array<{ qitemId: string; session: string; key: string | undefined }> {
  const rows = repo.db.prepare(`SELECT qitem_id, tags FROM queue_items WHERE state IN ('pending', 'in-progress', 'blocked') AND tags LIKE '%"stuck-prompt-session:%'`)
    .all() as Array<{ qitem_id: string; tags: string }>;
  return rows.flatMap((r) => {
    const tags = JSON.parse(r.tags) as string[];
    const session = tagValue(tags, "stuck-prompt-session");
    return session ? [{ qitemId: r.qitem_id, session, key: tagValue(tags, "stuck-prompt-key") }] : [];
  });
}

function cancelNotice(repo: QueueRepository, qitemId: string, why: string): void {
  repo.update({ qitemId, actorSession: "daemon@kernel", state: "canceled", transitionNote: `${PROMPT_CLEARED_PREFIX}${why}` });
}

/** Cancel the cards whose prompt is no longer in view: the seat stopped running, or its readable pane
 *  shows no prompt or a different one. A seat whose pane could not be read keeps its card. */
export function retireStalePromptNotices(repo: QueueRepository, running: string[], shown: Map<string, string | null>): string[] {
  const stale = openPromptNotices(repo).filter((n) => !running.includes(n.session) || (shown.has(n.session) && shown.get(n.session) !== n.key));
  for (const n of stale) cancelNotice(repo, n.qitemId, "answered in the terminal");
  return stale.map((n) => n.qitemId);
}

/** A card for this seat's same prompt is with the human already (a restart), so no new one is posted:
 *  one still open, however old, or a notice without buttons from the last 50 minutes. The same prompt
 *  shown again after its card was answered or retired is new. */
export function hasRecentPromptCard(repo: QueueRepository, p: { session: string; key: string }, now = Date.now()): boolean {
  return !!repo.db.prepare(`SELECT 1 FROM queue_items WHERE tags LIKE ? AND tags LIKE ?
      AND (state IN ('pending', 'in-progress', 'blocked') OR (human_intent = 'update' AND state != 'canceled' AND ts_created > ?)) LIMIT 1`)
    .get(`%"stuck-prompt-session:${p.session}"%`, `%"stuck-prompt-key:${p.key}"%`, new Date(now - 50 * 60_000).toISOString());
}

/** Cancel the seat's open cards before a newer one is posted, so only the latest card has buttons. */
export function supersedePromptNotices(repo: QueueRepository, session: string): string[] {
  const earlier = openPromptNotices(repo).filter((n) => n.session === session);
  for (const n of earlier) cancelNotice(repo, n.qitemId, "replaced by a newer card for this seat");
  return earlier.map((n) => n.qitemId);
}

/** A human's Approve / Deny on a stuck-prompt notice is typed into the seat's terminal once, and
 *  only while the same prompt is up; the notice's thread says what happened either way. Only a
 *  notice the daemon itself created counts (a row made over the API carries an identity provenance),
 *  its seat is the row's own source, and the key comes from the screen, never from the row. */
export async function actOnPromptAnswers(repo: QueueRepository, deps: AnswerDeps, now = Date.now()): Promise<void> {
  const rows = repo.db.prepare(`SELECT qitem_id FROM queue_items WHERE ts_created > ? AND tags LIKE '%"stuck-prompt-key:%'`)
    .all(new Date(now - 2 * 3600_000).toISOString()) as Array<{ qitem_id: string }>;
  // The last time each prompt was answered: a card for that prompt's episode started before then types nothing.
  const answeredAt = new Map<string, number>();
  for (const r of repo.db.prepare(`SELECT q.tags AS tags, t.ts AS ts FROM queue_items q JOIN queue_transitions t ON t.qitem_id = q.qitem_id
      WHERE q.ts_created > ? AND t.transition_note LIKE 'stuck-prompt answer: % sent%'`).all(new Date(now - 2 * 3600_000).toISOString()) as Array<{ tags: string; ts: string }>) {
    const tags = JSON.parse(r.tags) as string[];
    const key = `${tagValue(tags, "stuck-prompt-session")}|${tagValue(tags, "stuck-prompt-key")}`;
    answeredAt.set(key, Math.max(answeredAt.get(key) ?? 0, Date.parse(r.ts)));
  }
  for (const { qitem_id } of rows) {
    const row = repo.getById(qitem_id);
    const clicked = row?.humanAnswers?.answer;
    const choice = clicked === "always_allow" ? "allow" : clicked === "always_deny" ? "deny" : clicked;
    if (!row || (choice !== "allow" && choice !== "deny")) continue;
    // A card split over its thread: its buttons count only once every part, the full dialog included, is in Slack.
    if (row.humanDetail && row.deliveryOutcome !== "posted") continue;
    const transitions = repo.transitionLog.listForQitem(qitem_id);
    if (transitions.some((t) => t.transitionNote?.startsWith("stuck-prompt answer:"))) continue;
    const created = transitions.find((t) => t.transitionNote === "created");
    const session = tagValue(row.tags, "stuck-prompt-session");
    const expected = tagValue(row.tags, "stuck-prompt-key");
    if (!created || created.identityProvenance !== null || !session || session !== row.sourceSession || !expected) continue;
    // Recorded before typing: a crash between the two never types the answer twice.
    repo.update({ qitemId: qitem_id, actorSession: "daemon@kernel", transitionNote: `stuck-prompt answer: ${choice} pending` });
    // Always approve / Always deny also saves the rule the card showed, for this seat.
    const always = clicked !== choice ? tagValue(row.tags, "always-rule") : undefined;
    if (always && deps.saveRule) {
      try { deps.saveRule({ effect: choice, match: always, seats: session, note: `saved from Slack for ${session}` }); }
      catch (e) { repo.update({ qitemId: qitem_id, actorSession: "daemon@kernel", transitionNote: `always rule ${always} not saved: ${(e as Error).message}` }); }
    }
    const since = Number(tagValue(row.tags, "stuck-prompt-since") ?? 0);
    const result = (answeredAt.get(`${session}|${expected}`) ?? -1) >= since ? { outcome: "moved-on" as const }
      : await answerPrompt(deps, session, expected, choice).catch((e: Error) => ({ outcome: `failed: ${e.message}` as const, key: undefined }));
    if (result.outcome === "sent") { answeredAt.set(`${session}|${expected}`, now); deps.onSent?.(session); }
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
