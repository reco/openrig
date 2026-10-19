// Merge a pull request from Slack. A seat asks with `rig queue create --human-merge owner/repo#123@<sha>`;
// the daemon builds the card itself from GitHub (title, link, head, gates) with Merge / Not now. On
// Merge from the card's human, the daemon re-checks the gates at click time and runs the merge with
// its own gh credentials, pinned to the head the card showed. No agent ever runs the merge.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { QueueRepository } from "./queue-repository.js";
import type { HumanQuestion } from "./human-questions.js";

export interface MergeRef { repo: string; number: number; sha: string }

export type Gh = (args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);
export const defaultGh: Gh = async (args) => (await execFileAsync("gh", args, { timeout: 120_000 })).stdout;

export const HUMAN_MERGE_TAG = "human-merge";
const REF_TAG = "human-merge-ref:";
/** Written by the daemon when it builds a card; only such a card is ever merged. */
export const CARD_NOTE = "human-merge card:";
const RESULT_NOTE = "human-merge result:";
const QUESTION_ID = "merge";

export const MERGE_QUESTION: HumanQuestion = {
  id: QUESTION_ID, question: "Merge this pull request?",
  options: [{ id: "merge", label: "Merge" }, { id: "not_now", label: "Not now" }],
};

export function parseMergeRef(text: string): MergeRef | null {
  const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)@([0-9a-f]{40})$/.exec(text.trim());
  return m ? { repo: m[1]!, number: Number(m[2]), sha: m[3]! } : null;
}

export const formatMergeRef = (ref: MergeRef) => `${ref.repo}#${ref.number}@${ref.sha}`;

interface Check { name: string; outcome: "pass" | "fail" | "pending" }

export interface PrState {
  title: string;
  url: string;
  state: string;
  headRefOid: string;
  isDraft: boolean;
  mergeStateStatus: string;
  checks: Check[];
}

function checkOf(raw: Record<string, unknown>): Check {
  const name = String(raw.name ?? raw.context ?? "check");
  const conclusion = String(raw.conclusion ?? raw.state ?? "").toUpperCase();
  const status = String(raw.status ?? "COMPLETED").toUpperCase();
  if (status !== "COMPLETED" && !raw.context) return { name, outcome: "pending" };
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) return { name, outcome: "pass" };
  if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", ""].includes(conclusion)) return { name, outcome: "pending" };
  return { name, outcome: "fail" };
}

export async function readPr(gh: Gh, ref: { repo: string; number: number }): Promise<PrState> {
  const raw = JSON.parse(await gh(["pr", "view", String(ref.number), "--repo", ref.repo, "--json",
    "title,url,state,headRefOid,isDraft,mergeStateStatus,statusCheckRollup"])) as Record<string, unknown>;
  return {
    title: String(raw.title ?? ""),
    url: String(raw.url ?? ""),
    state: String(raw.state ?? ""),
    headRefOid: String(raw.headRefOid ?? ""),
    isDraft: raw.isDraft === true,
    mergeStateStatus: String(raw.mergeStateStatus ?? "UNKNOWN"),
    checks: (Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup as Array<Record<string, unknown>> : []).map(checkOf),
  };
}

/** Why the pull request may not be merged at the pinned head right now; empty when it may. */
export function gateFailures(pr: PrState, ref: MergeRef): string[] {
  const failures: string[] = [];
  if (pr.state !== "OPEN") failures.push(`it is ${pr.state.toLowerCase()}`);
  if (pr.headRefOid !== ref.sha) failures.push(`its head moved to ${pr.headRefOid.slice(0, 12)} (the card showed ${ref.sha.slice(0, 12)})`);
  if (pr.isDraft) failures.push("it is a draft");
  if (pr.mergeStateStatus !== "CLEAN") failures.push(`GitHub reports it ${pr.mergeStateStatus}, not CLEAN`);
  const failing = pr.checks.filter((c) => c.outcome === "fail").map((c) => c.name);
  const pending = pr.checks.filter((c) => c.outcome === "pending").map((c) => c.name);
  if (failing.length) failures.push(`failing checks: ${failing.join(", ")}`);
  if (pending.length) failures.push(`checks still running: ${pending.join(", ")}`);
  return failures;
}

