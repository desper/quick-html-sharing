import { type EditRequest, MAX_HTML_BYTES, type ShareRow } from '@qhs/shared';
import { Hono } from 'hono';
import { authorizeShareOwnership } from '../lib/authorize';
import { sha256Hex } from '../lib/hash';
import { htmlObjectKey, versionPrefix } from '../lib/objectKey';
import { timingSafeEqual } from '../lib/tokens';
import { writeNewVersion } from '../lib/versions';
import { syncKeyOptional } from '../middleware/sync-key';
import { writeRateLimit } from '../middleware/write-rate-limit';
import type { AppEnv } from '../types';

/**
 * POST /api/edit/:slug
 * Body: { html, editToken }
 *
 * Auth via timing-safe compare of sha256(editToken) vs stored hash.
 *
 * Appends a new version rather than overwriting (see lib/versions.ts for the
 * write state machine and why its R2/D1 ordering is the reverse of upload's).
 * The share URL always serves the newest version, so the observable behaviour
 * is unchanged — what changes is that the previous content survives and can
 * be restored. Does not change slug or edit_token_hash. Tombstoned (deleted)
 * shares cannot be revived via edit.
 */
export const editRoute = new Hono<AppEnv>();

editRoute.post('/edit/:slug', writeRateLimit, async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req.json<Partial<EditRequest>>().catch(() => ({}) as Partial<EditRequest>);

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

  const result = await writeNewVersion(c.env, slug, body.html, byteLength);
  if (!result.ok) {
    if (result.reason === 'storage_failed') {
      return c.json(
        { error: 'storage_failed', message: 'Could not store HTML, please retry.' },
        502,
      );
    }
    // Sustained contention on one share. The client still holds the HTML, so
    // say so plainly instead of letting the user assume their work is gone.
    return c.json(
      {
        error: 'conflict',
        message: 'Another edit landed first. Your content is still here — save again.',
      },
      409,
    );
  }

  return c.json({ slug, ok: true, version: result.version });
});

/**
 * DELETE /api/share/:slug
 *
 * Deletion is an ownership action (premise P3): owner-key suffices, no edit
 * token required. The two-credential rule lives in lib/authorize.ts, shared
 * with the version endpoints.
 *
 * Soft-deletes (status='deleted', deleted_at=now) and removes the R2 objects.
 * Subsequent GETs on the share subdomain return 404.
 */
editRoute.delete('/share/:slug', syncKeyOptional, async (c) => {
  const slug = c.req.param('slug');
  const ownerKeyHash = c.get('ownerKeyHash');
  const body = await c.req
    .json<{ editToken?: string }>()
    .catch(() => ({}) as { editToken?: string });

  // Credential shape is checked before the DB read so a request with neither
  // credential cannot probe whether a slug exists.
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

  const authz = await authorizeShareOwnership(ownerKeyHash, body.editToken, row);
  if (!authz.ok) {
    return c.json({ error: authz.error, message: authz.message }, authz.status);
  }

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(`UPDATE shares SET status = 'deleted', deleted_at = ? WHERE slug = ?`)
    .bind(now, slug)
    .run();
  // Deleting a share is an explicit "I'm done with this" — don't sit on its
  // viewers' user agents and referrers for the rest of the retention window.
  // The rows stay (the share row is a permanent tombstone so the slug is never
  // reused, and its stats stay readable), but the free-text fields go now.
  await c.env.DB.prepare(`UPDATE views SET ua = NULL, referrer = NULL WHERE slug = ?`)
    .bind(slug)
    .run();
  // R2 delete is best-effort: D1 says "deleted", that's the truth, R2 is just
  // cache. Every version goes, not just v1 — and v1 needs naming separately
  // because it kept the pre-versioning flat key, outside the prefix.
  // If any of this fails we swallow it as before; the version sweep picks up
  // deleted shares precisely so a failure here cannot strand content forever.
  const versions = await c.env.HTML_BUCKET.list({ prefix: versionPrefix(slug) }).catch(() => null);
  const keys = [htmlObjectKey(slug, 1), ...(versions?.objects ?? []).map((o) => o.key)];
  await c.env.HTML_BUCKET.delete(keys).catch(() => undefined);

  return c.json({ slug, ok: true });
});
