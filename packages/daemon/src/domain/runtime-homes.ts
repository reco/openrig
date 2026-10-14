import type Database from "better-sqlite3";
import { homedir } from "node:os";
import path from "node:path";
import type { RuntimeHomes } from "./types.js";

export function validateRuntimeHomes(value: unknown, prefix: string): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${prefix}: must be a mapping with a claude config dir`];
  return Object.entries(value).flatMap(([key, dir]) => {
    if (key === "codex") return [`${prefix}.codex: a per-seat Codex home is not supported yet`];
    if (key !== "claude") return [`${prefix}.${key}: unknown runtime home (expected claude)`];
    if (typeof dir !== "string" || !(path.isAbsolute(dir) || dir.startsWith("~/"))) return [`${prefix}.claude: must be an absolute path or start with ~/`];
    return [];
  });
}

/** The homes a seat launches with: its member's keys over the rig's, as absolute paths. */
export function resolveRuntimeHomes(rig: RuntimeHomes | undefined, member: RuntimeHomes | undefined, home = homedir()): RuntimeHomes {
  const claude = member?.claude ?? rig?.claude;
  if (!claude) return {};
  return { claude: claude.startsWith("~/") ? path.join(home, claude.slice(2)) : path.resolve(claude) };
}

export function runtimeHomeEnv(homes: RuntimeHomes, runtime: string | null | undefined): Record<string, string> {
  return runtime === "claude-code" && homes.claude ? { CLAUDE_CONFIG_DIR: homes.claude } : {};
}

/** The Claude config dir of the seat that currently or last held this session name. */
export function sessionClaudeConfigDir(db: Database.Database, sessionName: string): string | undefined {
  const row = db.prepare("SELECT node_id FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1").get(sessionName) as { node_id: string } | undefined;
  return row ? nodeRuntimeHomes(db, row.node_id).claude : undefined;
}

/** A database without the column (migration 102) has no seat with its own home. */
export function nodeRuntimeHomes(db: Database.Database, nodeId: string): RuntimeHomes {
  const hasColumn = (db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>).some((c) => c.name === "claude_config_dir");
  if (!hasColumn) return {};
  const row = db.prepare("SELECT claude_config_dir FROM nodes WHERE id = ?").get(nodeId) as { claude_config_dir: string | null } | undefined;
  return row?.claude_config_dir ? { claude: row.claude_config_dir } : {};
}
