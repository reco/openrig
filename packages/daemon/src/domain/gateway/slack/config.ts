// Slice-11 slack-connector — first-class connector config (item 5 + T1075).
//
// Config is a first-class JSON file (NOT env-only): inbound destination,
// watched channel, OWNER thresholds, source label, required scopes, and POINTERS to
// secrets (never secret VALUES — those live in the 0600 env file / env vars).
// An unset/partial config yields an HONEST unconfigured state (no throw, no
// silent nothing) so `rig slack status` can tell the operator exactly what's left.
import fs from "node:fs";
import path from "node:path";
import { getOpenRigHome } from "../../../openrig-compat.js";
import { OWNER_NOTIFICATION_LEVELS, type OwnerNotificationLevel } from "../../queue-transition-log.js";
import { BASELINE_REQUIRED_SCOPES } from "./capabilities.js";
import { unsupportedChannelMapFields, validateChannelMap, type ChannelMapEntry } from "./channel-map.js";

export interface SlackConnectorConfig {
  enabled: boolean;
  /** Inbound: human Slack messages land here. First-class + overridable (T1075). */
  inboundDestination: string;
  /** Optional explicit human-seat allow-list for outbound (empty = any human-seat/human-gate). */
  outboundDestinations: string[];
  /** Where the queue lives, shown in the posted message footer (never hardcoded). */
  sourceLabel: string;
  /** Slack channel the connector app must be a member of (verified live, item 5). */
  channel: string | null;
  /** Bot scopes the connector requires; verified against GRANTED header, not config (item 5). */
  requiredScopes: string[];
  /** Path to the 0600 env file holding secrets (webhook URL, bot/app tokens). */
  secretsEnvFile: string | null;
  /**
   * S10: VESTIGIAL — the relay's remote-queue targeting (OPENRIG_URL for a connector host
   * that differed from the queue host). The in-daemon subsystem reads its own QueueRepository
   * directly, so this is never consulted; the field stays so existing config files load
   * unchanged. Remove at the next config-schema rev.
   */
  queueUrl: string | null;
  minimumLevelThatPosts: OwnerNotificationLevel;
  minimumLevelThatInterrupts: OwnerNotificationLevel;
  /** Phase 1: a typed thread reply is conversation; only a button, an `answer:` reply or a ✅
   *  resolves a decision. False keeps the #96 contract: any typed reply answers the decision. */
  explicitAnswersOnly: boolean;
  /** Phase 1: an open request quiet this many days gets a reminder; reminders never close. */
  staleReminderDays: number;
  /** The reaction emoji (standard or the workspace's custom name) a top-level message to a human
   *  shows once its row no longer waits on them. */
  receipts: { done: string };
  /** More channels beside `channel`, each landing its new messages on its own seat. */
  extraChannels: Array<{ id: string; inboundDestination: string }>;
  /** Seats (session names) whose permission prompts go to Slack as Approve / Deny buttons. */
  approvalSeats: string[];
  /** How long an unanswered Slack approval waits before its card's thread is pinged once; the card stays
   *  answerable while the seat waits. */
  approvalTimeoutSeconds: number;
  /**
   * #192: optional per-rig / per-seat outbound channels (channel-map.ts). Absent or empty = every
   * item posts to `channel`, as before. Deliberately not in DEFAULT_CONFIG, so a config without
   * it saves and digests unchanged.
   */
  channelMap?: ChannelMapEntry[];
  /** Optional channel for pure FYI posts: an update with no buttons that is not a reply in a thread.
   *  Inbound there lands on `inboundDestination`. Absent = those post where everything else does. */
  notificationsChannel?: string | null;
  /** Seat that gets a smoke-check row after a merge from Slack; absent = none. */
  mergeSmokeDestination?: string | null;
}

