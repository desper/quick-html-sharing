import { Hono } from 'hono';
import type { ShareRow, ShareStats } from '@qhs/shared';
import type { AppEnv } from '../types';

/**
 * GET /api/share/:slug/stats
 *
 * Public read of share metadata (created_at, view count, last viewed).
 * No auth — anyone with the slug can see counts. This matches the share's
 * security model: link IS the secret.
 */
export const statsRoute = new Hono<AppEnv>();

statsRoute.get('/share/:slug/stats', async (c) => {
  const slug = c.req.param('slug');

  const row = await c.env.DB.prepare(
    `SELECT slug, status, created_at, deleted_at FROM shares WHERE slug = ?`,
  )
    .bind(slug)
    .first<Pick<ShareRow, 'slug' | 'status' | 'created_at' | 'deleted_at'>>();

  if (!row) {
    return c.json({ error: 'not_found', message: 'Share not found.' }, 404);
  }

  const counts = await c.env.DB.prepare(
    `SELECT COUNT(*) AS views, MAX(viewed_at) AS last_viewed
     FROM views WHERE slug = ?`,
  )
    .bind(slug)
    .first<{ views: number; last_viewed: number | null }>();

  const body: ShareStats = {
    slug,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    views: counts?.views ?? 0,
    lastViewedAt: counts?.last_viewed
      ? new Date(counts.last_viewed * 1000).toISOString()
      : null,
    deleted: row.status === 'deleted',
  };
  return c.json(body);
});
