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

/** A bare hostname: dot-separated LDH labels, no scheme, no path, no spaces. */
const BARE_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

/** Anything starting with `scheme:` is a URL we should parse. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The label shown for a stored value.
 *
 * A stored value is one of three shapes, and the difference matters:
 *
 *   1. a bare hostname — written by `normalizeReferrer`, i.e. every current row
 *   2. a full URL      — written before normalization existed
 *   3. raw junk        — same era; the old path stored the header verbatim
 *
 * Only (2) may go back through `normalizeReferrer`. Passing (1) to it fails in
 * a way that looks like success: `new URL('example.com')` throws for want of a
 * scheme, the catch branch labels it 'other', and *every* row written since
 * normalization landed reports as 'other'. Production showed exactly that —
 * `news.ycombinator.com` was stored correctly and displayed as 'other'.
 *
 * The unit tests missed it because they seeded full URLs straight into D1,
 * which only ever exercised shape (2). Both halves were right about their own
 * format and wrong about each other's, so testing them separately could not
 * catch it — see the round-trip test through the real share renderer.
 */
export function referrerSource(stored: string | null): string {
  if (!stored) return 'direct';
  if (stored === 'other') return 'other';
  if (HAS_SCHEME.test(stored)) return normalizeReferrer(stored) ?? 'direct';
  // Already the bucket. Junk from the legacy era keeps the 'other' label, which
  // is where it would have landed had it been written through normalization.
  return BARE_HOSTNAME.test(stored) ? stored.slice(0, MAX_REFERRER_LENGTH) : 'other';
}
