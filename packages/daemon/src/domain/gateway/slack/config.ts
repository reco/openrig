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
  /** Phase 1: the reaction emoji (standard or the workspace's custom names) a received human
   *  message shows as the seat progresses. */
  receipts: { received: string; picked: string; coding: string; typing: string; done: string };
  /** More channels beside `channel`, each landing its new messages on its own seat. */
  extraChannels: Array<{ id: string; inboundDestination: string }>;
  /** Seats (session names) whose permission prompts go to Slack as Approve / Deny buttons. */
  approvalSeats: string[];
  /** Reaction names (the workspace's custom ones included) that count as 👍 or 👎 feedback. */
  feedbackReactions: { up: string[]; down: string[] };
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
  receipts: { received: "eyes", picked: "thinking_face", coding: "keyboard", typing: "writing_hand", done: "white_check_mark" },
  extraChannels: [],
  feedbackReactions: { up: ["+1", "thumbsup"], down: ["-1", "thumbsdown"] },
  approvalSeats: [],
};

/** Every configured channel with the seat its new messages land on; `channel` first. */
export function channelsOf(cfg: SlackConnectorConfig): Array<{ id: string; inboundDestination: string }> {
  return [...(cfg.channel ? [{ id: cfg.channel, inboundDestination: cfg.inboundDestination }] : []), ...cfg.extraChannels];
}

function validateLevel(field: string, value: unknown): asserts value is OwnerNotificationLevel {
  if (!OWNER_NOTIFICATION_LEVELS.includes(value as OwnerNotificationLevel)) {
    throw new Error(`${field} must be one of ${OWNER_NOTIFICATION_LEVELS.join(", ")} (got ${String(value)})`);
  }
}

function validateConfig(cfg: SlackConnectorConfig): void {
  validateLevel("minimumLevelThatPosts", cfg.minimumLevelThatPosts);
  validateLevel("minimumLevelThatInterrupts", cfg.minimumLevelThatInterrupts);
  for (const [stage, name] of Object.entries(cfg.receipts ?? {})) {
    if (typeof name !== "string" || !/^[a-z0-9_+'-]+$/.test(name)) throw new Error(`receipts.${stage} must be a Slack emoji name without colons (got ${String(name)})`);
  }
  const names = Object.values(cfg.receipts ?? {});
  if (new Set(names).size !== names.length) {
    throw new Error("receipts needs a different emoji name for each stage (received, picked, coding, typing, done)");
  }
  if (!Array.isArray(cfg.extraChannels) || cfg.extraChannels.some((c) => !c || typeof c.id !== "string" || !/^[A-Z0-9-]+$/.test(c.id) || typeof c.inboundDestination !== "string" || !c.inboundDestination)) {
    throw new Error("extraChannels must be a list of { id: <Slack channel id>, inboundDestination: <seat> }");
  }
  const ids = channelsOf(cfg).map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw new Error("each Slack channel may be configured once (channel + extraChannels)");
  const { up, down } = cfg.feedbackReactions ?? {};
  if (!Array.isArray(up) || !Array.isArray(down) || [...up, ...down].some((n) => typeof n !== "string" || !/^[a-z0-9_+'-]+$/.test(n))) {
    throw new Error("feedbackReactions must be { up: [emoji names], down: [emoji names] } without colons");
  }
  if (up.some((n) => down.includes(n))) throw new Error("feedbackReactions: an emoji cannot be both up and down");
  if (!Array.isArray(cfg.approvalSeats) || cfg.approvalSeats.some((s) => typeof s !== "string" || !s.includes("@"))) {
    throw new Error("approvalSeats must be a list of seat session names (member@rig)");
  }
  if (typeof cfg.staleReminderDays !== "number" || !(cfg.staleReminderDays > 0)) {
    throw new Error(`staleReminderDays must be a positive number of days (got ${String(cfg.staleReminderDays)})`);
  }
}

/** The retired 'working' stage (thinking now lasts until coding, typing or done). */
function withoutWorking(receipts: Partial<SlackConnectorConfig["receipts"]> & { working?: string } | undefined): Partial<SlackConnectorConfig["receipts"]> {
  const { working: _retired, ...rest } = receipts ?? {};
  return rest;
}

export function configPathFor(home?: string): string {
  return path.join(home ?? getOpenRigHome(), "slack-connector.json");
}

export function loadConfig(home?: string): SlackConnectorConfig {
  const p = configPathFor(home);
  let raw: Partial<SlackConnectorConfig> & { alertTag?: unknown };
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<SlackConnectorConfig> & { alertTag?: unknown };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  const { alertTag: _retiredAlertTag, ...supported } = raw;
  const cfg = { ...DEFAULT_CONFIG, ...supported, receipts: { ...DEFAULT_CONFIG.receipts, ...withoutWorking(supported.receipts) },
    feedbackReactions: { ...DEFAULT_CONFIG.feedbackReactions, ...(supported.feedbackReactions ?? {}) } };
  validateConfig(cfg);
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
  ];
}
