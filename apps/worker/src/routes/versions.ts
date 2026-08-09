import {
  RETENTION_VERSIONS,
  type RestoreResponse,
  type ShareRow,
  type VersionEntry,
  type VersionListResponse,
} from '@qhs/shared';
import { type Context, Hono } from 'hono';
import { authorizeShareOwnership } from '../lib/authorize';
import { htmlObjectKey, versionFromKey, versionPrefix } from '../lib/objectKey';
import { writeNewVersion } from '../lib/versions';
import { syncKeyOptional } from '../middleware/sync-key';
import { writeRateLimit } from '../middleware/write-rate-limit';
import type { AppEnv } from '../types';

/**
 * Version history endpoints.
 *
 *   POST /api/share/:slug/versions                  list
 *   POST /api/share/:slug/versions/:version/raw     source preview (text/plain)
 *   POST /api/share/:slug/versions/:version/restore restore
 *
 * WHY POST AND NOT GET
 *
 * The edit token may only travel in a request body — never a URL path or query
 * string, which end up in server logs (architecture decision #1). GET has no
 * body, so a GET version list could only ever support the sync-key path. One
 * verb for both credentials beats two half-working shapes.
 *
 * WHY THESE REQUIRE AUTH WHEN /stats DOES NOT
 *
 * Stats exposes counts, so "the link is the secret" is enough. Version history
 * exposes how often a document changed and, through the raw endpoint, the
 * content of versions the sender may have deliberately replaced. A viewer
 * holding the share URL must not get either.
 */
export const versionsRoute = new Hono<AppEnv>();

type ShareAuthRow = Pick<
  ShareRow,
  'slug' | 'status' | 'edit_token_hash' | 'owner_key_hash' | 'latest_version'
>;

/**
 * Shared prologue: parse credentials, load the share, authorize.
 *
 * Returns either the row to work with or the Response to send back, so each
 * handler stays a straight line.
 */
async function loadAuthorizedShare(
  c: Context<AppEnv>,
  slug: string,
): Promise<{ row: ShareAuthRow } | { response: Response }> {
  const ownerKeyHash = c.get('ownerKeyHash');
  const body = await c.req
    .json<{ editToken?: string }>()
    .catch(() => ({}) as { editToken?: string });

  if (!ownerKeyHash && typeof body.editToken !== 'string') {
    return {
      response: c.json(
        { error: 'bad_request', message: 'Provide a sync key bearer or an editToken.' },
        400,
      ),
    };
  }

  const row = await c.env.DB.prepare(
    `SELECT slug, status, edit_token_hash, owner_key_hash, latest_version
     FROM shares WHERE slug = ?`,
  )
    .bind(slug)
    .first<ShareAuthRow>();

  if (!row) {
    return { response: c.json({ error: 'not_found', message: 'Share not found.' }, 404) };
  }
  if (row.status === 'deleted') {
    // 410 rather than 404: this slug existed and its versions were removed on
    // purpose. A bare 404 would read as "wrong link" and send the user hunting.
    return {
      response: c.json(
        { error: 'gone', message: 'This share was deleted. Its versions are gone too.' },
        410,
      ),
    };
  }
  if (row.status !== 'committed') {
    return { response: c.json({ error: 'conflict', message: 'Share not ready.' }, 409) };
  }

  const authz = await authorizeShareOwnership(ownerKeyHash, body.editToken, row);
  if (!authz.ok) {
    return { response: c.json({ error: authz.error, message: authz.message }, authz.status) };
  }

  return { row };
}

/** Rejects anything that is not a plain positive integer in the path. */
function parseVersionParam(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const version = Number.parseInt(raw, 10);
  return Number.isSafeInteger(version) && version >= 1 ? version : null;
}

