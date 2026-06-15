-- My Shares (anonymous sync key registry) — owner columns + indexes.
-- One-shot ALTERs for the live D1. Fresh deploys pick these up from
-- db/schema.sql (which is the authoritative table definition).
--
-- Apply once: wrangler d1 execute quick-html-sharing --remote --env api \
--               --file=db/migrations/0002-add-shares-owner.sql

ALTER TABLE shares ADD COLUMN owner_key_hash TEXT;          -- sha256 of the sync key; NULL = unclaimed
ALTER TABLE shares ADD COLUMN owner_claimed_at INTEGER;     -- when ownership was claimed

-- v2 vault placeholders (NOT implemented in v1; columns reserved to mark
-- intent in the schema — client-side-encrypted edit token storage):
ALTER TABLE shares ADD COLUMN vault_ciphertext TEXT;
ALTER TABLE shares ADD COLUMN vault_updated_at INTEGER;

-- Composite partial index: the My Shares cursor pagination query is
--   WHERE owner_key_hash = ? AND (created_at, slug) < cursor
--   ORDER BY created_at DESC, slug DESC
-- A single-column index degrades to scan+sort over the whole owner set
-- (D1 bills rows_read); the composite key makes pagination a pure seek.
-- slug is a required tiebreaker: created_at has second precision, so
-- same-second uploads would make a cursor without it skip or repeat rows.
CREATE INDEX IF NOT EXISTS idx_shares_owner
    ON shares (owner_key_hash, created_at DESC, slug DESC)
    WHERE owner_key_hash IS NOT NULL;

-- Claim does a reverse lookup by edit_token_hash; without this it's a
-- full table scan per token.
CREATE INDEX IF NOT EXISTS idx_shares_edit_token
    ON shares (edit_token_hash);
