import type { Migration } from "../migrate.js";

/**
 * rigs.codex_managed_block_file — the rig-level `managed_blocks.codex` selection
 * (`AGENTS.md` or `AGENTS.override.md`). NULL = the AGENTS.md default. Mirrors
 * migration 085 (rigs.claude_managed_block_file).
 */
export const rigCodexManagedBlockFileSchema: Migration = {
  name: "104_rig_codex_managed_block_file.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN codex_managed_block_file TEXT;
  `,
};
