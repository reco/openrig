import type { Migration } from "../migrate.js";

export const nodeCodexHomeSchema: Migration = {
  name: "103_node_codex_home.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN codex_home TEXT;
    ALTER TABLE rigs ADD COLUMN codex_home TEXT;
  `,
};
