-- Viewer location on view events.
--
-- Cloudflare resolves this per request and hands it over on `request.cf`, so
-- there is no GeoIP lookup, no extra latency, and no third party involved. It
-- is also the only way we could get it at all: the one field that could infer
-- location is the IP, and we store that as a salted one-way hash. That is why
-- this migration cannot backfill — every view before it is unrecoverable.
--
-- Both columns are nullable and stay that way. Cloudflare does not always
-- resolve a city (and occasionally not a country), and a missing value must
-- read as "unknown", never as a guess.
--
-- These are viewer PII and follow the same 90-day expiry as `ua` / `referrer`:
-- the retention sweep nulls all four together. Location is if anything more
-- sensitive than a user agent, so exempting it would be backwards.
ALTER TABLE views ADD COLUMN country TEXT;
ALTER TABLE views ADD COLUMN city TEXT;

-- The retention sweep selects rows that still hold any raw viewer field. The
-- 0004 index only knew about ua/referrer, so a row whose ua and referrer were
-- already NULL but which still carried location would never be swept — the
-- partial index it seeks on would not contain it. Rebuilt to cover all four.
DROP INDEX IF EXISTS idx_views_retention;
CREATE INDEX IF NOT EXISTS idx_views_retention
    ON views (viewed_at)
    WHERE ua IS NOT NULL OR referrer IS NOT NULL
       OR country IS NOT NULL OR city IS NOT NULL;
