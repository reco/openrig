#!/usr/bin/env node
// Operator backfill: cards closed as answered in the terminal before the compact format become one bold
// line, their details in the bot's own closing reply. Dry run by default (reads the queue read-only, no Slack
// call, writes nothing). Run from a built checkout of the installed commit (it imports ../dist).
//   node scripts/compact-terminal-resolved-cards.mjs [--home <OPENRIG_HOME>]                    # plan every candidate
//   node scripts/compact-terminal-resolved-cards.mjs --apply --limit 20                           # the next 20, oldest first
//   node scripts/compact-terminal-resolved-cards.mjs --apply --qitem <id> [--qitem <id>]          # exactly these
// Resume by running it again: a card or reply already compact is kept, and a row whose printed note was
// recorded is not planned again. It stops at the first failure (a rate limit included) and exits 1.
// After --apply, record each printed note on its row: rig queue update <id> --note "<note>".
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { applyTerminalResolvedCard, planTerminalResolvedCards } from "../dist/domain/gateway/slack/terminal-card-backfill.js";
import { callWebApi, postChatMessage, updateChatMessage } from "../dist/domain/gateway/slack/slack-api.js";
import { loadConfig } from "../dist/domain/gateway/slack/config.js";
import { resolveSecret } from "../dist/domain/gateway/slack/secrets.js";

const PACE_MS = 1500;
const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const home = value("--home") ?? process.env.OPENRIG_HOME ?? path.join(os.homedir(), ".openrig");
const only = args.flatMap((a, i) => (a === "--qitem" ? [args[i + 1]] : []));
const limit = value("--limit") === undefined ? undefined : Number(value("--limit"));
const apply = args.includes("--apply");
if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) { console.error("--limit needs a positive whole number"); process.exit(2); }
if (apply && only.length === 0 && limit === undefined) { console.error("--apply needs --limit <n> or --qitem <id> (the cards you reviewed in the dry run)"); process.exit(2); }

const cfg = loadConfig(home);
const db = new Database(path.join(home, "openrig.sqlite"), { readonly: true, fileMustExist: true });
const planned = planTerminalResolvedCards(db, only.length ? only : undefined);
db.close();
const cards = limit === undefined ? planned : planned.slice(0, limit);
const missing = only.filter((id) => !planned.some((c) => c.qitemId === id));
for (const c of cards) console.log(JSON.stringify({ qitemId: c.qitemId, provenance: c.provenance, channel: c.channel, messageTs: c.messageTs, line: c.line }));
if (missing.length) console.error(`not eligible (not closed as answered in the terminal, answered, no card, or already compact): ${missing.join(", ")}`);
const count = (p) => planned.filter((c) => c.provenance === p).length;
console.error(`candidates: ${planned.length} (stuck-prompt ${count("stuck-prompt")}, approval ${count("approval")}); this run: ${cards.length}`);
if (!apply) { console.error("dry run: nothing written"); process.exit(missing.length ? 1 : 0); }

const bot = resolveSecret("SLACK_BOT_TOKEN", { envFile: cfg.secretsEnvFile ?? undefined });
if (!bot) { console.error("SLACK_BOT_TOKEN unresolved; nothing written"); process.exit(2); }
const auth = await callWebApi("auth.test", bot, {});
const botUser = auth.ok ? String(auth.json.user_id ?? "") : "";
if (!botUser) { console.error(`auth.test failed (${auth.error}); nothing written`); process.exit(2); }
const slack = {
  botUser,
  replies: async (channel, ts) => {
    const r = await callWebApi("conversations.replies", bot, { channel, ts, limit: 200 }, undefined, undefined, "get-query");
    return r.ok ? { ok: true, messages: Array.isArray(r.json.messages) ? r.json.messages : [] } : { ok: false, error: r.error };
  },
  update: (channel, ts, message) => updateChatMessage(bot, { channel, ts, ...message }),
  post: (channel, threadTs, text) => postChatMessage(bot, { channel, thread_ts: threadTs, text }),
};
let failed = false;
for (const [i, card] of cards.entries()) {
  if (i > 0) await new Promise((r) => setTimeout(r, PACE_MS));
  const r = await applyTerminalResolvedCard(card, slack);
  console.log(JSON.stringify({ qitemId: r.qitemId, ok: r.ok, card: r.card, reply: r.reply, ...(r.error ? { error: r.error } : {}) }));
  if (r.note) console.log(`rig queue update ${r.qitemId} --note ${JSON.stringify(r.note)}`);
  if (!r.ok) { failed = true; console.error(`stopped at ${r.qitemId}; run again to resume`); break; }
}
if (missing.length || failed) process.exit(1);