export const DEFAULT_CONFIG: SlackConnectorConfig = {
  enabled: false,
  inboundDestination: "operator-agent@kernel",
  outboundDestinations: [],
  sourceLabel: "openrig",
  channel: null,
  requiredScopes: [...BASELINE_REQUIRED_SCOPES],
  secretsEnvFile: null,
  queueUrl: null,
  minimumLevelThatPosts: "NOTICE",
  minimumLevelThatInterrupts: "ALERT",
  explicitAnswersOnly: true,
  staleReminderDays: 3,
  receipts: { done: "white_check_mark" },
  extraChannels: [],
  approvalSeats: [],
  approvalTimeoutSeconds: 900,
};

export const MAX_APPROVAL_TIMEOUT_SECONDS = 3600;

/** Every configured channel with the seat its new messages land on; `channel` first. */
export function channelsOf(cfg: SlackConnectorConfig): Array<{ id: string; inboundDestination: string }> {
  return [...(cfg.channel ? [{ id: cfg.channel, inboundDestination: cfg.inboundDestination }] : []), ...cfg.extraChannels,
    ...(cfg.notificationsChannel ? [{ id: cfg.notificationsChannel, inboundDestination: cfg.inboundDestination }] : [])];
}

function validateLevel(field: string, value: unknown): asserts value is OwnerNotificationLevel {
  if (!OWNER_NOTIFICATION_LEVELS.includes(value as OwnerNotificationLevel)) {
    throw new Error(`${field} must be one of ${OWNER_NOTIFICATION_LEVELS.join(", ")} (got ${String(value)})`);
  }
}

/** `reading`: a channel-map entry field written by a newer OpenRig is ignored (and reported by
 *  staticReadiness and the gateway log) rather than failing the connector after a downgrade. */
