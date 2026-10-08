import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { InboundRouter, handleEnvelope, type InboundDeps, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { ChannelRecovery } from "../src/domain/gateway/slack/channel-recovery.js";
import { ChannelCoverageStore, SeenStore, DeadLetterStore, InboundReceiptStore, slackMicros, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import { startSocketInbound, type WsLike } from "../src/domain/gateway/slack/socket-inbound.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); vi.useRealTimers(); });
const event = (ts: string, extra: Partial<SlackEvent> = {}): SlackEvent => ({ type: "message", user: "U1", channel: "C1", ts, text: `task ${ts}`, ...extra });
function fixture() {
  const files = new Map<string, string>();
  const fsops: StateFsOps = {
    readFileSync: p => { if (!files.has(p)) throw Object.assign(new Error("absent"), { code: "ENOENT" }); return files.get(p)!; },
    writeFileSync: (p, d) => { files.set(p, d); }, appendFileSync: (p, d) => { files.set(p, (files.get(p) ?? "") + d); },
    rename: (from, to) => { files.set(to, files.get(from)!); files.delete(from); }, mkdirp: () => {},
  };
  const db = createFullTestDb(); closes.push(() => db.close());
  let queueDown = false;
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => !queueDown });
  const seen = new SeenStore("/s/slack-inbound-seen.jsonl", fsops);
  const receipts = new InboundReceiptStore("/s/slack-inbound-receipts.jsonl", fsops);
  const dead = new DeadLetterStore<SlackEvent>("/s/dead", fsops);
  const store = new ChannelCoverageStore("/s/coverage", fsops);
  const deps: InboundDeps = { queue: makeQueuePorts(repo), seen, deadLetter: dead, destination: "owner@test",
    resolveSender: user => user === "U1" ? { admitted: true, source: "human-fixture@external" } : { admitted: false, teaching: "register" } };
  const router = new InboundRouter(deps);
  let now = 1_000_000;
  const history: SlackEvent[] = [];
  const replies = new Map<string, SlackEvent[]>();
  const queries: URL[] = [];
  let pageSize = 25;
  let response: ((url: URL) => Response | Promise<Response>) | undefined;
  const fetchImpl: FetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("apps.connections.open")) return Response.json({ ok: true, url: "wss://fixture" });
    queries.push(u);
    if (response) return response(u);
    if (u.pathname.endsWith("conversations.replies")) {
      const root = u.searchParams.get("ts")!;
      const oldest = slackMicros(u.searchParams.get("oldest"))!, latest = slackMicros(u.searchParams.get("latest"))!;
      const thread = (replies.get(root) ?? []).filter(e => slackMicros(e.ts)! > oldest && slackMicros(e.ts)! < latest);
      return Response.json({ ok: true, messages: [{ ...event(root), thread_ts: root }, ...thread], has_more: false });
    }
    const oldest = slackMicros(u.searchParams.get("oldest"))!, latest = slackMicros(u.searchParams.get("latest"))!;
    const matches = history.filter(e => slackMicros(e.ts)! > oldest && slackMicros(e.ts)! < latest)
      .sort((a, b) => slackMicros(a.ts)! > slackMicros(b.ts)! ? -1 : 1);
    const messages = matches.slice(0, pageSize);
    return Response.json({ ok: true, messages, has_more: matches.length > messages.length });
  };
  const recovery = (token: string | null = "fixture-token", channel = "C1", threadRoots?: () => string[]) => {
    const r = new ChannelRecovery({ token, channel, stateDir: "/s", store, router, fetchImpl, now: () => now, threadRoots });
    r.initialize(); closes.push(() => r.stop()); return r;
  };
  return { db, repo, files, fsops, seen, receipts, dead, store, router, deps, queries, fetchImpl, recovery, history, replies,
    time: (t: number) => { now = t; },
    settledThrough: (t: number) => { now = t + 5000; }, page: (n: number) => { pageSize = n; },
    respond: (fn?: typeof response) => { response = fn; }, down: (v: boolean) => { queueDown = v; } };
}

