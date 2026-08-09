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
/**
 * Every version object under a share's prefix, following R2's cursor.
 *
 * One `list()` call is not enough and the object count is not the signal. R2
 * caps a page at 1000 keys and, by its own documentation, "may return fewer to
 * manage memory pressure" — so a short page is not evidence that the share is
 * short. The sweep used to trust a single page, which let it mark a deleted
 * share finished while objects it never listed stayed in R2 for good.
 */
export const VERSION_LIST_MAX_PAGES = 20;

/**
 * Anonymization batch size and per-run cap.
 *
 * 500 keeps each UPDATE well inside D1's statement limits; 20 passes clears
 * 10k rows per cron tick. Hitting the cap is not a failure — the cron runs
 * again in ten minutes and the WHERE clause no longer matches what was
 * already cleared, so the backlog drains instead of being retried whole.
 */
export const ANONYMIZE_BATCH_SIZE = 500;
export const ANONYMIZE_MAX_BATCHES = 20;

async function listAllVersionObjects(
  env: Bindings,
  prefix: string,
): Promise<{ objects: R2Object[]; complete: boolean }> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  // Bounded, not `while (cursor)`. An unbounded follow trusts R2 to always
  // advance the cursor; if it ever doesn't, the Worker spins until it hits the
  // CPU limit and the whole cron dies, taking the pending sweep with it.
  // Stopping early is safe because `complete: false` keeps the share eligible.
  for (let page = 0; page < VERSION_LIST_MAX_PAGES; page++) {
    const res: R2Objects = await env.HTML_BUCKET.list({ prefix, cursor });
    objects.push(...res.objects);
    if (!res.truncated) return { objects, complete: true };
    cursor = res.cursor;
  }
  return { objects, complete: false };
}

/**
 * Deletes keys in R2-sized batches. Returns false if any batch failed.
 *
 * `delete()` takes at most 1000 keys. Handing it more is not a partial success
 * — the whole call fails, and since the sweep retries the identical set every
 * run, a share that accumulated more than 1000 doomed objects would fail
 * forever. Batching is what makes "retry until it succeeds" actually converge.
 */
export const R2_DELETE_MAX_KEYS = 1000;

export async function deleteObjectsInBatches(env: Bindings, keys: string[]): Promise<boolean> {
  for (let i = 0; i < keys.length; i += R2_DELETE_MAX_KEYS) {
    try {
      await env.HTML_BUCKET.delete(keys.slice(i, i + R2_DELETE_MAX_KEYS));
    } catch {
      return false;
    }
  }
  return true;
}

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

    const { objects: listed, complete } = await listAllVersionObjects(env, versionPrefix(row.slug));
    const doomed: string[] = [];
    let heldBack = false;

    for (const object of listed) {
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

    // A failed delete must not look like a finished one. Swallowing the error
    // and advancing the markers anyway is how a deleted share's HTML stays in
    // R2 forever: the row drops out of the eligibility query and nothing ever
    // looks at it again. Leave the markers alone and the next run retries.
    if (doomed.length > 0) {
      if (!(await deleteObjectsInBatches(env, doomed))) continue;
      pruned += doomed.length;
    }

    // A deleted share is only marked done once nothing was held back, so an
    // orphan still inside its grace period gets another pass rather than being
    // stranded by the row dropping out of the query.
    // Clearing orphan_since is conditional on nothing being held back —
    // otherwise a still-young orphan would lose its only ticket back into the
    // sweep. Everything else about this row is idempotent, so re-running is
    // free.
    // Two independent conditions, deliberately not merged:
    //   `complete`  — we saw the share's whole object set. Without it we cannot
    //                 claim anything about what is left.
    //   `!heldBack` — nothing was deliberately spared (a young orphan).
    // Only a run that is both may declare the share finished or drop the orphan
    // flag, which is the ticket back into this query.
    const finished = complete && !heldBack;
    const clearOrphanFlag = finished ? ', orphan_since = NULL' : '';
    if (deleted) {
      if (finished) {
        await env.DB.prepare(
          `UPDATE shares SET versions_pruned_below = ?${clearOrphanFlag} WHERE slug = ?`,
        )
          .bind(row.latest_version + 1, row.slug)
          .run();
      }
    } else if (complete) {
      // A spared orphan does not make the retention cut wrong — the old
      // versions really are gone — so this advances on `complete` alone.
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

  // Two ways a view row loses its free-text fields: it aged out, or its share
  // was deleted.
  //
  // Deletion already anonymizes inline, but that is one shot against a moving
  // target: a share-page request that passed the committed check just before
  // the delete can INSERT its view row just after, and that row would then keep
  // its raw user agent and referrer for the full 90 days on a share the user
  // explicitly deleted. Re-covering deleted shares here bounds that window to
  // one cron interval instead, and costs nothing on the hot path — the
  // alternative, making the view insert conditional on committed status, adds a
  // check to every single share view.
  // Bounded batches, not one open-ended UPDATE.
  //
  // The unbounded version was fine on a quiet database and a trap on a busy
  // one: a backlog big enough to exceed D1's execution limit fails the whole
  // statement, and since the next run builds the identical statement it fails
  // again, every ten minutes, forever. PII that was supposed to expire at 90
  // days then just never expires — and nothing surfaces, because the sweep is
  // fire-and-forget.
  //
  // SQLite has no UPDATE ... LIMIT, so each batch is bounded by first reading
  // the rowids it covers. The UPDATE then re-states the same predicate over
  // that rowid RANGE rather than listing the ids — an `IN (?, ?, …)` list of
  // ANONYMIZE_BATCH_SIZE placeholders blows past D1's 100-bound-parameter
  // ceiling and fails the statement outright, which is exactly the failure mode
  // the batching was added to prevent. The range form is three parameters no
  // matter how large the batch is.
  //
  // Ordering by rowid is what makes the range equivalent to the list: the batch
  // is then every candidate row between the first and last id, so re-applying
  // the predicate over [lo, hi] touches those rows and nothing else.
  //
  // Each pass shrinks the candidate set (a cleared row no longer satisfies the
  // NOT NULL half of the predicate), so progress is monotonic and terminates.
  const CANDIDATE_PREDICATE = `(ua IS NOT NULL OR referrer IS NOT NULL)
       AND (viewed_at < ?
            OR slug IN (SELECT slug FROM shares WHERE status = 'deleted'))`;

  let anonymized = 0;
  for (let pass = 0; pass < ANONYMIZE_MAX_BATCHES; pass++) {
    const batch = await env.DB.prepare(
      `SELECT rowid AS id FROM views
       WHERE ${CANDIDATE_PREDICATE}
       ORDER BY rowid LIMIT ?`,
    )
      .bind(cutoff, ANONYMIZE_BATCH_SIZE)
      .all<{ id: number }>();

    const ids = (batch.results ?? []).map((r) => r.id);
    if (ids.length === 0) break;

    const result = await env.DB.prepare(
      `UPDATE views SET ua = NULL, referrer = NULL
       WHERE ${CANDIDATE_PREDICATE}
         AND rowid BETWEEN ? AND ?`,
    )
      .bind(cutoff, ids[0], ids[ids.length - 1])
      .run();
    anonymized += result.meta.changes ?? 0;

    // A short page means we drained the queue; no need to pay for one more
    // round trip just to see zero.
    if (ids.length < ANONYMIZE_BATCH_SIZE) break;
  }

  return anonymized;
}
