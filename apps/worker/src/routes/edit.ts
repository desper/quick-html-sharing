import { Hono } from 'hono';
import { MAX_HTML_BYTES, type EditRequest, type ShareRow } from '@qhs/shared';
import type { AppEnv } from '../types';
import { sha256Hex } from '../lib/hash';
import { timingSafeEqual } from '../lib/tokens';
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
 * Body: { editToken }
 *
 * Soft-deletes (status='deleted', deleted_at=now) and removes the R2 object.
 * Subsequent GETs on the share subdomain return 404.
 */
editRoute.delete('/share/:slug', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req
    .json<{ editToken?: string }>()
    .catch(() => ({}) as { editToken?: string });

  if (typeof body.editToken !== 'string') {
    return c.json({ error: 'bad_request', message: 'Missing editToken.' }, 400);
  }

  const row = await c.env.DB.prepare(
    `SELECT slug, status, edit_token_hash FROM shares WHERE slug = ?`,
  )
    .bind(slug)
    .first<Pick<ShareRow, 'slug' | 'status' | 'edit_token_hash'>>();

  if (!row) {
    return c.json({ error: 'not_found', message: 'Share not found.' }, 404);
  }
  if (row.status === 'deleted') {
    return c.json({ slug, ok: true }); // idempotent
  }

  const incomingHash = await sha256Hex(body.editToken);
  if (!timingSafeEqual(incomingHash, row.edit_token_hash)) {
    return c.json({ error: 'forbidden', message: 'Bad edit token.' }, 403);
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
