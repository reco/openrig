// Available channel history: top-level messages, and replies in the threads OpenRig follows in
// this channel. A seen event is not scanned coverage.
import path from "node:path";
import { callWebApi, type FetchImpl } from "./slack-api.js";
import { ingestDecision, type InboundRouter, type SlackEvent } from "./inbound.js";
import { ChannelCoverageStore, slackMicros, slackTimestamp, type ChannelCoverage } from "./state-store.js";

interface RecoveryOptions {
  channel: string | null;
  token: string | null;
  stateDir: string;
  router: InboundRouter;
  fetchImpl?: FetchImpl;
  store?: ChannelCoverageStore;
  now?: () => number;
  /** Roots of the threads OpenRig follows in this channel (their replies are recovered too). */
  threadRoots?: () => string[];
}

/** Slack says the root is gone: nothing more to read there. */
const DELETED_ROOT_ERRORS = new Set(["thread_not_found", "message_not_found"]);
/** The app cannot read the thread: a capability fault, retried every pass and never covered. */
const CAPABILITY_ERRORS = new Set(["missing_scope", "not_in_channel", "channel_not_found", "invalid_auth", "token_revoked", "account_inactive"]);

/** One owner across socket generations. Stop fences admission and checkpoint writes;
 * already admitted I/O remains owned until it settles (no timeout/unlock race). */
const REPLIES_CALL_MS = 5000;

export class ChannelRecovery {
  private readonly store: ChannelCoverageStore;
  private readonly now: () => number;
  private coverage?: ChannelCoverage;
  private pass?: Promise<void>;
  private stopped = false;
  /** Per root, the settled bound of its last read attempt this process: a failed root waits its turn too. */
  private readonly attempted = new Map<string, bigint>();
  private state = "not-started";
  private reason: string | undefined;
  private lastScanAt: string | undefined;
  private accepted = 0;
  private deadLettered = 0;

  constructor(private readonly opts: RecoveryOptions) {
    this.now = opts.now ?? Date.now;
    this.store = opts.store ?? new ChannelCoverageStore(path.join(opts.stateDir, "slack-channel-coverage.json"));
  }

  initialize(): void {
    if (!this.opts.channel) { this.state = "unavailable"; this.reason = "channel-not-configured"; return; }
    try {
      this.coverage = this.store.initialize(this.opts.channel, slackTimestamp(BigInt(this.now()) * 1000n),
        path.join(this.opts.stateDir, "slack-inbound-seen.jsonl"), path.join(this.opts.stateDir, "slack-inbound-receipts.jsonl"));
      this.state = this.opts.token ? "pending" : "unavailable";
      this.reason = this.opts.token ? undefined : "bot-token-unresolved";
    } catch { this.state = "unavailable"; this.reason = "checkpoint-unreadable-or-unwritable"; }
  }

  status() {
    return { state: this.state, reason: this.reason, channel: this.opts.channel, lastScanAt: this.lastScanAt,
      coverage: this.coverage ? structuredClone(this.coverage) : null,
      threads: this.coverage?.threads ? { followed: Object.keys(this.coverage.threads.roots).length, degraded: this.coverage.threads.degraded ?? {}, nextRetryAt: this.coverage.threads.nextRetryAt ?? null } : null,
      acceptedThisProcess: this.accepted, deadLetteredThisProcess: this.deadLettered,
      limits: ["older history unknown", "counts reset on connector rewire/restart", "top-level messages, and replies per followed thread with its own watermark",
        "threads opened more than seven days ago are not followed",
        ...(this.coverage?.historyLimited ? ["Slack plan limit excludes older history; only available messages were scanned"] : []),
        "coverage means scanned available history; dead letters are custody, not delivery",
        "five-second settle margin; larger clock skew or history visibility lag remains unverified",
        "four pages / 100 entries / 15 seconds admission per pass; no global chronological ordering"] };
  }

  stop(): void { this.stopped = true; this.state = "stopped"; }

