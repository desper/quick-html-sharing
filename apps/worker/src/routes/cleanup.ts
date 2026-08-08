import {
  PENDING_CLEANUP_AGE_SECONDS,
  RETENTION_VERSIONS,
  VERSION_SWEEP_MAX_SHARES,
  VIEW_PII_RETENTION_SECONDS,
} from '@qhs/shared';
import { htmlObjectKey, versionFromKey, versionPrefix } from '../lib/objectKey';
import type { Bindings } from '../types';

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
    // Best effort delete of any R2 object that might exist. A pending share
    // never got past its first write, so v1 is the only key it can own.
    await env.HTML_BUCKET.delete(htmlObjectKey(slug, 1)).catch(() => undefined);
    // Views must go first: the row is about to disappear, and a view pointing
    // at a slug with no share row is unreachable data that nothing will ever
    // clean up again. A pending share rarely has views, but a slug is only
    // 404 to the renderer once the D1 row is gone — the window is real.
    await env.DB.prepare(`DELETE FROM views WHERE slug = ?`).bind(slug).run();
    await env.DB.prepare(`DELETE FROM shares WHERE slug = ? AND status = 'pending'`)
      .bind(slug)
      .run();
  }

  return stale.results.length;
}

/**
 * Strips `ua` and `referrer` from view rows older than the retention window.
 *
 * Anonymize rather than delete: deleting rows would rewrite historical view
 * counts (a share's "127 views" would shrink on its own), which is worse than
 * losing the traffic-source detail. The salted IP hash stays so unique-viewer
 * counts remain stable.
 *
 * Triggered from the same cron as the pending sweep. Idempotent — the WHERE
 * clause skips rows already cleared, so repeat runs write nothing.
 * Returns the number of anonymized rows.
 */
export interface VersionSweepResult {
  /** R2 objects deleted. */
  pruned: number;
  /** Shares that qualified but did not fit in this run's cap. */
  skipped: number;
}

/**
 * Prunes old versions, orphans, and the leftovers of a failed share deletion.
 *
 * WHY THE QUERY LOOKS LIKE THAT
 *
 * The obvious condition — `latest_version > RETENTION_VERSIONS` — never
 * converges. `latest_version` only ever grows, so a share that crossed the
 * threshold once matches forever, even seconds after being cleaned. With a
 * per-run cap that is worse than wasteful: the same shares get re-scanned
 * every ten minutes while everything behind them starves. `versions_pruned_below`
 * records how far the sweep already got, so a cleaned share drops out of the
 * query until it accumulates another version.
 *
 * THREE KINDS OF GARBAGE, ONE PASS
 *
 *   1. Versions older than the retention window.
 *   2. Orphans (version > latest_version) left by a writer that lost its CAS.
 *      Only collected once they are older than PENDING_CLEANUP_AGE_SECONDS —
 *      without that grace period the sweep would delete an object a live edit
 *      just wrote but has not committed yet, and the share would 500 for every
 *      visitor while the user is told the save succeeded.
 *   3. Everything belonging to a deleted share. Deletion removes R2 objects on
 *      a best-effort basis and swallows failures, so without this the versions
 *      of a deleted share could survive forever — a privacy problem, not just
 *      a storage bill.
 *
 * Keys that do not parse as versions are left alone: the bucket is ours, but
 * it is hand-editable from the dashboard, and a sweep that deletes things it
 * does not recognise is a sweep nobody can trust.
 */