it("recovers on socket connect, repeated short wakes and periodic retry through the real queue", async () => {
  vi.useFakeTimers(); const f = fixture(); const recovery = f.recovery();
  const sockets: WsLike[] = [];
  const h = startSocketInbound("fixture-app", f.router, { fetchImpl: f.fetchImpl, recovery, retryIntervalMs: 100,
    wsFactory: () => { const ws: WsLike = { send: vi.fn(), close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }; sockets.push(ws); return ws; } });
  closes.unshift(() => h.stop());
  for (let wake = 1; wake <= 4; wake++) {
    f.history.push(event(`${1000 + wake}.000001`)); f.settledThrough((1001 + wake) * 1000);
    await vi.advanceTimersByTimeAsync(wake === 1 ? 0 : 1000);
    sockets.at(-1)!.onopen?.(); await vi.advanceTimersByTimeAsync(0);
    expect(f.repo.list({ limit: 100 })).toHaveLength(wake);
    sockets.at(-1)!.onclose?.();
  }
  await vi.advanceTimersByTimeAsync(1000); sockets.at(-1)!.onopen?.(); await vi.advanceTimersByTimeAsync(0);
  f.history.push(event("1006.000001")); f.settledThrough(1_007_000);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.repo.list({ limit: 100 })).toHaveLength(5);
  expect(recovery.status().coverage?.coveredThrough).toBe("1007.000000");
  h.stop(); const calls = f.queries.length; await vi.advanceTimersByTimeAsync(1000); expect(f.queries).toHaveLength(calls);
});

it("marks recovered rows visibly with original time; ordinary live rows retain their body and fixed identity", async () => {
  const f = fixture(); const r = f.recovery(); f.history.push(event("1001.123456")); f.settledThrough(1_002_000); await r.run();
  const id = `qitem-slack-inbound-${createHash("sha256").update("C1:1001.123456").digest("hex").slice(0,20)}`;
  const row = f.repo.getById(id)!;
  expect(row.body).toContain("Recovered after a gap"); expect(row.body).toContain("1970-01-01T00:16:41.123Z");
  expect(row.body).toContain("1001.123456"); expect(row.sourceSession).toBe("human-fixture@external"); expect(row.destinationSession).toBe("owner@test");
  const live = await f.router.route(event("1003.000001")); expect(f.repo.getById(live.qitemId!)!.body).not.toContain("Recovered");
  await handleEnvelope({type:"events_api",payload:{event:event("1003.000001",{recoveredAfterGap:true})}},()=>{},f.router);
  await r.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(2);
});

it("seeds newest accepted landing once, never newest received/live traffic, across channel switches", async () => {
  const f = fixture(); f.seen.mark("C1:900.000001", "landed"); f.seen.mark("C2:999.1", "landed");
  f.receipts.append({ generation: 1, status: "accepted", channel: "C1", eventTs: "950.000001" });
  f.receipts.append({ generation: 1, status: "received", channel: "C1", eventTs: "990.000001" });
  const r = f.recovery(); expect(r.status().coverage?.coverageStart).toBe("950.000001");
  expect(r.status().limits).toContain("older history unknown");
  await f.router.route(event("1200.000001")); f.settledThrough(1_300_000);
  expect(f.recovery().status().coverage?.coveredThrough).toBe("950.000001");
  f.recovery("fixture", "C2"); expect(f.recovery().status().coverage?.coverageStart).toBe("950.000001");
});

it("persists short-page progress across restart without letting newer live traffic erase the gap", async () => {
  const f = fixture(); f.page(1); const r = f.recovery();
  for (let i=1; i<=7; i++) f.history.push(event(`${1000+i}.000001`));
  f.settledThrough(1_010_000); await r.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(4);
  expect(r.status().coverage).toMatchObject({ coveredThrough: "1000.000000", pending: { upper: "1010.000000", nextLatest: "1004.000001" } });
  await f.router.route(event("1050.000001")); r.stop(); f.settledThrough(1_060_000);
  const restart = f.recovery(); await restart.run();
  expect(f.repo.list({ limit: 100 })).toHaveLength(8); expect(restart.status().coverage?.coveredThrough).toBe("1010.000000");
  expect(f.queries[4]!.searchParams.get("latest")).toBe("1004.000001");
});

