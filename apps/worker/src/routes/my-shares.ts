import {
  CLAIM_MAX_TOKENS,
  type ClaimOutcome,
  type ClaimResponse,
  MY_SHARES_DEFAULT_LIMIT,
  MY_SHARES_MAX_LIMIT,
  type MySharesResponse,
} from '@qhs/shared';
import { Hono } from 'hono';
import { sha256Hex } from '../lib/hash';
import { mySharesRateLimit } from '../middleware/my-shares-rate-limit';
import { syncKeyAuth } from '../middleware/sync-key';
import type { AppEnv } from '../types';

/**
 * My Shares — anonymous sync key registry.
 *
 * Both endpoints require `Authorization: Bearer qhsk_...` (syncKeyAuth).
 * Responses NEVER contain sync keys, key hashes, or edit token hashes —
 * pinned by the security-invariant tests.
 */
export const mySharesRoute = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Cursor encoding — opaque to clients.
//
// A cursor is base64url("<created_at>:<slug>") of the last row on the page.
// Both fields are needed: created_at has second precision, so slug tiebreaks
// same-second uploads (without it a cursor would skip or repeat rows).
// ---------------------------------------------------------------------------

function encodeCursor(createdAt: number, slug: string): string {
  return btoa(`${createdAt}:${slug}`).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string): { createdAt: number; slug: string } | null {
  let raw: string;
  try {
    raw = atob(cursor.replaceAll('-', '+').replaceAll('_', '/'));
  } catch {
    return null;
  }
  const sep = raw.indexOf(':');
  if (sep === -1) return null;
  const createdAt = Number(raw.slice(0, sep));
  const slug = raw.slice(sep + 1);
  if (!Number.isInteger(createdAt) || slug.length === 0) return null;
  return { createdAt, slug };
}

/**
 * GET /api/my-shares?cursor=...&limit=...
 *
 * Lists committed shares owned by the caller's sync key, newest first.
 * Pagination is a pure seek on idx_shares_owner:
 *   WHERE owner_key_hash = ? AND (created_at, slug) < (cursor)
 *   ORDER BY created_at DESC, slug DESC
 *
 * Deliberately NOT included (eng-review contract): titles (local-only
 * metadata), view counts (would force an aggregate per page load — use
 * GET /api/share/:slug/stats), and any token or hash material.
 */
mySharesRoute.get('/my-shares', syncKeyAuth, mySharesRateLimit, async (c) => {
  const ownerKeyHash = c.get('ownerKeyHash');

  const limitParam = c.req.query('limit');
  let limit = MY_SHARES_DEFAULT_LIMIT;
  if (limitParam !== undefined) {
    limit = Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > MY_SHARES_MAX_LIMIT) {
      return c.json(
        { error: 'bad_request', message: `limit must be an integer 1-${MY_SHARES_MAX_LIMIT}.` },
        400,
      );
    }
  }

  const cursorParam = c.req.query('cursor');
  let cursor: { createdAt: number; slug: string } | null = null;
  if (cursorParam !== undefined) {
    cursor = decodeCursor(cursorParam);
    if (!cursor) {
      return c.json({ error: 'bad_request', message: 'Malformed cursor.' }, 400);
    }
  }

  // Fetch limit+1 to know whether another page exists without a COUNT query.
  // status filter is residual (deleted rows keep owner_key_hash); the seek
  // itself rides idx_shares_owner.
  const rows = cursor
    ? await c.env.DB.prepare(
        `SELECT slug, created_at FROM shares
         WHERE owner_key_hash = ?1 AND status = 'committed' AND (created_at, slug) < (?2, ?3)
         ORDER BY created_at DESC, slug DESC LIMIT ?4`,
      )
        .bind(ownerKeyHash, cursor.createdAt, cursor.slug, limit + 1)
        .all<{ slug: string; created_at: number }>()
    : await c.env.DB.prepare(
        `SELECT slug, created_at FROM shares
         WHERE owner_key_hash = ?1 AND status = 'committed'
         ORDER BY created_at DESC, slug DESC LIMIT ?2`,
      )
        .bind(ownerKeyHash, limit + 1)
        .all<{ slug: string; created_at: number }>();

  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = page[page.length - 1];

  const body: MySharesResponse = {
    shares: page.map((row) => ({
      slug: row.slug,
      createdAt: new Date(row.created_at * 1000).toISOString(),
      shareUrl: `https://${c.env.SHARE_HOST}/${row.slug}`,
    })),
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.slug) : null,
  };
  return c.json(body);
});

