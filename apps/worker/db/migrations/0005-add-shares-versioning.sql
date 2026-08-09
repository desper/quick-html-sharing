-- Version history: edit writes a new version instead of overwriting.
-- One-shot ALTERs for the live D1. Fresh deploys pick these up from
-- db/schema.sql (which is the authoritative table definition).
--
-- Apply once: wrangler d1 execute quick-html-sharing --remote --env api \
--               --file=db/migrations/0005-add-shares-versioning.sql
--
-- DEPLOY ORDER (this migration must go FIRST):
--   1. this migration      ← both workers still run old code; the DEFAULTs
--                            make every existing row correct (one version,
--                            living at the pre-versioning flat key)
--   2. wrangler deploy --env share   ← renderer learns to read latest_version
--   3. wrangler deploy --env api     ← only now does anything write v2+
--
-- Reversing 2 and 3 (which is what `bun run deploy` used to do) means the new
-- API advances latest_version while the old share worker still serves the flat
-- v1 key, so visitors see stale content until the share worker catches up.

ALTER TABLE shares ADD COLUMN latest_version INTEGER NOT NULL DEFAULT 1;

-- How far the retention sweep has already pruned. Without it the sweep never
-- converges: latest_version only ever grows, so `latest_version > N` stays
-- true forever even for a share that was cleaned long ago — and with a
-- per-run cap the same shares would be re-scanned every 10 minutes while
-- everything behind them starved. Also doubles as the "R2 objects confirmed
-- gone" marker for deleted shares, whose best-effort delete may have failed.
ALTER TABLE shares ADD COLUMN versions_pruned_below INTEGER NOT NULL DEFAULT 1;

-- Set when a writer wins the R2 create but loses the D1 CAS, leaving an object
-- nothing references. Without this signal the sweep would only ever notice
-- orphans on shares that had also crossed the retention threshold, so an
-- orphan on a two-version share would sit in R2 forever. NULL = nothing known
-- to collect; the sweep clears it back to NULL once the share is clean.
ALTER TABLE shares ADD COLUMN orphan_since INTEGER;
