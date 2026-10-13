// S10 — deterministic thread ROUTING over the thread↔seat map. The four enumerated classes
// (proof contract), each a pure lookup — zero inference:
//   1. NEW conversation      — outbound-only: a fresh root posts un-threaded, then the map
//                              opens (thread_ts = the posted root's ts). Inbound never mints.
//   2. EXISTING thread       — reply carries thread_ts, map hit (open) → EXACTLY the mapped seat.
//   3. CLOSED thread         — map hit (closed) → STILL exactly the mapped seat (closure is
//                              conversation state, never a routing black hole).
//   4. UNMAPPED / human-initiated — thread_ts with no mapping, or a top-level channel message
//                              (no thread_ts): the ORCHESTRATOR's unrouted-signal row — the
//                              configured inbound destination with the unrouted-signal tag.
//                              Never dropped, never guessed at a seat.

import type { SlackEvent } from "./inbound.js";
import type { ThreadSeatMap } from "./thread-seat-map.js";

export interface InboundRoute {
  destination: string;
  tags: string[];
  /** Exact human-gate qitem this thread was opened for. Absent on unmapped traffic. */
  correlationQitemId?: string;
  /** The routing class that fired — receipts per class ride the row tags + logs. */
  routeClass: "existing-thread" | "closed-thread" | "unmapped-thread" | "human-initiated";
}

const BASE_TAGS = ["founder-slack", "inbound"];

export function makeThreadRouteResolver(opts: {
  map: ThreadSeatMap;
  /** The orchestrator slot for unrouted signals (first-class config: inboundDestination). */
  unroutedDestination: string;
  /** A channel with its own inbound seat lands its unrouted messages there. */
  destinationForChannel?: (channel: string | undefined) => string | undefined;
  /** Whether a thread's seat is an agent this daemon knows. A thread posted by the daemon or other
   *  machinery (daemon@kernel, codex-usage@host, ...) has no agent to read its replies. */
  isAgentSeat?: (seat: string) => boolean;
  /** A thread the human started routes to the seat but correlates to no request. */
  isHumanStarted?: (conversationId: string) => boolean;
  /** The newest still-open decision a seat posted into this thread (not its root), with its seat. */
  newestOpenDecision?: (threadTs: string, channel: string | undefined, slackUser: string) => { conversationId: string; seat: string } | null;
  log?: (msg: string) => void;
}): (ev: SlackEvent & { thread_ts?: string }) => InboundRoute {
  const log = opts.log ?? (() => {});
  return (ev) => {
    const unrouted = opts.destinationForChannel?.(ev.channel) ?? opts.unroutedDestination;
    const threadTs = (ev as { thread_ts?: string }).thread_ts;
    if (threadTs) {
      const mapping = opts.map.resolveByThread(threadTs);
      // #899 — a reaction names its message by channel and timestamp, and a timestamp is unique only
      // within a channel, so a reaction on another channel's message is not on this ask.
      const sameMessage = ev.type !== "reaction_added" || mapping?.channel === ev.channel;
      if (ev.type === "reaction_added" && !(mapping && sameMessage)) {
        // #899 — a reaction on a message OpenRig posted into a thread for an ask (a long ask's reply
        // part, a later notification, an ask posted into another thread) reaches that ask's own seat.
        // A person's reply in the thread was not posted by OpenRig, so a reaction on it stays ignored.
        const part = opts.map.partOf(threadTs, ev.channel ?? "");
        if (part) {
          log(`inbound reaction on ts=${threadTs} (posted for ${part.conversationId}) -> ${part.seat}`);
          return {
            destination: part.seat,
            tags: [...BASE_TAGS, "thread", `reply-to:${part.conversationId}`],
            correlationQitemId: part.conversationId,
            routeClass: "existing-thread",
          };
        }
      }
      // A reply typed in a thread that holds a newer open decision posted into it answers that
      // decision, not the thread's root; only with none open does it fall back to the root.
      // Only a person's real message (it has its own ts and sender): a click's or ✅'s lookup of a root keeps the root.
      const typed = ev.type === "message" && !!(ev as { ts?: string }).ts && !!ev.user;
      const threaded = typed ? opts.newestOpenDecision?.(threadTs, ev.channel, ev.user!) : null;
      if (threaded) {
        log(`inbound thread_ts=${threadTs} -> ${threaded.seat} (newest open decision ${threaded.conversationId} in the thread)`);
        return {
          destination: threaded.seat,
          tags: [...BASE_TAGS, "thread", `reply-to:${threaded.conversationId}`, `thread-ts:${threadTs}`],
          correlationQitemId: threaded.conversationId,
          routeClass: "existing-thread",
        };
      }
      // A thread with no agent behind it (the daemon's own alerts, other machinery, or a seat that is
      // its own human, left by the Confirm self-loop): its replies go where an unrouted message goes.
      if (mapping && sameMessage && ((opts.isAgentSeat && !opts.isAgentSeat(mapping.seat)) || (mapping.human && mapping.seat.split("@")[0] === mapping.human.split("@")[0]))) {
        log(`inbound thread_ts=${threadTs} has no agent seat (${mapping.seat}) -> unrouted-signal to ${unrouted}`);
        return { destination: unrouted, tags: [...BASE_TAGS, "unrouted-signal", `thread-ts:${threadTs}`], routeClass: "unmapped-thread" };
      }
      if (mapping && sameMessage) {
        // FOUNDER ROOT INVARIANT (2026-08-27): the map stores the bare local seat because the
        // queue row's source_session is bare inside one instance — the seat routes as stored.
        // (The interim self-host localizer from the L2 first pass was deleted with the root
        // stamping; historical triple rows are the operator adoption's one-time cleanup.)
        const routeClass = mapping.state === "closed" ? "closed-thread" : "existing-thread";
        // #96: once an update shares a root, its owner's next decision posts a fresh root. A reply
        // still arriving in the OLDER root lands on the seat as a message but answers nothing:
        // only the conversation's newest root correlates to its current human gate.
        // Phase 1: a closed request answers nothing; its replies still reach the seat.
        const newest = opts.map.resolveByConversation(mapping.conversationId);
        const current = mapping.state === "open" && (!newest || newest.threadTs === threadTs)
          && !opts.isHumanStarted?.(mapping.conversationId);
        log(`inbound routed thread_ts=${threadTs} -> ${mapping.seat} (${routeClass}${current ? "" : ", superseded root: no gate correlation"})`);
        return {
          destination: mapping.seat,
          tags: [...BASE_TAGS, "thread", `reply-to:${mapping.conversationId}`, `thread-ts:${threadTs}`],
          ...(current ? { correlationQitemId: mapping.conversationId } : {}),
          routeClass,
        };
      }
      // #899 — a reaction on a message that isn't an ask is ignored by its caller, not sent here.
      if (ev.type !== "reaction_added") log(`inbound UNMAPPED thread_ts=${threadTs} -> unrouted-signal to ${unrouted} (never dropped, never guessed)`);
      return { destination: unrouted, tags: [...BASE_TAGS, "unrouted-signal"], routeClass: "unmapped-thread" };
    }
    log(`inbound human-initiated (no thread_ts) -> unrouted-signal to ${unrouted}`);
    return { destination: unrouted, tags: [...BASE_TAGS, "unrouted-signal"], routeClass: "human-initiated" };
  };
}