it("retains Retry-After across restart and reports missing scope and unavailable token", async () => {
  const f = fixture(); const r = f.recovery(); f.time(1_010_000);
  f.respond(() => Response.json({ ok: false }, { status: 429, headers: { "retry-after": "600" } })); await r.run();
  expect(r.status()).toMatchObject({ state: "backoff", reason: "rate-limited", coverage: { nextRetryAt: 1_610_000 } });
  const next = f.recovery(); await next.run(); expect(f.queries).toHaveLength(1);
  f.time(1_610_000); f.respond(() => Response.json({ ok: false, error: "missing_scope" })); await next.run();
  expect(next.status().reason).toBe("missing_scope");
  const absent = f.recovery(null); await absent.run(); expect(absent.status().reason).toBe("bot-token-unresolved"); expect(f.queries).toHaveLength(2);
});

it("does not checkpoint an in-flight live collision, including its failed owner", async () => {
  const f = fixture(); const r = f.recovery(); let release!: () => void;
  f.deps.files = { transfer: () => new Promise(resolve => { release = () => resolve({ stored: [], failed: [] }); }) };
  const ev = event("1001.000001", { files: [{}] }); f.history.push(ev); f.settledThrough(1_002_000);
  const live = f.router.route(ev); await r.run();
  expect(r.status().reason).toBe("landing-in-progress"); expect(r.status().coverage?.coveredThrough).toBe("1000.000000");
  f.down(true); release(); await live; expect(f.dead.readAll()).toHaveLength(1);
  f.deps.files = undefined; await r.run(); expect(r.status().deadLetteredThisProcess).toBe(1);
  f.down(false); await f.router.retryDeadLetters(); expect(f.repo.list({ limit: 100 })).toHaveLength(1); expect(f.dead.readAll()).toHaveLength(0);
});

it.each(["seen", "dead", "checkpoint"])("preserves the page after %s write failure; fixed IDs tolerate replay", async failure => {
  const f = fixture(); const r = f.recovery(); f.history.push(event("1001.000001")); f.settledThrough(1_002_000);
  const append = f.fsops.appendFileSync, rename = f.fsops.rename;
  if (failure === "dead") f.down(true);
  f.fsops.appendFileSync = (p, d) => { if ((failure === "seen" && p.endsWith("seen.jsonl")) || (failure === "dead" && p.endsWith("dead"))) throw new Error("disk"); append(p,d); };
  let writes=0; f.fsops.rename = (a,b) => { if (failure === "checkpoint" && ++writes === 2) throw new Error("disk"); rename(a,b); };
  await r.run(); expect(r.status().coverage?.coveredThrough).toBe("1000.000000");
  f.fsops.appendFileSync=append; f.fsops.rename=rename; f.down(false);
  r.stop(); const next=f.recovery(); await next.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(1); expect(next.status().coverage?.coveredThrough).toBe("1002.000000");
});

it("filters bots, replies, edits and unknown senders; preserves files and exact boundary timestamps", async () => {
  const f=fixture(); const r=f.recovery();
  f.history.push(event("1000.000000"), event("1000.000001", {bot_id:"B"}), event("1000.000002",{thread_ts:"999.1"}),
    event("1000.000003",{subtype:"message_changed"}), event("1000.000004",{user:"unknown"}),
    event("1000.000005",{subtype:"file_share",text:"",files:[{name:"kept.txt"}]}), event("1001.000000"));
  f.settledThrough(1_001_000); await r.run(); expect(f.repo.list({limit:100})).toHaveLength(2);
  expect(f.repo.list({limit:100}).map(x=>x.body).join("\n")).toContain("FILE TRANSFER FAILED: kept.txt");
  f.settledThrough(1_002_000); await r.run(); expect(f.repo.list({limit:100})).toHaveLength(3);
  expect(f.dead.readAll()).toHaveLength(0);
});

