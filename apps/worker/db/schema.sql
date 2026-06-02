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
    client            TEXT    NOT NULL DEFAULT 'other'
);

CREATE INDEX IF NOT EXISTS idx_shares_status_created
    ON shares (status, created_at);

CREATE INDEX IF NOT EXISTS idx_shares_sender_created
    ON shares (sender_ip_hash, created_at);

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
    FOREIGN KEY (slug) REFERENCES shares(slug)
);

CREATE INDEX IF NOT EXISTS idx_views_slug_viewed
    ON views (slug, viewed_at DESC);

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
