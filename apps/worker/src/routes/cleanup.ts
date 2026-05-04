import { PENDING_CLEANUP_AGE_SECONDS } from '@qhs/shared';
import type { Bindings } from '../types';
import { htmlObjectKey } from './upload';

/**
 * Sweeps stale 'pending' rows — these are uploads where the D1 insert
 * succeeded but R2 write or commit failed. Without this, R2 fills with
 * orphaned objects matching no slug, and D1 has zombie pending rows.
 *
 * Triggered from the scheduled handler (cron). Idempotent — safe to run
 * frequently. Returns the number of cleaned rows.
 */
export async function cleanupStalePending(env: Bindings): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - PENDING_CLEANUP_AGE_SECONDS;

  const stale = await env.DB.prepare(
    `SELECT slug FROM shares WHERE status = 'pending' AND created_at < ?`,
  )
    .bind(cutoff)
    .all<{ slug: string }>();

  if (!stale.results || stale.results.length === 0) return 0;

  for (const { slug } of stale.results) {
    // Best effort delete of any R2 object that might exist.
    await env.HTML_BUCKET.delete(htmlObjectKey(slug)).catch(() => undefined);
    await env.DB.prepare(`DELETE FROM shares WHERE slug = ? AND status = 'pending'`)
      .bind(slug)
      .run();
  }

  return stale.results.length;
}
