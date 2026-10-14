import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RuntimeHomes } from "./types.js";

const HOME_KEYS = ["claude", "codex"] as const;

export function validateRuntimeHomes(value: unknown, prefix: string, home = homedir()): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${prefix}: must be a mapping of runtime to home dir (claude, codex)`];
  return Object.entries(value).flatMap(([key, dir]) => {
    if (!(HOME_KEYS as readonly string[]).includes(key)) return [`${prefix}.${key}: unknown runtime home (expected claude or codex)`];
    if (typeof dir !== "string" || !(path.isAbsolute(dir) || dir.startsWith("~/"))) return [`${prefix}.${key}: must be an absolute path or start with ~/`];
    if (key === "codex" && !existsSync(expandHome(dir, home))) return [`${prefix}.codex: ${dir} does not exist; log in there first (CODEX_HOME=${expandHome(dir, home)} codex login)`];
    return [];
  });
}

function expandHome(dir: string, home: string): string {
  return dir.startsWith("~/") ? path.join(home, dir.slice(2)) : path.resolve(dir);
}

/** The homes a seat launches with: its member's keys over the rig's, as absolute paths. */
export function resolveRuntimeHomes(rig: RuntimeHomes | undefined, member: RuntimeHomes | undefined, home = homedir()): RuntimeHomes {
  const homes: RuntimeHomes = {};
  for (const key of HOME_KEYS) {
    const dir = member?.[key] ?? rig?.[key];
    if (dir) homes[key] = expandHome(dir, home);
  }
  return homes;
}

export function runtimeHomeEnv(homes: RuntimeHomes, runtime: string | null | undefined): Record<string, string> {
  if (runtime === "claude-code" && homes.claude) return { CLAUDE_CONFIG_DIR: homes.claude };
  if (runtime === "codex" && homes.codex) return { CODEX_HOME: homes.codex };
  return {};
}

export interface HomeColumns { claude_config_dir?: string | null; codex_home?: string | null }

export function homesFromColumns(row: HomeColumns): RuntimeHomes {
  return { ...(row.claude_config_dir ? { claude: row.claude_config_dir } : {}), ...(row.codex_home ? { codex: row.codex_home } : {}) };
}

/** The homes of the seat that currently or last held this session name. */
export function sessionRuntimeHomes(db: Database.Database, sessionName: string): RuntimeHomes {
  const row = db.prepare("SELECT node_id FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1").get(sessionName) as { node_id: string } | undefined;
  return row ? nodeRuntimeHomes(db, row.node_id) : {};
}

export function sessionClaudeConfigDir(db: Database.Database, sessionName: string): string | undefined {
  return sessionRuntimeHomes(db, sessionName).claude;
}

export function seatCodexHomeDirs(db: Database.Database): string[] {
  const hasColumn = (db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>).some((c) => c.name === "codex_home");
  if (!hasColumn) return [];
  return (db.prepare("SELECT DISTINCT codex_home FROM nodes WHERE codex_home IS NOT NULL").all() as Array<{ codex_home: string }>).map((r) => r.codex_home);
}

/** A database without a home column (migrations 102, 103) has no seat with that home. */
export function nodeRuntimeHomes(db: Database.Database, nodeId: string): RuntimeHomes {
  const columns = (db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>).map((c) => c.name)
    .filter((name) => name === "claude_config_dir" || name === "codex_home");
  if (!columns.length) return {};
  const row = db.prepare(`SELECT ${columns.join(", ")} FROM nodes WHERE id = ?`).get(nodeId) as HomeColumns | undefined;
  return row ? homesFromColumns(row) : {};
}
