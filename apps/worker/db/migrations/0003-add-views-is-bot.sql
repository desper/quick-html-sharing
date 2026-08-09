-- Bot / link-unfurl filtering for view counts.
-- One-shot ALTER for the live D1. Fresh deploys pick this up from
-- db/schema.sql (which is the authoritative table definition).
--
-- Apply once: wrangler d1 execute quick-html-sharing --remote --env api \
--               --file=db/migrations/0003-add-views-is-bot.sql
--
-- Existing rows default to 0 (human). They are NOT backfilled: the raw `ua`
-- is still there, but rewriting history would silently change every share's
-- published view count. New views are classified from this deploy onward.

ALTER TABLE views ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0;  -- 1 = crawler/unfurler, excluded from `views`

-- The stats aggregates all filter on is_bot, so it belongs in the index key
-- rather than as a post-scan filter — otherwise a share with heavy crawler
-- traffic reads (and D1 bills) rows it always discards.
CREATE INDEX IF NOT EXISTS idx_views_slug_human
    ON views (slug, is_bot, viewed_at DESC);