it.each([
  { messages: [], has_more: true },
  { messages: [event("1000.000000"), event("1001.1")], has_more: true },
  { messages: [event("2000.1")], has_more: false },
  { messages: [{ text: "missing timestamp" }], has_more: false },
])("leaves malformed and nonprogressing history incomplete: %j", async page => {
  const f=fixture(); const r=f.recovery(); f.settledThrough(1_010_000); f.respond(()=>Response.json({ok:true,...page}));
  await r.run(); expect(r.status().state).toBe("incomplete"); expect(r.status().coverage?.coveredThrough).toBe("1000.000000");
});

it("honors cursor continuation even on a short page and yields at deadline mid-page without losing earlier work", async () => {
  const f=fixture(); const r=f.recovery(); f.settledThrough(1_010_000);
  f.respond(u=>Response.json({ok:true, messages:u.searchParams.get("latest")==="1010.000000"?[event("1002.1")]:[event("1001.1")],
    response_metadata:{next_cursor:u.searchParams.get("latest")==="1010.000000"?"continued":""}}));
  await r.run(); expect(f.repo.list({limit:100})).toHaveLength(2);
  const g=fixture(); const mid=g.recovery(); g.history.push(event("1001.1",{files:[{}]}),event("1002.1")); g.settledThrough(1_010_000);
  g.deps.files={transfer:async()=>{g.settledThrough(1_030_000);return {stored:[],failed:[]};}};
  await mid.run(); expect(g.repo.list({limit:100})).toHaveLength(1); expect(mid.status().reason).toBe("pass-budget");
  const resumed=g.recovery(); await resumed.run(); expect(g.repo.list({limit:100})).toHaveLength(2); expect(resumed.status().coverage?.coveredThrough).toBe("1010.000000");
});

it("fences a stopped worker during file I/O and never reseeds a corrupt or unreadable store", async () => {
  const f=fixture(); const r=f.recovery(); f.history.push(event("1001.1",{files:[{}]})); f.settledThrough(1_010_000);
  let release!:()=>void; let entered!:()=>void; const started=new Promise<void>(resolve=>{entered=resolve;});
  f.deps.files={transfer:()=>new Promise(resolve=>{entered();release=()=>resolve({stored:[],failed:[]});})};
  const pass=r.run(); await started; r.stop(); release(); await pass;
  expect(f.repo.list({limit:100})).toHaveLength(0); expect(r.status().coverage?.coveredThrough).toBe("1000.000000");
  f.files.set("/s/coverage", "broken"); const bad=f.recovery(); expect(bad.status().state).toBe("unavailable"); expect(f.files.get("/s/coverage")).toBe("broken");
  f.fsops.readFileSync=()=>{throw Object.assign(new Error("denied"),{code:"EACCES"});};
  expect(f.recovery().status().state).toBe("unavailable");
});


it("recovers reachable plan-limited history and retains the coverage limitation across restart", async () => {
  const f = fixture(); const r = f.recovery(); f.time(1_010_000);
  f.respond(() => Response.json({ ok: true, messages: [event("1001.1")], has_more: false, is_limited: true }));
  await r.run();
  expect(f.repo.list({ limit: 100 })).toHaveLength(1);
  expect(r.status()).toMatchObject({ state: "scanned", coverage: { coveredThrough: "1005.000000", historyLimited: true } });
  expect(r.status().limits.join(" ")).toContain("Slack plan limit");
  r.stop(); const next = f.recovery();
  expect(next.status().limits.join(" ")).toContain("Slack plan limit");
  f.time(1_020_000);
  f.respond(() => Response.json({ ok: true, messages: [], has_more: false, is_limited: true }));
  await next.run(); expect(next.status()).toMatchObject({ state: "scanned", coverage: { coveredThrough: "1015.000000" } });
  expect(f.repo.list({ limit: 100 })).toHaveLength(1);
});

