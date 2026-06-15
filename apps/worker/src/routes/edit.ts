import { Hono } from 'hono';
import { MAX_HTML_BYTES, type EditRequest, type ShareRow } from '@qhs/shared';
import type { AppEnv } from '../types';
import { sha256Hex } from '../lib/hash';
import { timingSafeEqual } from '../lib/tokens';
import { syncKeyOptional } from '../middleware/sync-key';
import { htmlObjectKey } from './upload';

/**
 * POST /api/edit/:slug
 * Body: { html, editToken }
 *
 * Auth via timing-safe compare of sha256(editToken) vs stored hash.
 * Replaces R2 object only — does not change slug, edit_token_hash, or any
 * D1 metadata. Tombstoned (deleted) shares cannot be revived via edit.
 */
export const editRoute = new Hono<AppEnv>();

editRoute.post('/edit/:slug', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req
    .json<Partial<EditRequest>>()
    .catch(() => ({}) as Partial<EditRequest>);

  if (typeof body.html !== 'string' || typeof body.editToken !== 'string') {
    return c.json({ error: 'bad_request', message: 'Missing html or editToken.' }, 400);
  }
  const byteLength = new TextEncoder().encode(body.html).byteLength;
  if (byteLength > MAX_HTML_BYTES) {
    return c.json({ error: 'payload_too_large', message: `Max ${MAX_HTML_BYTES} bytes.` }, 413);
  }

  const row = await c.env.DB.prepare(
    `SELECT slug, status, edit_token_hash FROM shares WHERE slug = ?`,
  )
    .bind(slug)
    .first<Pick<ShareRow, 'slug' | 'status' | 'edit_token_hash'>>();

  if (!row || row.status === 'deleted') {
    return c.json({ error: 'not_found', message: 'Share not found.' }, 404);
  }
  if (row.status !== 'committed') {
    return c.json({ error: 'conflict', message: 'Share not ready.' }, 409);
  }

  const incomingHash = await sha256Hex(body.editToken);
  if (!timingSafeEqual(incomingHash, row.edit_token_hash)) {
    return c.json({ error: 'forbidden', message: 'Bad edit token.' }, 403);
  }

  await c.env.HTML_BUCKET.put(htmlObjectKey(slug), body.html, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });

  await c.env.DB.prepare(
    `UPDATE shares SET content_size = ? WHERE slug = ?`,
  )
    .bind(byteLength, slug)
    .run();

  return c.json({ slug, ok: true });
});

/**
 * DELETE /api/share/:slug
 *
 * Two authorization paths with MUTUALLY EXCLUSIVE priority — no cross
 * fallback (eng-review Issue 6A); every 403 points at exactly one credential:
 *
 *   Authorization: Bearer qhsk_...  → owner-key path. Key must own the share
 *                                     (owner_key_hash match) or 403 — the
 *                                     editToken in the body, if any, is
 *                                     deliberately ignored.
 *   no header + body { editToken }  → original edit-token path, unchanged.
 *   neither                         → 400.
 *
 * Deletion is an ownership action (premise P3): owner-key suffices, no edit
 * token required. Soft-deletes (status='deleted', deleted_at=now) and
 * removes the R2 object. Subsequent GETs on the share subdomain return 404.
 */
editRoute.delete('/share/:slug', syncKeyOptional, async (c) => {
  const slug = c.req.param('slug');
  const ownerKeyHash = c.get('ownerKeyHash');
  const body = await c.req
    .json<{ editToken?: string }>()
    .catch(() => ({}) as { editToken?: string });

  if (!ownerKeyHash && typeof body.editToken !== 'string') {
    return c.json(
      { error: 'bad_request', message: 'Provide a sync key bearer or an editToken.' },
      400,
    );
  }

  const row = await c.env.DB.prepare(
    `SELECT slug, status, edit_token_hash, owner_key_hash FROM shares WHERE slug = ?`,
  )
    .bind(slug)
    .first<Pick<ShareRow, 'slug' | 'status' | 'edit_token_hash' | 'owner_key_hash'>>();

  if (!row) {
    return c.json({ error: 'not_found', message: 'Share not found.' }, 404);
  }
  if (row.status === 'deleted') {
    return c.json({ slug, ok: true }); // idempotent
  }

  if (ownerKeyHash) {
    // Owner-key path. NULL owner also 403s: an unclaimed share can't be
    // deleted by key — claim it first (or use its edit token, sans header).
    if (!row.owner_key_hash || !timingSafeEqual(ownerKeyHash, row.owner_key_hash)) {
      return c.json({ error: 'forbidden', message: 'Sync key does not own this share.' }, 403);
    }
  } else {
    const incomingHash = await sha256Hex(body.editToken as string);
    if (!timingSafeEqual(incomingHash, row.edit_token_hash)) {
      return c.json({ error: 'forbidden', message: 'Bad edit token.' }, 403);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `UPDATE shares SET status = 'deleted', deleted_at = ? WHERE slug = ?`,
  )
    .bind(now, slug)
    .run();
  // R2 delete is best-effort: D1 says "deleted", that's the truth, R2 is just cache.
  await c.env.HTML_BUCKET.delete(htmlObjectKey(slug)).catch(() => undefined);

  return c.json({ slug, ok: true });
});