export async function pruneOldVersions(
  env: Bindings,
  /**
   * Injectable clock. R2 sets `uploaded` itself and it cannot be faked, so
   * without this the grace-period branch would be untestable — and an
   * untestable branch guarding "do not delete a live edit's object" is not a
   * guard anyone should trust.
   */
  now: number = Date.now(),
): Promise<VersionSweepResult> {
  const orphanCutoff = new Date(now - PENDING_CLEANUP_AGE_SECONDS * 1000);

  // Three ways in:
  //   - a live share accumulated more than RETENTION_VERSIONS since the last
  //     sweep (uses versions_pruned_below so it drops out once cleaned)
  //   - a deleted share still has objects (<= so a never-edited one, where
  //     latest_version = versions_pruned_below = 1, still qualifies)
  //   - a writer flagged an orphan and the grace period has passed. This
  //     third clause is what makes orphans on small shares reachable at all.
  const eligible = `
    (status = 'committed' AND latest_version - versions_pruned_below >= ?1)
    OR (status = 'deleted' AND versions_pruned_below <= latest_version)
    OR (orphan_since IS NOT NULL AND orphan_since < ?3)`;

  const orphanFlagCutoff = Math.floor(orphanCutoff.getTime() / 1000);

  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM shares WHERE ${eligible}`)
    .bind(RETENTION_VERSIONS, VERSION_SWEEP_MAX_SHARES, orphanFlagCutoff)
    .first<{ n: number }>();

  const candidates = await env.DB.prepare(
    `SELECT slug, status, latest_version FROM shares WHERE ${eligible} LIMIT ?2`,
  )
    .bind(RETENTION_VERSIONS, VERSION_SWEEP_MAX_SHARES, orphanFlagCutoff)
    .all<{ slug: string; status: string; latest_version: number }>();

  const rows = candidates.results ?? [];
  let pruned = 0;

  for (const row of rows) {
    const deleted = row.status === 'deleted';
    // For a live share, keep the newest RETENTION_VERSIONS. For a deleted one,
    // keep nothing — latest_version + 1 puts every version below the cut.
    const keepFrom = deleted ? row.latest_version + 1 : row.latest_version - RETENTION_VERSIONS + 1;

    const listed = await env.HTML_BUCKET.list({ prefix: versionPrefix(row.slug) });
    const doomed: string[] = [];
    let heldBack = false;

    for (const object of listed.objects) {
      const version = versionFromKey(object.key);
      if (version === null) continue;
      if (version < keepFrom) {
        doomed.push(object.key);
      } else if (version > row.latest_version) {
        if (object.uploaded < orphanCutoff) doomed.push(object.key);
        else heldBack = true; // still inside the grace period
      }
    }

    // v1 is not under the prefix — it kept the pre-versioning flat key.
    if (keepFrom > 1) doomed.push(htmlObjectKey(row.slug, 1));

    if (doomed.length > 0) {
      // One call, not one per key: R2 takes up to 1000 keys per delete, far
      // more than a share can accumulate.
      await env.HTML_BUCKET.delete(doomed).catch(() => undefined);
      pruned += doomed.length;
    }

    // A deleted share is only marked done once nothing was held back, so an
    // orphan still inside its grace period gets another pass rather than being
    // stranded by the row dropping out of the query.
    // Clearing orphan_since is conditional on nothing being held back —
    // otherwise a still-young orphan would lose its only ticket back into the
    // sweep. Everything else about this row is idempotent, so re-running is
    // free.
    const clearOrphanFlag = heldBack ? '' : ', orphan_since = NULL';
    if (deleted) {
      if (!heldBack) {
        await env.DB.prepare(
          `UPDATE shares SET versions_pruned_below = ?${clearOrphanFlag} WHERE slug = ?`,
        )
          .bind(row.latest_version + 1, row.slug)
          .run();
      }
    } else {
      await env.DB.prepare(
        `UPDATE shares SET versions_pruned_below = ?${clearOrphanFlag} WHERE slug = ?`,
      )
        .bind(Math.max(1, keepFrom), row.slug)
        .run();
    }
  }

  return { pruned, skipped: Math.max(0, (total?.n ?? 0) - rows.length) };
}

export async function anonymizeOldViews(env: Bindings): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - VIEW_PII_RETENTION_SECONDS;

  const result = await env.DB.prepare(
    `UPDATE views SET ua = NULL, referrer = NULL
     WHERE viewed_at < ? AND (ua IS NOT NULL OR referrer IS NOT NULL)`,
  )
    .bind(cutoff)
    .run();

  return result.meta.changes ?? 0;
}