  run(): Promise<void> {
    if (this.pass) return this.pass;
    if (this.stopped || !this.coverage || !this.opts.token || !this.opts.channel) return Promise.resolve();
    const pass = this.scan().catch(() => {
      if (!this.stopped) { this.state = "incomplete"; this.reason = "storage-or-routing-failed"; }
    });
    this.pass = pass;
    void pass.finally(() => { if (this.pass === pass) this.pass = undefined; });
    return pass;
  }

  private save(next: ChannelCoverage): void {
    if (this.stopped) return;
    this.store.save(this.opts.channel!, next);
    this.coverage = next; // publish only after the atomic write succeeds
  }

  private async scan(): Promise<void> {
    const deadline = this.now() + 15_000;
    this.lastScanAt = new Date(this.now()).toISOString();
    // Reply tracking starts where top-level coverage stands now, before this pass advances it.
    if (this.opts.threadRoots && !this.coverage!.threads) this.save({ ...this.coverage!, threads: { since: this.coverage!.coveredThrough, roots: {} } });
    await this.scanHistory(deadline);
    if (!this.stopped && this.opts.threadRoots) await this.sweepThreads(deadline);
  }

  /** Replies in each followed thread, from that thread's own watermark to the settled upper bound.
   *  A thread that fails keeps its watermark (retried next pass) while the others advance; top-level
   *  coverage is independent. Progress is saved after every thread, so a restart resumes. */
  private async sweepThreads(deadline: number): Promise<void> {
    const upper = slackTimestamp(BigInt(Math.max(0, this.now() - 5000)) * 1000n);
    const base = this.coverage!.threads!;
    if (base.nextRetryAt && base.nextRetryAt > this.now()) return;
    const followed = this.opts.threadRoots!();
    const deleted = new Set(base.deleted ?? []);
    const roots: Record<string, string> = Object.fromEntries(Object.entries(base.roots).filter(([root]) => followed.includes(root)));
    const degraded: Record<string, string> = Object.fromEntries(Object.entries(base.degraded ?? {}).filter(([root]) => followed.includes(root)));
    const floor = (root: string) => roots[root] ?? (slackMicros(root)! > slackMicros(base.since)! ? root : base.since);
    const behind = (root: string) => slackMicros(floor(root))!;
    // Least recently visited first, whether the last visit succeeded or failed: every root gets its
    // turn, so neither healthy nor failing threads can be starved when a pass cannot reach them all.
    const turn = (root: string) => { const tried = this.attempted.get(root) ?? 0n; return tried > behind(root) ? tried : behind(root); };
    const todo = followed.filter((root) => !deleted.has(root) && slackMicros(root) !== null && behind(root) < slackMicros(upper)!)
      .sort((a, b) => (turn(a) < turn(b) ? -1 : turn(a) > turn(b) ? 1 : 0));
    const persist = (extra: Partial<typeof base> = {}) =>
      this.save({ ...this.coverage!, threads: { since: base.since, roots, deleted: [...deleted].filter((r) => followed.includes(r)), degraded, ...extra } });
    for (const root of todo) {
      if (this.stopped || this.now() > deadline - REPLIES_CALL_MS) return;
      this.attempted.set(root, slackMicros(upper)!);
      const from = slackMicros(floor(root))!;
      const read = await this.readReplies(root, from, upper, deadline);
      if (this.stopped) return;
      if (read.kind === "deleted") { deleted.add(root); delete roots[root]; delete degraded[root]; persist(); continue; }
      if (read.kind === "capability") { degraded[root] = read.error; persist(); continue; }
      if (read.kind === "out-of-budget") return;
      if (read.kind === "rate-limited") { persist({ nextRetryAt: this.now() + read.retryAfterSeconds * 1000 }); return; }
      if (read.kind === "failed") { degraded[root] = `transient: ${read.error}`; persist(); continue; }
      for (const message of read.replies) {
        const ev = { ...message, channel: this.opts.channel!, thread_ts: root, recoveredAfterGap: true } as SlackEvent;
        if (!ingestDecision(ev).ingest) continue;
        const landed = await this.opts.router.route(ev, 0, () => !this.stopped);
        if (this.stopped) return;
        if (landed.reason === "inflight" || landed.reason === "inactive") return;
        if (landed.disposition === "accepted") this.accepted++;
        if (landed.disposition === "dead-lettered") this.deadLettered++;
        if (this.now() >= deadline) { roots[root] = slackTimestamp(slackMicros(message.ts)! + 1n); persist(); return; }
      }
      roots[root] = read.through;
      delete degraded[root];
      persist();
    }
  }

