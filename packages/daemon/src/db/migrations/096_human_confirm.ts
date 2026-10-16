import type { Migration } from "../migrate.js";

// Phase 1 — the reading an update offers its human to confirm with one click.
export const humanConfirmSchema: Migration = {
  name: "096_human_confirm.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN human_confirm TEXT;
  `,
};
