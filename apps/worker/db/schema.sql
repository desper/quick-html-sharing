-- quick-html-sharing D1 schema
--
-- Run locally: bun run --filter @qhs/worker db:apply:local
-- Run remote:  bun run --filter @qhs/worker db:apply:remote
--
-- Idempotent: uses CREATE IF NOT EXISTS so re-running is safe.

-- ----------------------------------------------------------------------------
-- shares: one row per uploaded HTML.
--
-- status flow:
--   pending   ─ insert at upload start, before R2 write
--      │
--      ▼  (R2 write OK)
--   committed
--      │
--      ▼  (sender deletes, or admin takedown)
--   deleted
--
-- A pending row older than 5 min with no committed/deleted transition is an
-- orphan from a failed upload — cleanup job removes it (and any R2 object).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shares (
    slug              TEXT    PRIMARY KEY,
    status            TEXT    NOT NULL CHECK (status IN ('pending', 'committed', 'deleted')),
    edit_token_hash   TEXT    NOT NULL,
    created_at        INTEGER NOT NULL,
    committed_at      INTEGER,
    deleted_at        INTEGER,
    sender_ip_hash    TEXT    NOT NULL,
    content_size      INTEGER NOT NULL DEFAULT 0,
    -- Classifies which surface created the share, derived from the request
    -- User-Agent at upload time. Values: 'mcp' | 'skill' | 'web' | 'curl' | 'other'.
    -- Lets us slice promo-channel reach without re-parsing UA strings.
    client            TEXT    NOT NULL DEFAULT 'other',
    -- My Shares (anonymous sync key registry):
    -- sha256 of the sync key; NULL = unclaimed. The raw key never reaches
    -- storage and never appears in URLs or logs.
    owner_key_hash    TEXT,
    owner_claimed_at  INTEGER,
    -- v2 vault placeholders (NOT implemented in v1; reserved to mark intent —
    -- client-side-encrypted edit token storage):
    vault_ciphertext  TEXT,
    vault_updated_at  INTEGER,
    -- Version history:
    --   latest_version        highest version that exists; monotonic, never
    --                         decreases (restore writes a NEW version rather
    --                         than moving a pointer, so there is no "current
    --                         version" concept separate from the maximum).
    --   versions_pruned_below oldest version the retention sweep has kept.
    --                         Exists so the sweep converges — see the note on
    --                         idx-less scanning in cleanup.ts.
    --   orphan_since          unix seconds when a writer last lost a CAS after
    --                         creating its object, leaving it unreferenced.
    --                         NULL once the sweep has collected it. Without
    --                         this the sweep only inspects shares that crossed
    --                         the retention threshold, so an orphan on a
    --                         two-version share would never be reclaimed.
    --
    -- These sit last on purpose: ALTER TABLE ADD COLUMN appends, so a database
    -- built from migration 0005 lands them here. Keeping this file in the same
    -- order means the two build paths produce byte-identical schemas, and any
    -- future diff between them is a real drift rather than noise.
    latest_version        INTEGER NOT NULL DEFAULT 1,
    versions_pruned_below INTEGER NOT NULL DEFAULT 1,
    orphan_since          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_shares_status_created
    ON shares (status, created_at);

CREATE INDEX IF NOT EXISTS idx_shares_sender_created
    ON shares (sender_ip_hash, created_at);

-- Composite partial index for My Shares cursor pagination:
--   WHERE owner_key_hash = ? AND (created_at, slug) < cursor
--   ORDER BY created_at DESC, slug DESC
-- The composite key makes pagination a pure seek (D1 bills rows_read);
-- slug is a required tiebreaker since created_at has second precision.
CREATE INDEX IF NOT EXISTS idx_shares_owner
    ON shares (owner_key_hash, created_at DESC, slug DESC)
    WHERE owner_key_hash IS NOT NULL;

-- Claim does a reverse lookup by edit_token_hash; without this it's a
-- full table scan per token.
CREATE INDEX IF NOT EXISTS idx_shares_edit_token
    ON shares (edit_token_hash);

-- ----------------------------------------------------------------------------
-- views: append-only log of page views on share pages.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS views (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT    NOT NULL,
    viewed_at   INTEGER NOT NULL,
    ip_hash     TEXT    NOT NULL,
    ua          TEXT,
    referrer    TEXT,
    -- 1 = crawler / link-unfurler, classified from the UA at write time.
    -- Kept (not dropped) so "Slack previewed it twice, nobody opened it" is a
    -- visible state; excluded from the headline `views` count.
    is_bot      INTEGER NOT NULL DEFAULT 0,
    -- Resolved by Cloudflare per request (`request.cf`), so no GeoIP lookup and
    -- no third party. Nullable and staying that way: CF does not always resolve
    -- a city, and a missing value must read as "unknown", never as a guess.
    -- Viewer PII — expires with ua/referrer at VIEW_PII_RETENTION_SECONDS.
    country     TEXT,
    city        TEXT,
    FOREIGN KEY (slug) REFERENCES shares(slug)
);

CREATE INDEX IF NOT EXISTS idx_views_slug_viewed
    ON views (slug, viewed_at DESC);

-- Stats aggregates always filter on is_bot; keeping it in the index key stops
-- D1 from reading (and billing) crawler rows it would immediately discard.
CREATE INDEX IF NOT EXISTS idx_views_slug_human
    ON views (slug, is_bot, viewed_at DESC);

-- Retention sweep (anonymizeOldViews) covers exactly the rows still holding a
-- raw viewer field. Rows drop out of the index as they are anonymized, so it
-- stays small and the sweep's frequent no-op runs are an empty probe instead
-- of a full scan.
--
-- All four fields are in the predicate, not just ua/referrer: a view with no
-- User-Agent header but a resolved location would otherwise sit outside the
-- index and never be swept.
CREATE INDEX IF NOT EXISTS idx_views_retention
    ON views (viewed_at)
    WHERE ua IS NOT NULL OR referrer IS NOT NULL
       OR country IS NOT NULL OR city IS NOT NULL;

-- ----------------------------------------------------------------------------
-- reports: abuse / phishing reports.
--
-- The (slug, reporter_ip_hash) UNIQUE constraint dedupes rapid resubmits from
-- the same reporter — without it, the abuse endpoint is itself abusable
-- (one bad actor floods admin email by spamming /report on a single slug).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    slug                TEXT    NOT NULL,
    reason              TEXT    NOT NULL,
    reporter_email      TEXT,
    reporter_ip_hash    TEXT    NOT NULL,
    reported_at         INTEGER NOT NULL,
    status              TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
    UNIQUE (slug, reporter_ip_hash),
    FOREIGN KEY (slug) REFERENCES shares(slug)
);

CREATE INDEX IF NOT EXISTS idx_reports_status_reported
    ON reports (status, reported_at DESC);