export function mergeCardBody(pr: PrState, ref: MergeRef): string {
  const passed = pr.checks.filter((c) => c.outcome === "pass").length;
  const others = pr.checks.filter((c) => c.outcome !== "pass").map((c) => `${c.name} ${c.outcome}`);
  const failures = gateFailures(pr, ref);
  return [
    `*${pr.title.replace(/[*_~`]/g, "")}*`,
    `${pr.url}`,
    `Head: \`${ref.sha}\``,
    `Checks: ${passed}/${pr.checks.length} passed${others.length ? ` (${others.join(", ")})` : ""}`,
    `Merge state: ${pr.mergeStateStatus}${pr.isDraft ? " (draft)" : ""}`,
    `Diff: ${pr.url}/files`,
    failures.length ? `Not mergeable now: ${failures.join("; ")}. The gates are checked again when you click Merge.` : "Merge squashes exactly this head; the gates are checked again when you click.",
  ].join("\n");
}

/** The fields of a merge card: the daemon fills them from GitHub, never from the asking seat. */
export async function buildMergeCard(gh: Gh, ref: MergeRef): Promise<{ summary: string; body: string; evidenceRef: string; tags: string[] }> {
  const pr = await readPr(gh, ref);
  return {
    summary: `Merge ${ref.repo}#${ref.number}: ${pr.title}`.slice(0, 200),
    body: mergeCardBody(pr, ref),
    evidenceRef: pr.url,
    tags: [HUMAN_MERGE_TAG, `${REF_TAG}${formatMergeRef(ref)}`],
  };
}

export interface MergeDeps {
  gh: Gh;
  /** Where a successful merge sends its smoke-check row; null sends none. */
  smokeDestination: () => string | null;
  /** The configured human who may approve (the registry's approver), as for permission approvals. */
  approver: () => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

const UNKNOWN_RECHECK_MS = 3_000;
const UNKNOWN_WAIT_MS = 30_000;

/** The pull request once GitHub has settled its merge state: UNKNOWN (recomputing after its base moved, as
 *  right after another merge) is read again every 3 s for up to 30 s; any other state is final. */
async function readSettledPr(deps: MergeDeps, ref: MergeRef): Promise<PrState> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let pr = await readPr(deps.gh, ref);
  for (let waited = 0; pr.mergeStateStatus === "UNKNOWN" && waited < UNKNOWN_WAIT_MS; waited += UNKNOWN_RECHECK_MS) {
    await sleep(UNKNOWN_RECHECK_MS);
    pr = await readPr(deps.gh, ref);
  }
  return pr;
}

/** Act once on each answered merge card the daemon built: Not now declines back to the asking seat;
 *  Merge re-checks the gates and merges the pinned head, or says why not. The result posts in the
 *  card's thread and returns to the seat. */
