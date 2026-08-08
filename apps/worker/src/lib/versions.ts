import { VERSION_WRITE_MAX_ATTEMPTS } from '@qhs/shared';
import type { Bindings } from '../types';
import { htmlObjectKey } from './objectKey';

/**
 * The single write path for share content. Both `POST /api/edit/:slug` and
 * version restore go through here.
 *
 * They are not two similar flows that happen to share code — they are the same
 * flow with a different source for the bytes. Duplicating it would mean
 * duplicating the concurrency handling below, which is the part most likely to
 * be got wrong and least likely to be fixed in both copies.
 *
 *   ┌─ writeNewVersion(slug, html) ────────────────────────────────────────┐
 *   │                                                                       │
 *   │  ① SELECT latest_version = n                                          │
 *   │        │                                                              │
 *   │        ▼                                                              │
 *   │  ② R2 put v{n+k}  onlyIf: etagDoesNotMatch '*'   (create-if-absent)   │
 *   │     starting at k=1                                                   │
 *   │        │                                                              │
 *   │        ├── object exists ──► that number is taken. Try k+1.           │
 *   │        │                     NOT a re-read of ①: latest_version has   │
 *   │        │                     not moved, so ① would hand back the same │
 *   │        │                     occupied candidate forever.              │
 *   │        │                     NEVER delete that key: it holds another  │
 *   │        │                     writer's content.                        │
 *   │        ▼                                                              │
 *   │  ③ UPDATE shares SET latest_version = n+k, content_size = ?           │
 *   │       WHERE slug = ? AND latest_version = n            ← CAS          │
 *   │        │                                                              │
 *   │        ├── changes = 0 ──► lost the race. Back to ①. The object we    │
 *   │        │                   wrote is now an orphan; the retention      │
 *   │        │                   sweep reclaims it after its grace period.  │
 *   │        ▼                                                              │
 *   │  ④ done                                                               │
 *   │                                                                       │
 *   │  VERSION_WRITE_MAX_ATTEMPTS exhausted → 'conflict'                     │
 *   └───────────────────────────────────────────────────────────────────────┘
 *
 * WHY THE ORDER IS THE REVERSE OF UPLOAD
 *
 *   upload (D1-first)                    writeNewVersion (R2-first)
 *   ─────────────────                    ──────────────────────────
 *   INSERT pending                       R2 conditional put
 *   R2 put                               CAS UPDATE
 *   UPDATE committed
 *
 *   upload must reserve the slug before writing anything, and a failed write
 *   leaves a pending row for the cleanup sweep. Here the constraint is the
 *   opposite: the moment `latest_version` advances, the share renderer starts
 *   asking R2 for that key. If the object is not already there, every visitor
 *   gets a 500. So the object lands first, and D1 only ever points at bytes
 *   that exist.
 *
 * WHY CONDITIONAL PUT AND NOT A PLAIN PUT
 *
 *   With a plain put, two concurrent writers both compute the same key for
 *   v{n+1}. R2 resolves that by last-write-wins, while the D1 CAS resolves the
 *   version number — so the stored `content_size` can describe one writer's
 *   HTML while the object holds the other's. Worse, the CAS loser would then
 *   "clean up its own orphan" and delete an object the winner had already
 *   published. `etagDoesNotMatch: '*'` makes the put a create, so a writer
 *   either owns a version outright or never touched it.
 */
export type WriteVersionResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'conflict' }
  | { ok: false; reason: 'storage_failed' };

export async function writeNewVersion(
  env: Bindings,
  slug: string,
  html: string,
  byteLength: number,
): Promise<WriteVersionResult> {
  for (let attempt = 0; attempt < VERSION_WRITE_MAX_ATTEMPTS; attempt++) {
    const row = await env.DB.prepare(
      `SELECT latest_version FROM shares WHERE slug = ? AND status = 'committed'`,
    )
      .bind(slug)
      .first<{ latest_version: number }>();

    // Deleted or vanished mid-flight. Callers have already checked status, so
    // this is a genuine race rather than a bad request.
    if (!row) return { ok: false, reason: 'conflict' };

    const observed = row.latest_version;

    // Claim a version number by creating its object. A taken number means
    // another writer got there first — step past it rather than re-reading
    // D1, whose latest_version has not moved (that writer either hasn't
    // committed yet or lost its own CAS and left the object behind).
    let claimed: number | null = null;
    for (let skip = 1; skip <= VERSION_WRITE_MAX_ATTEMPTS; skip++) {
      const candidate = observed + skip;
      let created: unknown;
      try {
        created = await env.HTML_BUCKET.put(htmlObjectKey(slug, candidate), html, {
          httpMetadata: { contentType: 'text/html; charset=utf-8' },
          // Create-only. Resolves to null (no throw) when the key exists.
          onlyIf: { etagDoesNotMatch: '*' },
        });
      } catch {
        // Real storage failure, not contention. latest_version is untouched,
        // so the share keeps serving its current version.
        return { ok: false, reason: 'storage_failed' };
      }
      if (created !== null) {
        claimed = candidate;
        break;
      }
      // Occupied. Never delete it: it holds another writer's content.
    }

    if (claimed === null) continue;

    const update = await env.DB.prepare(
      `UPDATE shares SET latest_version = ?, content_size = ?
       WHERE slug = ? AND latest_version = ?`,
    )
      .bind(claimed, byteLength, slug, observed)
      .run();

    if ((update.meta.changes ?? 0) > 0) return { ok: true, version: claimed };

    // Lost the CAS: someone committed while we were writing. Our object is now
    // unreferenced. Deleting it here would race with whoever won, so flag the
    // share instead and let the sweep collect it after the grace period.
    //
    // The flag is what makes that collection reachable: the sweep's other
    // trigger is crossing the retention threshold, which a share with a
    // handful of versions never does — its orphan would otherwise sit in R2
    // forever. COALESCE keeps the oldest timestamp so a burst of contention
    // does not keep pushing the collection out.
    await env.DB.prepare(
      `UPDATE shares SET orphan_since = COALESCE(orphan_since, ?) WHERE slug = ?`,
    )
      .bind(Math.floor(Date.now() / 1000), slug)
      .run()
      .catch(() => undefined);
  }

  return { ok: false, reason: 'conflict' };
}
