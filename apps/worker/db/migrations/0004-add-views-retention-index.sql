-- Retention sweep support: index for anonymizeOldViews().
-- Fresh deploys pick this up from db/schema.sql (authoritative).
--
-- Apply once: wrangler d1 execute quick-html-sharing --remote --env api \
--               --file=db/migrations/0004-add-views-retention-index.sql

-- Partial index over exactly the rows the sweep can act on — those still
-- holding raw ua/referrer. Two properties matter:
--   1. The sweep runs on the shared 10-minute cron but only has real work
--      once a day; with this index the no-op runs are an empty probe rather
--      than a full scan of the views table (D1 bills rows_read).
--   2. Rows leave the index as they are anonymized, so it stays small
--      regardless of how large views grows.
CREATE INDEX IF NOT EXISTS idx_views_retention
    ON views (viewed_at)
    WHERE ua IS NOT NULL OR referrer IS NOT NULL;