export async function actOnMergeAnswers(repo: QueueRepository, deps: MergeDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const rows = repo.db.prepare(`SELECT q.qitem_id FROM queue_items q WHERE q.ts_created > ? AND q.tags LIKE '%"${HUMAN_MERGE_TAG}"%'
      AND (q.human_answers LIKE '%"${QUESTION_ID}":"merge"%' OR q.human_answers LIKE '%"${QUESTION_ID}":"not_now"%')
      AND NOT EXISTS (SELECT 1 FROM queue_transitions t WHERE t.qitem_id = q.qitem_id AND t.transition_note LIKE '${RESULT_NOTE}%')`)
    .all(new Date(now() - 7 * 24 * 3600_000).toISOString()) as Array<{ qitem_id: string }>;
  for (const { qitem_id } of rows) {
    const row = repo.getById(qitem_id);
    const choice = row?.humanAnswers?.[QUESTION_ID];
    if (!row || (choice !== "merge" && choice !== "not_now")) continue;
    const transitions = repo.transitionLog.listForQitem(qitem_id);
    if (transitions.some((t) => t.transitionNote?.startsWith(RESULT_NOTE))) continue;
    // Only the daemon's own in-process note counts (an HTTP write always carries an identity provenance),
    // and only on a card addressed to the configured human.
    const card = transitions.find((t) => t.actorSession === "daemon@kernel" && t.identityProvenance === null && t.transitionNote?.startsWith(CARD_NOTE));
    const ref = card ? parseMergeRef(card.transitionNote!.slice(CARD_NOTE.length)) : null;
    if (!ref || !row.tags?.includes(`${REF_TAG}${formatMergeRef(ref)}`)) continue;
    if (row.destinationSession !== deps.approver()) continue;
    // Recorded before acting: a crash between the two never merges twice.
    repo.update({ qitemId: qitem_id, actorSession: "daemon@kernel", transitionNote: `${RESULT_NOTE} ${choice} pending` });
    const name = `${ref.repo}#${ref.number}`;
    let outcome: { note: string; thread: string; seat: string; smoke?: string };
    if (choice === "not_now") {
      outcome = { note: "declined", thread: `Not merged: ${row.destinationSession} chose Not now.`, seat: `Merge of ${name} declined by ${row.destinationSession} (Not now).` };
    } else {
      try {
        const failures = gateFailures(await readSettledPr(deps, ref), ref);
        if (failures.length) {
          outcome = { note: `refused ${failures.join("; ")}`, thread: `Not merged: ${failures.join("; ")}.`, seat: `Merge of ${name} refused at click time: ${failures.join("; ")}.` };
        } else {
          await deps.gh(["pr", "merge", String(ref.number), "--repo", ref.repo, "--squash", "--match-head-commit", ref.sha]);
          const merged = JSON.parse(await deps.gh(["pr", "view", String(ref.number), "--repo", ref.repo, "--json", "mergeCommit"])) as { mergeCommit?: { oid?: string } };
          const sha = merged.mergeCommit?.oid ?? "unknown";
          outcome = { note: `merged ${sha}`, thread: `Merged ${name} as \`${sha}\`.`, seat: `Merged ${name} (head ${ref.sha.slice(0, 12)}) as ${sha}.`, smoke: sha };
        }
      } catch (e) {
        const detail = String((e as { stderr?: string }).stderr || (e as Error).message).trim().slice(0, 500);
        outcome = { note: `failed ${detail}`, thread: `Not merged: the merge failed: ${detail}`, seat: `Merge of ${name} failed: ${detail}` };
      }
    }
    repo.update({ qitemId: qitem_id, actorSession: "daemon@kernel", transitionNote: `${RESULT_NOTE} ${outcome.note}` });
    deps.log?.(`${name}: ${outcome.note}`);
    await repo.create({ sourceSession: row.sourceSession, destinationSession: row.destinationSession, humanIntent: "update", replyTo: qitem_id,
      summary: outcome.thread.slice(0, 120), body: outcome.thread, nudge: false });
    await repo.create({ sourceSession: "daemon@kernel", destinationSession: row.sourceSession, summary: outcome.seat.slice(0, 200), body: outcome.seat, tags: [HUMAN_MERGE_TAG, "human-merge-result"], nudge: true });
    const smoke = outcome.smoke ? deps.smokeDestination() : null;
    if (outcome.smoke && smoke) {
      await repo.create({ sourceSession: "daemon@kernel", destinationSession: smoke, summary: `Smoke-check ${name} merged as ${outcome.smoke.slice(0, 12)}`,
        body: `${name} was merged from Slack as ${outcome.smoke} (head ${ref.sha}). Run the smoke check for it and report the result.`, tags: [HUMAN_MERGE_TAG, "smoke-check"], nudge: true });
    }
  }
}