function validateConfig(cfg: SlackConnectorConfig, opts: { reading?: boolean } = {}): void {
  validateLevel("minimumLevelThatPosts", cfg.minimumLevelThatPosts);
  validateLevel("minimumLevelThatInterrupts", cfg.minimumLevelThatInterrupts);
  if (typeof cfg.receipts?.done !== "string" || !/^[a-z0-9_+'-]+$/.test(cfg.receipts.done)) {
    throw new Error(`receipts.done must be a Slack emoji name without colons (got ${String(cfg.receipts?.done)})`);
  }
  if (!Array.isArray(cfg.extraChannels) || cfg.extraChannels.some((c) => !c || typeof c.id !== "string" || !/^[A-Z0-9-]+$/.test(c.id) || typeof c.inboundDestination !== "string" || !c.inboundDestination)) {
    throw new Error("extraChannels must be a list of { id: <Slack channel id>, inboundDestination: <seat> }");
  }
  if (cfg.mergeSmokeDestination != null && (typeof cfg.mergeSmokeDestination !== "string" || !cfg.mergeSmokeDestination.includes("@"))) {
    throw new Error(`mergeSmokeDestination must be a seat session name (member@rig) (got ${String(cfg.mergeSmokeDestination)})`);
  }
  if (cfg.notificationsChannel != null && (typeof cfg.notificationsChannel !== "string" || !/^[A-Z0-9-]+$/.test(cfg.notificationsChannel))) {
    throw new Error(`notificationsChannel must be a Slack channel id (got ${String(cfg.notificationsChannel)})`);
  }
  const ids = channelsOf(cfg).map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw new Error("each Slack channel may be configured once (channel + extraChannels + notificationsChannel)");
  if (!Array.isArray(cfg.approvalSeats) || cfg.approvalSeats.some((s) => typeof s !== "string" || !s.includes("@"))) {
    throw new Error("approvalSeats must be a list of seat session names (member@rig)");
  }
  if (!Number.isInteger(cfg.approvalTimeoutSeconds) || cfg.approvalTimeoutSeconds < 60 || cfg.approvalTimeoutSeconds > MAX_APPROVAL_TIMEOUT_SECONDS) {
    throw new Error(`approvalTimeoutSeconds must be a whole number of seconds from 60 to ${MAX_APPROVAL_TIMEOUT_SECONDS} (got ${String(cfg.approvalTimeoutSeconds)})`);
  }
  if (typeof cfg.staleReminderDays !== "number" || !(cfg.staleReminderDays > 0)) {
    throw new Error(`staleReminderDays must be a positive number of days (got ${String(cfg.staleReminderDays)})`);
  }
  validateChannelMap(cfg, { allowUnknownFields: opts.reading });
}

export function configPathFor(home?: string): string {
  return path.join(home ?? getOpenRigHome(), "slack-connector.json");
}

export function loadConfig(home?: string): SlackConnectorConfig {
  const p = configPathFor(home);
  let raw: Partial<SlackConnectorConfig> & { alertTag?: unknown; feedbackReactions?: unknown };
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<SlackConnectorConfig> & { alertTag?: unknown; feedbackReactions?: unknown };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  const { alertTag: _retiredAlertTag, feedbackReactions: _retiredFeedback, ...supported } = raw;
  // Only the done mark remains of the receipts; the retired progress stages are ignored.
  const cfg = { ...DEFAULT_CONFIG, ...supported, receipts: { done: supported.receipts?.done ?? DEFAULT_CONFIG.receipts.done } };
  validateConfig(cfg, { reading: true });
  return cfg;
}

export function saveConfig(cfg: SlackConnectorConfig, home?: string): string {
  validateConfig(cfg);
  const p = configPathFor(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  return p;
}

export function configFileExists(home?: string): boolean {
  return fs.existsSync(configPathFor(home));
}

export interface ReadinessItem {
  ok: boolean;
  label: string;
  detail: string;
}

/**
 * HONEST unconfigured state (item 5): a static (no-network) readiness checklist
 * from config + secret RESOLVABILITY (not values). Live scope/membership checks
 * are `rig slack verify`. Never throws; reports what's missing.
 *
 * S10: outbound posts via the Web API (`chat.postMessage`) on the in-daemon subsystem — the
 * bot token + channel are the outbound gate now; the incoming webhook retired with the relay.
 */
export function staticReadiness(cfg: SlackConnectorConfig, hasBotToken: boolean, hasAppToken: boolean): ReadinessItem[] {
  return [
    { ok: cfg.secretsEnvFile !== null || hasBotToken, label: "secrets-source", detail: cfg.secretsEnvFile ? `env file ${cfg.secretsEnvFile}` : "env vars only" },
    { ok: hasBotToken, label: "bot-token", detail: hasBotToken ? "resolved" : "unset (outbound cannot post; scope/membership verify unavailable)" },
    { ok: hasAppToken, label: "app-token (Socket Mode)", detail: hasAppToken ? "resolved" : "unset (inbound cannot connect)" },
    { ok: cfg.channel !== null, label: "channel", detail: cfg.channel ?? "unset (outbound cannot post)" },
    { ok: Boolean(cfg.inboundDestination), label: "inbound-destination", detail: cfg.inboundDestination },
    { ok: cfg.enabled, label: "enabled", detail: cfg.enabled ? "yes" : "no (run `rig slack enable`)" },
    ...channelMapReadiness(cfg),
  ];
}

/** #192: one row only when a channel map is set. Fields this version does not support make the
 *  row fail loudly: they are ignored, and saving the config refuses them. */
function channelMapReadiness(cfg: SlackConnectorConfig): ReadinessItem[] {
  if (!cfg.channelMap?.length) return [];
  const channels = new Set(cfg.channelMap.map((e) => e.channel)).size;
  const summary = `${cfg.channelMap.length} entr${cfg.channelMap.length === 1 ? "y" : "ies"} over ${channels} channel(s); \`rig slack verify\` checks membership in each`;
  const unsupported = unsupportedChannelMapFields(cfg);
  return [unsupported.length
    ? { ok: false, label: "channel-map", detail: `${summary}; IGNORED unsupported field(s) ${unsupported.join(", ")} (written by a newer OpenRig?); remove them before saving the config` }
    : { ok: true, label: "channel-map", detail: summary }];
}
