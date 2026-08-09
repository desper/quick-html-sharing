/**
 * Reduces a raw `Referer` header to the single value we store and report.
 *
 * WHY THIS RUNS AT WRITE TIME
 *
 * `Referer` is attacker-controlled and unbounded. Storing it verbatim meant the
 * stats query's `GROUP BY referrer` had one row per distinct raw string, and
 * anyone holding a share URL could mint unlimited distinct ones — every hit
 * with a fresh path or a fresh junk value added another group. The query then
 * returned all of them to the Worker before JS folded them into five buckets,
 * which turned the public stats endpoint into an unbounded D1 read, response
 * size, and memory cost.
 *
 * Normalising on the way in makes the stored value the same thing we report, so
 * the query can `ORDER BY count DESC LIMIT N` and stay bounded no matter what
 * the header says. That ordering is only correct because the grouping key is
 * already the final bucket: LIMIT over unmerged raw URLs would pick the top of
 * the wrong set.
 *
 * Dropping path and query is also a privacy win we wanted anyway — the linking
 * page's URL can itself be sensitive, and the host is the whole signal.
 *
 * Rows written before this existed still hold full URLs. They are left alone:
 * they fall out on their own once the retention sweep nulls them, and the read
 * path still normalises, so they stay readable in the meantime. The only cost
 * is that during the overlap one site can occupy several groups, so a top-5
 * that mixes old and new rows can be slightly off. Not worth a data migration.
 */

/** Hostnames cannot exceed this; clamp so a hostile header can't store more. */
const MAX_REFERRER_LENGTH = 253;

/** `null` means "no Referer" and is stored as NULL, which reads back as direct. */
export function normalizeReferrer(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname.replace(/^www\./, '');
    if (!host) return null;
    return host.slice(0, MAX_REFERRER_LENGTH);
  } catch {
    // Not a URL at all. Bucket it rather than storing the raw bytes — this is
    // the same 'other' the tail bucket uses, and both mean "can't attribute".
    return 'other';
  }
}

/**
 * The label shown for a stored value.
 *
 * Still normalises rather than passing the value through, because rows written
 * before `normalizeReferrer` existed hold full URLs.
 */
export function referrerSource(stored: string | null): string {
  if (!stored) return 'direct';
  if (stored === 'other') return 'other';
  return normalizeReferrer(stored) ?? 'direct';
}
