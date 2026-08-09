/**
 * Where a share's HTML lives in R2.
 *
 * Layout:
 *   v1     shares/{slug}.html          ← the pre-versioning flat key
 *   v2+    shares/{slug}/v{n}.html
 *
 * v1 deliberately keeps the old flat key so the objects already in the bucket
 * need no migration and the read path needs no fallback: one `if`, no extra
 * R2 round trip, no batch job against production storage. The cost is that
 * v1 sits outside the `shares/{slug}/` prefix, so anything that enumerates a
 * share's versions must account for it separately. That happens in exactly
 * three places — the version list, the retention sweep, and share deletion.
 *
 * `version` has NO default on purpose. A default of 1 would make an omitted
 * argument silently write to the flat key and overwrite the original version,
 * which is the exact bug this whole feature exists to prevent. Forgetting the
 * argument should be a compile error, not a data loss.
 *
 * Why not R2's own object versioning: it is GA, but the Workers R2 binding
 * exposes no versionId on get/put/head/list/delete — reading a specific
 * version means self-signing SigV4 against the S3 API from inside the Worker.
 * And R2 versioning's retention is a bucket-wide lifecycle rule, while we need
 * per-share "keep the last N". Both blockers would have to disappear before
 * dropping this module is worth it.
 */
export function htmlObjectKey(slug: string, version: number): string {
  return version <= 1 ? `shares/${slug}.html` : `shares/${slug}/v${version}.html`;
}

/** Prefix holding a share's v2+ objects. v1 is NOT under it — see above. */
export function versionPrefix(slug: string): string {
  return `shares/${slug}/`;
}

/**
 * Recovers the version number from an R2 key produced by `htmlObjectKey`.
 *
 * Returns null for anything that does not parse as `v{integer}.html`. The
 * bucket is ours, but it is also editable by hand from the Cloudflare
 * dashboard, and one stray object should not put NaN into a version list or
 * offer an unrestorable entry.
 *
 * The pattern rejects leading zeros deliberately. `\d+` would read `v007.html`
 * as version 7 — a key this module never writes, so it can only have arrived by
 * hand, yet the sweep would treat it as the real v7 and delete it against the
 * retention cut. Refusing to recognise it keeps the promise the sweep makes
 * elsewhere: it only removes objects it knows it produced.
 */
export function versionFromKey(key: string): number | null {
  const digits = /\/v([1-9]\d*)\.html$/.exec(key)?.[1];
  if (digits === undefined) return null;
  const version = Number.parseInt(digits, 10);
  return Number.isSafeInteger(version) && version >= 2 ? version : null;
}