it("holds a five-second settle margin and recovers a recently invisible message in the next interval", async () => {
  const f = fixture(); const r = f.recovery(); f.time(1_002_000);
  await r.run(); expect(f.queries).toHaveLength(0); // The upper bound has not passed the initial floor.
  f.time(1_010_000); f.history.push(event("1004.1"));
  await r.run();
  expect(f.queries[0]!.searchParams.get("latest")).toBe("1005.000000");
  expect(r.status().coverage?.coveredThrough).toBe("1005.000000");
  f.history.push(event("1009.1")); // History did not expose this post at the earlier scan.
  f.time(1_015_000); await r.run();
  expect(f.repo.list({ limit: 100 })).toHaveLength(2);
  expect(r.status().coverage?.coveredThrough).toBe("1010.000000");
});

it.each([0, 503])("retries transient history transport failure %i after five seconds, preserving the frozen interval", async status => {
  const f = fixture(); const r = f.recovery(); f.time(1_010_000);
  f.respond(() => { if (status === 0) throw new Error("temporary transport failure"); return Response.json({ ok: false }, { status }); });
  await r.run();
  expect(r.status()).toMatchObject({ state: "backoff", coverage: { nextRetryAt: 1_015_000 } });
  const next = f.recovery(); f.time(1_014_999); await next.run(); expect(f.queries).toHaveLength(1);
  f.history.push(event("1001.1")); f.respond(); f.time(1_015_000); await next.run();
  expect(f.queries).toHaveLength(2); expect(f.repo.list({ limit: 100 })).toHaveLength(1);
  expect(next.status().coverage?.coveredThrough).toBe("1005.000000");
});

it("recovers replies posted in followed threads while the socket was down, exactly once", async () => {
  const f = fixture(); const r = f.recovery("fixture-token", "C1", () => ["900.000001"]);
  f.replies.set("900.000001", [event("1003.000001", { thread_ts: "900.000001", text: "Lee's reply while the host slept" }), event("1004.000001", { thread_ts: "900.000001", bot_id: "B" })]);
  f.history.push(event("1005.000001", { text: "a top-level message in the gap" }));
  f.settledThrough(1_006_000); await r.run();
  const rows = f.repo.list({ limit: 100 });
  expect(rows.map((x) => x.body).join("\n")).toContain("Lee's reply while the host slept");
  expect(rows.map((x) => x.body).join("\n")).toContain("a top-level message in the gap");
  expect(rows).toHaveLength(2);
  expect(r.status().coverage?.coveredThrough).toBe("1006.000000");
  f.settledThrough(1_010_000); await r.run();
  expect(f.repo.list({ limit: 100 })).toHaveLength(2);
});

it("follows a thread's reply pages before advancing coverage", async () => {
  const f = fixture(); const r = f.recovery("fixture-token", "C1", () => ["900.000001"]);
  f.respond((u) => {
    if (!u.pathname.endsWith("conversations.replies")) return Response.json({ ok: true, messages: [], has_more: false });
    return u.searchParams.get("cursor") === "page-2"
      ? Response.json({ ok: true, messages: [event("1003.000002", { thread_ts: "900.000001", text: "second page" })], has_more: false })
      : Response.json({ ok: true, messages: [event("1003.000001", { thread_ts: "900.000001", text: "first page" })], has_more: true, response_metadata: { next_cursor: "page-2" } });
  });
  f.settledThrough(1_006_000); await r.run();
  expect(f.repo.list({ limit: 100 }).map((x) => x.body).join("\n")).toContain("second page");
  expect(f.repo.list({ limit: 100 })).toHaveLength(2);
});

type Reply = { ok: boolean; error?: string; messages?: unknown; status?: number; retryAfter?: number; next?: string };
function threadFixture(roots: string[], answer: (root: string, call: number) => Reply, costMs = 0) {
  const f = fixture();
  const calls: string[] = [];
  f.respond((u) => {
    if (!u.pathname.endsWith("conversations.replies")) {
      const oldest = slackMicros(u.searchParams.get("oldest"))!, latest = slackMicros(u.searchParams.get("latest"))!;
      return Response.json({ ok: true, messages: f.history.filter(e => slackMicros(e.ts)! > oldest && slackMicros(e.ts)! < latest), has_more: false });
    }
    const root = u.searchParams.get("ts")!;
    calls.push(root);
    if (costMs) f.time(nowRef.t += costMs);
    const a = answer(root, calls.filter((c) => c === root).length);
    const headers = a.retryAfter ? { "retry-after": String(a.retryAfter) } : undefined;
    return new Response(JSON.stringify(a.ok ? { ok: true, messages: a.messages ?? [], has_more: !!a.next, response_metadata: { next_cursor: a.next ?? "" } } : { ok: false, error: a.error }), { status: a.status ?? 200, headers: { "content-type": "application/json", ...headers } });
  });
  const nowRef = { t: 1_006_000 };
  const at = (t: number) => { nowRef.t = t; f.time(t); };
  const recovery = () => f.recovery("fixture-token", "C1", () => roots);
  const bodies = () => f.repo.list({ limit: 500 }).map((x) => x.body).join("\n");
  return { f, calls, at, recovery, bodies };
}
const reply = (root: string, ts: string, text: string) => ({ ...event(ts, { thread_ts: root, text }) });

