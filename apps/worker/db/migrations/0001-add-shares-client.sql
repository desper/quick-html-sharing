-- One-shot ALTER for the live D1. Fresh deploys pick this column up from
-- db/schema.sql (which is the authoritative table definition). Existing
-- production rows backfill to 'other'.
--
-- Apply once: wrangler d1 execute quick-html-sharing --remote --env api \
--               --file=db/migrations/0001-add-shares-client.sql

ALTER TABLE shares ADD COLUMN client TEXT NOT NULL DEFAULT 'other';
