import type { Migration } from "../migrate.js";

// Phase 1 — a request that only needs the human to acknowledge it (a ✅), without buttons.
export const humanAckSchema: Migration = {
  name: "097_human_ack.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN human_ack INTEGER;
  `,
};