it("one failing thread keeps its own watermark while top-level history and the other threads advance", async () => {
  let aFails = true;
  const t = threadFixture(["900.000001", "901.000001"], (root) => root === "900.000001"
    ? (aFails ? { ok: false, error: "internal_error" } : { ok: true, messages: [reply(root, "1003.000001", "reply in A")] })
    : { ok: true, messages: [reply(root, "1003.000002", "reply in B")] });
  t.f.history.push(event("1004.000001", { text: "top-level in the gap" }));
  const r = t.recovery(); t.at(1_010_000); await r.run();
  expect(t.bodies()).toContain("top-level in the gap");
  expect(t.bodies()).toContain("reply in B");
  expect(t.bodies()).not.toContain("reply in A");
  expect(r.status().coverage?.coveredThrough).toBe("1005.000000");
  expect(r.status().threads?.degraded).toEqual({ "900.000001": "transient: internal_error" });
  expect(r.status().coverage?.threads?.roots["900.000001"]).toBeUndefined();
  aFails = false; t.at(1_012_000); await r.run();
  expect(t.bodies()).toContain("reply in A");
  expect(r.status().threads?.degraded).toEqual({});
  expect(t.f.repo.list({ limit: 100 })).toHaveLength(3);
});

it("a capability fault is reported and retried every pass, never covered; a deleted root is dropped", async () => {
  const t = threadFixture(["900.000001", "901.000001"], (root) => root === "900.000001" ? { ok: false, error: "missing_scope" } : { ok: false, error: "thread_not_found" });
  const r = t.recovery(); t.at(1_006_000); await r.run();
  t.at(1_008_000); await r.run();
  expect(r.status().threads?.degraded).toEqual({ "900.000001": "missing_scope" });
  expect(r.status().coverage?.threads?.roots["900.000001"]).toBeUndefined();
  expect(r.status().coverage?.threads?.deleted).toEqual(["901.000001"]);
  expect(t.calls.filter((c) => c === "900.000001")).toHaveLength(2);
  expect(t.calls.filter((c) => c === "901.000001")).toHaveLength(1);
});

it("malformed reply pages cover nothing for that thread", async () => {
  const t = threadFixture(["900.000001"], () => ({ ok: true, messages: "not-a-list" }));
  const r = t.recovery(); t.at(1_006_000); await r.run();
  expect(r.status().threads?.degraded).toEqual({ "900.000001": "transient: invalid-replies-page" });
  expect(r.status().coverage?.threads?.roots["900.000001"]).toBeUndefined();
});

it("honors Retry-After for replies without stalling top-level history", async () => {
  const t = threadFixture(["900.000001"], () => ({ ok: false, error: "ratelimited", status: 429, retryAfter: 120 }));
  t.f.history.push(event("1004.000001", { text: "top-level while rate limited" }));
  const r = t.recovery(); t.at(1_010_000); await r.run();
  expect(t.bodies()).toContain("top-level while rate limited");
  t.at(1_060_000); await r.run();
  expect(t.calls).toHaveLength(1);
  t.at(1_131_000); await r.run();
  expect(t.calls).toHaveLength(2);
});

