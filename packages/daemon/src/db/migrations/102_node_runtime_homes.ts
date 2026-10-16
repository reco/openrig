import type { Migration } from "../migrate.js";

export const nodeRuntimeHomesSchema: Migration = {
  name: "102_node_runtime_homes.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN claude_config_dir TEXT;
    ALTER TABLE rigs ADD COLUMN claude_config_dir TEXT;
  `,
};
