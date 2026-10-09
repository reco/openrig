#!/usr/bin/env node
// Operator one-off: take the buttons off expired approval cards that closed before closed cards
// lost them. Dry run by default (prints the plan, reads the queue read-only, writes nothing).
// Run from a built checkout of the installed commit (it imports ../dist; the package does not ship it).
//   node scripts/retire-closed-approval-cards.mjs [--home <OPENRIG_HOME>]                 # plan every candidate
//   node scripts/retire-closed-approval-cards.mjs --qitem <id> [--qitem <id>] --apply      # rewrite exactly these cards
// After --apply, record each printed note on its row: rig queue update <id> --note "<note>".
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { planClosedApprovalCards, retireClosedApprovalCards } from "../dist/domain/gateway/slack/closed-card-backfill.js";
import { loadConfig } from "../dist/domain/gateway/slack/config.js";
import { resolveSecret } from "../dist/domain/gateway/slack/secrets.js";

const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const home = value("--home") ?? process.env.OPENRIG_HOME ?? path.join(os.homedir(), ".openrig");
const only = args.flatMap((a, i) => (a === "--qitem" ? [args[i + 1]] : []));
const apply = args.includes("--apply");
if (apply && only.length === 0) { console.error("--apply needs at least one --qitem <id> (the cards you reviewed in the dry run)"); process.exit(2); }

const cfg = loadConfig(home);
const db = new Database(path.join(home, "openrig.sqlite"), { readonly: true, fileMustExist: true });
const cards = planClosedApprovalCards(db, cfg.sourceLabel, only.length ? only : undefined);
db.close();
const missing = only.filter((id) => !cards.some((c) => c.qitemId === id));
for (const c of cards) console.log(JSON.stringify({ qitemId: c.qitemId, channel: c.channel, messageTs: c.messageTs, line: c.line, buttonsAfter: JSON.stringify(c.message.blocks).includes('"type":"actions"') }));
if (missing.length) console.error(`not eligible (answered, decided, not expired, no card, or already rewritten): ${missing.join(", ")}`);
if (!apply) { console.error(`dry run: ${cards.length} card(s); nothing written`); process.exit(missing.length ? 1 : 0); }

const bot = resolveSecret("SLACK_BOT_TOKEN", { envFile: cfg.secretsEnvFile ?? undefined });
if (!bot) { console.error("SLACK_BOT_TOKEN unresolved; nothing written"); process.exit(2); }
const results = await retireClosedApprovalCards(cards, bot);
for (const r of results) {
  console.log(JSON.stringify(r));
  console.log(`rig queue update ${r.qitemId} --note ${JSON.stringify(r.note)}`);
}
if (missing.length || results.some((r) => !r.ok)) process.exit(1);