versionsRoute.post('/share/:slug/versions', syncKeyOptional, async (c) => {
  const slug = c.req.param('slug');
  const loaded = await loadAuthorizedShare(c, slug);
  if ('response' in loaded) return loaded.response;
  const { row } = loaded;

  // v2+ live under the prefix. v1 does not — it kept the pre-versioning flat
  // key so existing objects needed no migration, which means it has to be
  // fetched separately or the user's original version is invisible in the UI.
  const [listed, firstVersion] = await Promise.all([
    c.env.HTML_BUCKET.list({ prefix: versionPrefix(slug) }),
    c.env.HTML_BUCKET.head(htmlObjectKey(slug, 1)),
  ]);

  const versions: VersionEntry[] = [];
  if (firstVersion) {
    versions.push({
      version: 1,
      createdAt: firstVersion.uploaded.toISOString(),
      contentSize: firstVersion.size,
    });
  }
  for (const object of listed.objects) {
    const version = versionFromKey(object.key);
    // Unparseable keys are skipped rather than surfaced: the bucket is ours,
    // but it is hand-editable from the Cloudflare dashboard and one stray
    // object should not produce an entry nobody can restore.
    if (version === null) continue;
    // Orphans from a lost race are past latest_version and are not versions
    // anyone can restore — the sweep will collect them.
    if (version > row.latest_version) continue;
    versions.push({
      version,
      createdAt: object.uploaded.toISOString(),
      contentSize: object.size,
    });
  }

  versions.sort((a, b) => b.version - a.version);

  const body: VersionListResponse = {
    slug,
    latestVersion: row.latest_version,
    versions: versions.slice(0, RETENTION_VERSIONS),
  };
  return c.json(body);
});

versionsRoute.post('/share/:slug/versions/:version/raw', syncKeyOptional, async (c) => {
  const slug = c.req.param('slug');
  const version = parseVersionParam(c.req.param('version'));
  if (version === null) {
    return c.json({ error: 'not_found', message: 'No such version.' }, 404);
  }

  const loaded = await loadAuthorizedShare(c, slug);
  if ('response' in loaded) return loaded.response;
  const { row } = loaded;

  if (version > row.latest_version) {
    return c.json({ error: 'not_found', message: 'No such version.' }, 404);
  }

  const object = await c.env.HTML_BUCKET.get(htmlObjectKey(slug, version));
  if (!object) {
    return c.json({ error: 'not_found', message: 'That version has been pruned.' }, 404);
  }

  // text/plain, never text/html. Restoring an old version republishes it to
  // everyone holding the link, so the user needs to read it first — but
  // rendering it here would mean executing user HTML on the dashboard origin,
  // which is the one thing the whole two-origin split exists to prevent.
  return c.body(object.body, 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
});

versionsRoute.post(
  '/share/:slug/versions/:version/restore',
  syncKeyOptional,
  writeRateLimit,
  async (c) => {
    const slug = c.req.param('slug');
    const version = parseVersionParam(c.req.param('version'));
    if (version === null) {
      return c.json({ error: 'not_found', message: 'No such version.' }, 404);
    }

    const loaded = await loadAuthorizedShare(c, slug);
    if ('response' in loaded) return loaded.response;
    const { row } = loaded;

    if (version > row.latest_version) {
      return c.json({ error: 'not_found', message: 'No such version.' }, 404);
    }
    if (version === row.latest_version) {
      // Restoring the current version would append an identical copy, quietly
      // pushing a genuinely older version out of the retention window. Refuse
      // rather than pretend to work.
      return c.json({ error: 'bad_request', message: 'That version is already live.' }, 400);
    }

    const object = await c.env.HTML_BUCKET.get(htmlObjectKey(slug, version));
    if (!object) {
      return c.json({ error: 'not_found', message: 'That version has been pruned.' }, 404);
    }
    const html = await object.text();
    const byteLength = new TextEncoder().encode(html).byteLength;

    // Restore is an ordinary write of already-stored bytes, so it goes through
    // the same state machine as edit. History stays linear and the restore is
    // itself reversible.
    const result = await writeNewVersion(c.env, slug, html, byteLength);
    if (!result.ok) {
      if (result.reason === 'storage_failed') {
        return c.json(
          { error: 'storage_failed', message: 'Could not store HTML, please retry.' },
          502,
        );
      }
      return c.json(
        { error: 'conflict', message: 'Another edit landed first. Try the restore again.' },
        409,
      );
    }

    const body: RestoreResponse = {
      slug,
      restoredFrom: version,
      newVersion: result.version,
    };
    return c.json(body);
  },
);