/**
 * POST /api/my-shares/claim
 *
 * Body: { editTokens: string[] } (≤ CLAIM_MAX_TOKENS; clients loop batches).
 * Bulk-enrolls existing shares by proving edit-token possession.
 *
 * Ownership transfer is ATOMIC (eng-review Issue 1A): the conditional UPDATE
 * is the source of truth — never SELECT-then-UPDATE, or two keys claiming the
 * same token concurrently would race. The pre-SELECT below only labels
 * outcomes (claimed vs already-yours, owned-by-other vs not-found); a race
 * can at worst mislabel, never mis-own.
 *
 * Only committed shares are claimable — pending/deleted uniformly report
 * not-found so the response doesn't leak lifecycle state.
 */
mySharesRoute.post('/my-shares/claim', syncKeyAuth, mySharesRateLimit, async (c) => {
  const ownerKeyHash = c.get('ownerKeyHash');
  if (!ownerKeyHash) {
    // syncKeyAuth guarantees this; belt-and-braces for type narrowing.
    return c.json({ error: 'missing_sync_key', message: 'Sync key required.' }, 401);
  }

  const body = await c.req
    .json<{ editTokens?: unknown }>()
    .catch(() => ({}) as { editTokens?: unknown });
  const tokens = body.editTokens;
  if (!Array.isArray(tokens) || tokens.some((t) => typeof t !== 'string' || t.length === 0)) {
    return c.json({ error: 'bad_request', message: 'Body must be { editTokens: string[] }.' }, 400);
  }
  if (tokens.length > CLAIM_MAX_TOKENS) {
    return c.json(
      { error: 'bad_request', message: `At most ${CLAIM_MAX_TOKENS} editTokens per call.` },
      400,
    );
  }
  if (tokens.length === 0) {
    return c.json({ results: [] } satisfies ClaimResponse);
  }

  const now = Math.floor(Date.now() / 1000);
  const hashes = await Promise.all(tokens.map((t) => sha256Hex(t)));

  // Prior state — classification only (see header comment).
  const prior = await c.env.DB.batch<{
    slug: string;
    status: string;
    owner_key_hash: string | null;
  }>(
    hashes.map((h) =>
      c.env.DB.prepare(
        `SELECT slug, status, owner_key_hash FROM shares WHERE edit_token_hash = ?`,
      ).bind(h),
    ),
  );

  // Atomic transfer — the WHERE clause is the ownership gate.
  const updates = await c.env.DB.batch<{ slug: string }>(
    hashes.map((h) =>
      c.env.DB.prepare(
        `UPDATE shares SET owner_key_hash = ?1, owner_claimed_at = ?2
         WHERE edit_token_hash = ?3 AND status = 'committed'
           AND (owner_key_hash IS NULL OR owner_key_hash = ?1)
         RETURNING slug`,
      ).bind(ownerKeyHash, now, h),
    ),
  );

  const results = tokens.map((_, i) => {
    const claimedSlug = updates[i]?.results?.[0]?.slug ?? null;
    const before = prior[i]?.results?.[0];
    if (claimedSlug) {
      const result: ClaimOutcome =
        before?.owner_key_hash === ownerKeyHash ? 'already-yours' : 'claimed';
      return { result, slug: claimedSlug };
    }
    const ownedByOther =
      before !== undefined &&
      before.status === 'committed' &&
      before.owner_key_hash !== null &&
      before.owner_key_hash !== ownerKeyHash;
    return { result: (ownedByOther ? 'owned-by-other' : 'not-found') as ClaimOutcome, slug: null };
  });

  return c.json({ results } satisfies ClaimResponse);
});