it("reads every followed thread, beyond fifty, across passes and a restart, each reply exactly once", async () => {
  const roots = Array.from({ length: 60 }, (_, i) => `${900 + i}.000001`);
  const t = threadFixture(roots, (root) => ({ ok: true, messages: [reply(root, `1003.${root.slice(0, 3)}001`, `reply in ${root}`)] }), 1000);
  let r = t.recovery(); t.at(1_006_000); await r.run();
  const firstPass = t.calls.length;
  expect(firstPass).toBeLessThan(60);
  r.stop();
  r = t.recovery();
  for (let pass = 0; pass < 10 && t.f.repo.list({ limit: 500 }).length < 60; pass++) { t.at(1_006_000 + (pass + 1) * 20_000); await r.run(); }
  expect(t.f.repo.list({ limit: 500 })).toHaveLength(60);
  expect(new Set(t.calls).size).toBe(60);
  for (const root of roots) expect(t.bodies()).toContain(`reply in ${root}`);
});

it("a degraded thread waits behind healthy ones, so it cannot starve them of the pass budget", async () => {
  const t = threadFixture(["900.000001", "901.000001"], (root) => root === "900.000001"
    ? { ok: false, error: "missing_scope" } : { ok: true, messages: [reply(root, "1003.000002", "reply in B")] }, 14_000);
  const r = t.recovery(); t.at(1_010_000); await r.run();
  expect(t.calls).toEqual(["900.000001"]);
  t.at(1_030_000); await r.run();
  expect(t.calls).toEqual(["900.000001", "901.000001"]);
  expect(t.bodies()).toContain("reply in B");
});

it("a thread longer than the page cap resumes after its last reply read, each reply exactly once", async () => {
  const t = threadFixture(["900.000001"], (root, call) => ({ ok: true, next: call < 25 ? "more" : undefined,
    messages: [reply(root, `1003.${String(call).padStart(6, "0")}`, `reply ${call};`)] }));
  const r = t.recovery(); t.at(1_010_000); await r.run();
  expect(t.calls).toHaveLength(10);
  expect(t.f.repo.list({ limit: 100 })).toHaveLength(10);
  for (let pass = 1; pass <= 3; pass++) { t.at(1_010_000 + pass * 20_000); await r.run(); }
  expect(t.f.repo.list({ limit: 100 })).toHaveLength(25);
  for (let call = 1; call <= 25; call++) expect(t.bodies()).toContain(`reply ${call};`);
});

it("a malformed thread checkpoint replays replies instead of stopping recovery for the channel", async () => {
  const t = threadFixture(["900.000001"], (root) => ({ ok: true, messages: [reply(root, "1003.000001", "reply in A")] }));
  t.f.history.push(event("1004.000001", { text: "top-level in the gap" }));
  let r = t.recovery(); t.at(1_010_000); await r.run();
  r.stop();
  const data = JSON.parse(t.f.files.get("/s/coverage")!);
  data.C1.threads.deleted = 5;
  t.f.files.set("/s/coverage", JSON.stringify(data));
  t.f.history.push(event("1011.000001", { text: "top-level after restart" }));
  r = t.recovery(); t.at(1_020_000); await r.run();
  expect(r.status().state).not.toBe("unavailable");
  expect(t.bodies()).toContain("top-level after restart");
  expect(t.calls).toEqual(["900.000001", "900.000001"]);
  expect(t.f.repo.list({ limit: 100 })).toHaveLength(3);
});

it("a thread cut short by the pass budget keeps the replies it read and is not marked degraded", async () => {
  const t = threadFixture(["900.000001"], (root, call) => ({ ok: true, next: call < 4 ? "more" : undefined,
    messages: [reply(root, `1003.${String(call).padStart(6, "0")}`, `reply ${call};`)] }), 7_000);
  const r = t.recovery(); t.at(1_010_000); await r.run();
  expect(t.f.repo.list({ limit: 100 })).toHaveLength(2);
  expect(r.status().threads?.degraded).toEqual({});
  for (let pass = 1; pass <= 2; pass++) { t.at(1_040_000 + pass * 20_000); await r.run(); }
  for (let call = 1; call <= 4; call++) expect(t.bodies().split(`reply ${call};`)).toHaveLength(2);
});
