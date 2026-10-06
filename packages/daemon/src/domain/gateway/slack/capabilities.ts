// OPR.0.6.0.5 — the Slack connector's canonical capability sets, as pure constants (no imports,
// no I/O). config.ts, inbound.ts and the shipped app manifest all read these, so the manifest
// can be built without loading configuration and cannot drift from what the connector checks
// and admits.

/** Baseline bot scopes: the default `requiredScopes` that `rig slack verify` checks. */
export const BASELINE_REQUIRED_SCOPES: readonly string[] = ["chat:write", "channels:history", "channels:read"];

/** Bot scopes the shipped connector code uses beyond the baseline. `rig slack verify` does not
 *  require them, so a baseline READY does not prove these features have their grants. The app
 *  manifest requests them; each entry names the code path that needs it. */
export const FEATURE_SCOPES: ReadonlyArray<{ scope: string; usedBy: string }> = [
  { scope: "files:read", usedBy: "inbound attachments: authenticated url_private download (slack-subsystem inbound file port)" },
  { scope: "files:write", usedBy: "outbound attachments: files.getUploadURLExternal / files.completeUploadExternal (slack-api)" },
  { scope: "app_mentions:read", usedBy: "the app_mention event the inbound path admits (ADMITTED_EVENT_TYPES)" },
  { scope: "reactions:read", usedBy: "a ✅ resolving a decision: the reaction_added event (REACTION_EVENT_TYPES)" },
  { scope: "groups:history", usedBy: "a private channel: message.groups events, history recovery and reconcile reads (conversations.history/replies)" },
  { scope: "groups:read", usedBy: "a private channel: rig slack verify's membership check (conversations.info)" },
];

/** The Slack event payload types the inbound path admits (the `type` gate of ingestDecision). */
export const ADMITTED_EVENT_TYPES: readonly string[] = ["message", "app_mention"];

/** Event payload types routed to the reaction handler instead of the message gate. */
export const REACTION_EVENT_TYPES: readonly string[] = ["reaction_added"];

/** Admitted payload type → the Slack bot events to subscribe to, and the scope Slack requires for
 *  each. A subscription name is not always the payload type: `message.channels` (public) and
 *  `message.groups` (private channels) both deliver payloads of type `message`. No DMs. */
export const EVENT_SUBSCRIPTIONS: Readonly<Record<string, ReadonlyArray<{ subscription: string; scope: string }>>> = {
  message: [
    { subscription: "message.channels", scope: "channels:history" },
    { subscription: "message.groups", scope: "groups:history" },
  ],
  app_mention: [{ subscription: "app_mention", scope: "app_mentions:read" }],
  reaction_added: [{ subscription: "reaction_added", scope: "reactions:read" }],
};