  /** Every reply page of one thread in [from, upper); a typed outcome, never a thrown failure. */
  private async readReplies(root: string, from: bigint, upper: string, deadline: number): Promise<
    | { kind: "ok"; replies: SlackEvent[]; through: string } | { kind: "deleted" } | { kind: "out-of-budget" } | { kind: "capability"; error: string }
    | { kind: "rate-limited"; retryAfterSeconds: number } | { kind: "failed"; error: string }> {
    const replies: SlackEvent[] = [];
    let cursor = "";
    let pages = 0;
    do {
      // A call starts only with its full timeout left, so the pass budget never cuts one short into a failure.
      if (this.now() > deadline - REPLIES_CALL_MS) { if (!replies.length) return { kind: "out-of-budget" }; break; }
      const r = await callWebApi("conversations.replies", this.opts.token!, {
        channel: this.opts.channel, ts: root, oldest: slackTimestamp(from > 0n ? from - 1n : 0n), latest: upper, inclusive: false, limit: 100,
        ...(cursor ? { cursor } : {}),
      }, this.opts.fetchImpl, REPLIES_CALL_MS, "get-query");
      if (!r.ok) {
        if (r.status === 429 || r.error === "ratelimited") return { kind: "rate-limited", retryAfterSeconds: r.retryAfterSeconds ?? 30 };
        if (DELETED_ROOT_ERRORS.has(r.error ?? "")) return { kind: "deleted" };
        if (CAPABILITY_ERRORS.has(r.error ?? "")) return { kind: "capability", error: r.error! };
        return { kind: "failed", error: r.error ?? `http ${r.status}` };
      }
      const page = r.json.messages;
      if (!Array.isArray(page) || page.some((m) => !m || typeof m !== "object" || slackMicros((m as SlackEvent).ts) === null)) {
        return { kind: "failed", error: "invalid-replies-page" };
      }
      replies.push(...(page as SlackEvent[]));
      const next = (r.json.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
      cursor = typeof next === "string" ? next : "";
    } while (cursor && ++pages < 10);
    const upperMicros = slackMicros(upper)!;
    const sorted = replies
      .filter((m) => m.ts !== root && slackMicros(m.ts)! >= from && slackMicros(m.ts)! < upperMicros)
      .sort((a, b) => (slackMicros(a.ts)! < slackMicros(b.ts)! ? -1 : 1));
    // Pages run oldest first; a thread longer than the page cap resumes after its last reply read.
    const lastRead = replies.reduce((max, m) => (slackMicros(m.ts)! > max ? slackMicros(m.ts)! : max), from - 1n) + 1n;
    const through = cursor && lastRead < upperMicros ? slackTimestamp(lastRead) : upper;
    return { kind: "ok", replies: sorted, through };
  }

  private async scanHistory(deadline: number): Promise<void> {
    if (this.coverage!.nextRetryAt && this.coverage!.nextRetryAt > this.now()) { this.state = "backoff"; return; }
    this.state = "scanning"; this.reason = undefined;
    if (!this.coverage!.pending) {
      // Leave recent posts for the next interval so ordinary visibility lag/clock skew
      // does not mark their timestamps covered before history can expose them.
      const upper = slackTimestamp(BigInt(Math.max(0, this.now() - 5000)) * 1000n);
      if (slackMicros(upper)! <= slackMicros(this.coverage!.coveredThrough)!) { this.state = "pending"; return; }
      this.save({ ...this.coverage!, nextRetryAt: undefined, pending: { upper, nextLatest: upper } });
    }
    let entries = 0;
    for (let pages = 0; pages < 4 && !this.stopped && this.now() < deadline; pages++) {
      const c = { ...this.coverage! };
      const lower = slackMicros(c.coveredThrough)!;
      const latest = slackMicros(c.pending!.nextLatest)!;
      const r = await callWebApi("conversations.history", this.opts.token!, {
        channel: this.opts.channel, oldest: slackTimestamp(lower > 0n ? lower - 1n : 0n),
        latest: c.pending!.nextLatest, inclusive: false, limit: Math.min(25, 100 - entries),
      }, this.opts.fetchImpl, Math.min(5000, deadline - this.now()), "get-query");
      if (this.stopped) return;
      if (!r.ok) {
        const known = ["missing_scope", "not_in_channel", "channel_not_found", "invalid_auth", "token_revoked"];
        this.reason = r.status === 429 ? "rate-limited" : known.includes(r.error ?? "") ? r.error : "history-api-unavailable";
        const retrySeconds = r.retryAfterSeconds ?? (r.status === 0 || r.status >= 500 ? 5 : 300);
        this.save({ ...c, nextRetryAt: this.now() + retrySeconds * 1000 });
        this.state = "backoff"; return;
      }
      const messages = r.json.messages;
      const cursor = (r.json.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
      if (!Array.isArray(messages) || (r.json.has_more !== undefined && typeof r.json.has_more !== "boolean") ||
          (r.json.has_more === undefined && cursor === undefined) ||
          (cursor !== undefined && typeof cursor !== "string") || messages.length > 25 ||
          messages.some(m => !m || typeof m !== "object" || slackMicros(m.ts) === null ||
            slackMicros(m.ts)! < lower || slackMicros(m.ts)! >= latest)) {
        this.state = "incomplete"; this.reason = "invalid-history-page"; return;
      }
      const ordered = [...messages].sort((a, b) => slackMicros(a.ts)! < slackMicros(b.ts)! ? -1 : 1);
      const more = r.json.has_more === true || (typeof cursor === "string" && cursor.length > 0);
      if (more && (!messages.length || slackMicros(ordered[0]?.ts)! <= lower)) {
        this.state = "incomplete"; this.reason = "history-page-no-progress"; return;
      }
      // The page is valid; the flag describes unreachable older history. Retain that
      // qualification with the next durable page boundary rather than stalling forever.
      if (r.json.is_limited === true) c.historyLimited = true;
      for (const message of ordered) {
        if (this.stopped) return;
        if (this.now() >= deadline || entries >= 100) { this.state = "incomplete"; this.reason = "pass-budget"; return; }
        entries++;
        const ev: SlackEvent = { ...message, channel: this.opts.channel!, recoveredAfterGap: true };
        if (ev.thread_ts && ev.thread_ts !== ev.ts) continue;
        if (!ingestDecision(ev).ingest) continue;
        const landed = await this.opts.router.route(ev, 0, () => !this.stopped);
        if (this.stopped) return;
        if (landed.reason === "inflight" || landed.reason === "inactive") {
          this.state = "incomplete"; this.reason = "landing-in-progress"; return;
        }
        if (landed.disposition === "accepted") this.accepted++;
        if (landed.disposition === "dead-lettered") this.deadLettered++;
      }
      if (!more) {
        this.save({ ...c, coveredThrough: c.pending!.upper, pending: undefined, nextRetryAt: undefined });
        this.state = "scanned"; return;
      }
      this.save({ ...c, pending: { upper: c.pending!.upper, nextLatest: ordered[0]!.ts }, nextRetryAt: undefined });
      if (entries >= 100) break;
    }
    if (!this.stopped) { this.state = "incomplete"; this.reason = "pass-budget"; }
  }
}
