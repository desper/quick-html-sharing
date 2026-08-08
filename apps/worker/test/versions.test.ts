import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import type { RestoreResponse, VersionListResponse } from '@qhs/shared';
import { describe, expect, it } from 'vitest';
import { writeNewVersion } from '../src/lib/versions';
import worker from '../src/index';
import type { Bindings } from '../src/types';
import { dashboardFetch, shareFetch, testSyncKey, uploadParsed } from './_helpers';

const ORIGINAL = '<!doctype html><html><body><h1>Original</h1></body></html>';

let ipCounter = 120;
async function createShare() {
  return uploadParsed(ORIGINAL, `198.51.100.${ipCounter++}`);
}

async function edit(slug: string, html: string, editToken: string): Promise<Response> {
  return dashboardFetch(`/api/edit/${slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, editToken }),
  });
}

async function latestVersion(slug: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT latest_version FROM shares WHERE slug = ?`)
    .bind(slug)
    .first<{ latest_version: number }>();
  return row?.latest_version ?? 0;
}

async function objectText(key: string): Promise<string | null> {
  const obj = await env.HTML_BUCKET.get(key);
  return obj ? await obj.text() : null;
}

/** Calls a version endpoint with either credential (or neither). */
function versionsFetch(
  path: string,
  creds: { editToken?: string; syncKey?: string } = {},
): Promise<Response> {
  return dashboardFetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(creds.syncKey ? { Authorization: `Bearer ${creds.syncKey}` } : {}),
    },
    body: JSON.stringify(creds.editToken ? { editToken: creds.editToken } : {}),
  });
}

async function listVersions(
  slug: string,
  creds: { editToken?: string; syncKey?: string },
): Promise<VersionListResponse> {
  const res = await versionsFetch(`/api/share/${slug}/versions`, creds);
  expect(res.status).toBe(200);
  return (await res.json()) as VersionListResponse;
}

describe('edit appends a version instead of overwriting', () => {
  it('keeps v1 at the flat key and writes v2 under the prefix', async () => {
    const { slug, editToken } = await createShare();

    const res = await edit(slug, '<p>Second</p>', editToken);
    expect(res.status).toBe(200);
    expect((await res.json()) as { version: number }).toMatchObject({ version: 2 });

    expect(await latestVersion(slug)).toBe(2);
    // The original survives, exactly where it has always lived — that is what
    // makes the migration a no-op.
    expect(await objectText(`shares/${slug}.html`)).toContain('Original');
    expect(await objectText(`shares/${slug}/v2.html`)).toContain('Second');
  });

  it('serves the newest version from the share URL', async () => {
    const { slug, editToken } = await createShare();
    await edit(slug, '<p>Second</p>', editToken);
    await edit(slug, '<p>Third</p>', editToken);

    expect(await latestVersion(slug)).toBe(3);
    const view = await shareFetch(`/${slug}`);
    expect(await view.text()).toContain('Third');
  });

  it('records content_size of the version it actually wrote', async () => {
    const { slug, editToken } = await createShare();
    const html = '<p>exactly this</p>';
    await edit(slug, html, editToken);

    const row = await env.DB.prepare(`SELECT content_size FROM shares WHERE slug = ?`)
      .bind(slug)
      .first<{ content_size: number }>();
    expect(row?.content_size).toBe(new TextEncoder().encode(html).byteLength);
  });

  it('leaves the version untouched when the token is wrong', async () => {
    const { slug } = await createShare();
    const res = await edit(slug, '<p>Nope</p>', 'definitely-wrong');
    expect(res.status).toBe(403);
    expect(await latestVersion(slug)).toBe(1);
    expect(await objectText(`shares/${slug}/v2.html`)).toBeNull();
  });
});

describe('POST /api/share/:slug/versions — list', () => {
  it('includes v1, newest first, even though v1 lives outside the prefix', async () => {
    const { slug, editToken } = await createShare();
    await edit(slug, '<p>Second</p>', editToken);
    await edit(slug, '<p>Third</p>', editToken);

    const body = await listVersions(slug, { editToken });
    expect(body.latestVersion).toBe(3);
    expect(body.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    // Sizes come from R2 metadata, not a table we maintain in parallel.
    expect(body.versions.every((v) => v.contentSize > 0)).toBe(true);
    expect(body.versions.every((v) => !Number.isNaN(Date.parse(v.createdAt)))).toBe(true);
  });

  it('lists a single version for a share that was never edited', async () => {
    const { slug, editToken } = await createShare();
    const body = await listVersions(slug, { editToken });
    expect(body.versions.map((v) => v.version)).toEqual([1]);
  });

  it('works with an owning sync key and no edit token', async () => {
    const syncKey = testSyncKey('v');
    const { slug, editToken } = await uploadParsed(ORIGINAL, '198.51.100.200', syncKey);
    await edit(slug, '<p>Second</p>', editToken);

    const body = await listVersions(slug, { syncKey });
    expect(body.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('rejects a non-owning sync key even when a valid editToken is in the body', async () => {
    const { slug, editToken } = await createShare();
    const res = await versionsFetch(`/api/share/${slug}/versions`, {
      syncKey: testSyncKey('w'),
      editToken,
    });
    // Mutually exclusive: the bearer decides the path, and a good token in the
    // body is never a fallback for a bad key.
    expect(res.status).toBe(403);
  });

  it('rejects a wrong edit token and a missing credential differently', async () => {
    const { slug } = await createShare();
    expect(
      (await versionsFetch(`/api/share/${slug}/versions`, { editToken: 'wrong' })).status,
    ).toBe(403);
    expect((await versionsFetch(`/api/share/${slug}/versions`)).status).toBe(400);
  });

  it('returns 410 for a deleted share, not 404', async () => {
    const { slug, editToken } = await createShare();
    await dashboardFetch(`/api/share/${slug}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editToken }),
    });
    const res = await versionsFetch(`/api/share/${slug}/versions`, { editToken });
    expect(res.status).toBe(410);
  });

  it('returns 404 for an unknown slug', async () => {
    expect(
      (await versionsFetch('/api/share/nonexistent12/versions', { editToken: 'x' })).status,
    ).toBe(404);
  });

  it('skips stray objects that do not parse as versions', async () => {
    const { slug, editToken } = await createShare();
    await edit(slug, '<p>Second</p>', editToken);
    // Something uploaded by hand from the Cloudflare dashboard.
    await env.HTML_BUCKET.put(`shares/${slug}/notes.txt`, 'hand-written');

    const body = await listVersions(slug, { editToken });
    expect(body.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('hides orphans left behind by a lost race', async () => {
    const { slug, editToken } = await createShare();
    await env.HTML_BUCKET.put(`shares/${slug}/v9.html`, '<p>orphan</p>');

    const body = await listVersions(slug, { editToken });
    // v9 is past latest_version, so nobody can restore it — showing it would
    // offer an action that cannot work.
    expect(body.versions.map((v) => v.version)).toEqual([1]);
  });
});

describe('POST /api/share/:slug/versions/:v/raw — source preview', () => {
  it('returns the old source as text/plain, never text/html', async () => {
    const { slug, editToken } = await createShare();
    await edit(slug, '<p>Second</p>', editToken);

    const res = await versionsFetch(`/api/share/${slug}/versions/1/raw`, { editToken });
    expect(res.status).toBe(200);
    // Rendering old HTML on the dashboard origin is exactly what the two-origin
    // split exists to prevent.
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await res.text()).toContain('Original');
  });

  it('404s for a version that does not exist', async () => {
    const { slug, editToken } = await createShare();
    expect((await versionsFetch(`/api/share/${slug}/versions/7/raw`, { editToken })).status).toBe(
      404,
    );
    expect((await versionsFetch(`/api/share/${slug}/versions/abc/raw`, { editToken })).status).toBe(
      404,
    );
  });

  it('requires authorization', async () => {
    const { slug } = await createShare();
    expect((await versionsFetch(`/api/share/${slug}/versions/1/raw`)).status).toBe(400);
    expect(
      (await versionsFetch(`/api/share/${slug}/versions/1/raw`, { editToken: 'wrong' })).status,
    ).toBe(403);
  });
});

describe('POST /api/share/:slug/versions/:v/restore', () => {
  it('restores by appending a new version, keeping everything in between', async () => {
    const { slug, editToken } = await createShare();
    await edit(slug, '<p>Second</p>', editToken);
    await edit(slug, '<p>Third</p>', editToken);

    const res = await versionsFetch(`/api/share/${slug}/versions/1/restore`, { editToken });
    expect(res.status).toBe(200);
    expect((await res.json()) as RestoreResponse).toMatchObject({
      slug,
      restoredFrom: 1,
      newVersion: 4,
    });

    // The share now serves the original content again...
    expect(await (await shareFetch(`/${slug}`)).text()).toContain('Original');
    // ...and nothing was thrown away to get there.
    expect(await objectText(`shares/${slug}/v2.html`)).toContain('Second');
    expect(await objectText(`shares/${slug}/v3.html`)).toContain('Third');
    expect(await latestVersion(slug)).toBe(4);
  });

  it('is itself reversible', async () => {
    const { slug, editToken } = await createShare();
    await edit(slug, '<p>Second</p>', editToken);
    await versionsFetch(`/api/share/${slug}/versions/1/restore`, { editToken });

    // Restoring v2 after having restored v1 gets the newer content back.
    const res = await versionsFetch(`/api/share/${slug}/versions/2/restore`, { editToken });
    expect(res.status).toBe(200);
    expect(await (await shareFetch(`/${slug}`)).text()).toContain('Second');
  });

  it('refuses to restore the version that is already live', async () => {
    const { slug, editToken } = await createShare();
    await edit(slug, '<p>Second</p>', editToken);

    const res = await versionsFetch(`/api/share/${slug}/versions/2/restore`, { editToken });
    // Appending an identical copy would push a real older version out of the
    // retention window for no benefit.
    expect(res.status).toBe(400);
    expect(await latestVersion(slug)).toBe(2);
  });

  it('works with an owning sync key and no edit token', async () => {
    const syncKey = testSyncKey('r');
    const { slug, editToken } = await uploadParsed(ORIGINAL, '198.51.100.201', syncKey);
    await edit(slug, '<p>Second</p>', editToken);

    // The cross-device case: this client never had the edit token.
    const res = await versionsFetch(`/api/share/${slug}/versions/1/restore`, { syncKey });
    expect(res.status).toBe(200);
    expect(await (await shareFetch(`/${slug}`)).text()).toContain('Original');
  });

  it('404s for an unknown version and 403s for a bad token', async () => {
    const { slug, editToken } = await createShare();
    expect(
      (await versionsFetch(`/api/share/${slug}/versions/9/restore`, { editToken })).status,
    ).toBe(404);
    expect(
      (await versionsFetch(`/api/share/${slug}/versions/1/restore`, { editToken: 'wrong' })).status,
    ).toBe(403);
  });
});

describe('write rate limiting', () => {
  async function editWithBindings(
    slug: string,
    editToken: string,
    bindings: Record<string, unknown>,
  ) {
    const ctx = createExecutionContext();
    const request = new Request(`https://app.example.com/api/edit/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.170' },
      body: JSON.stringify({ html: '<p>rate limited?</p>', editToken }),
    });
    const res = await worker.fetch(
      request,
      { ...env, ...bindings } as Parameters<typeof worker.fetch>[1],
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  it('denies a write when the limiter says no', async () => {
    const { slug, editToken } = await createShare();
    const res = await editWithBindings(slug, editToken, {
      WRITE_RATE_LIMIT_IP: { limit: async () => ({ success: false }) },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    // Nothing was written, so no version was burned on a rejected request.
    expect(await latestVersion(slug)).toBe(1);
  });

  it('FAIL-OPEN pinned: a throwing limiter must not block the write', async () => {
    // Same posture as the My Shares limiter (eng-review Issue 3A). If this
    // starts failing, someone made it fail-closed and a limiter outage now
    // means nobody can save their edits.
    const { slug, editToken } = await createShare();
    const res = await editWithBindings(slug, editToken, {
      WRITE_RATE_LIMIT_IP: {
        limit: async () => {
          throw new Error('limiter exploded');
        },
      },
    });
    expect(res.status).toBe(200);
  });

  it('FAIL-OPEN pinned: an absent binding must not block the write', async () => {
    const { slug, editToken } = await createShare();
    const res = await editWithBindings(slug, editToken, {});
    expect(res.status).toBe(200);
  });
});

describe('concurrent writes never overwrite each other', () => {
  it('skips a version number that is already taken rather than clobbering it', async () => {
    const { slug, editToken } = await createShare();
    // Simulate a writer that created v2 and then lost the CAS: the object is
    // there, D1 still says latest_version = 1.
    await env.HTML_BUCKET.put(`shares/${slug}/v2.html`, '<p>Someone else</p>');

    const res = await edit(slug, '<p>Mine</p>', editToken);
    expect(res.status).toBe(200);
    // The conditional put must refuse v2 and move to v3. If it overwrote v2,
    // another writer's committed content would silently vanish.
    expect((await res.json()) as { version: number }).toMatchObject({ version: 3 });
    expect(await objectText(`shares/${slug}/v2.html`)).toContain('Someone else');
    expect(await objectText(`shares/${slug}/v3.html`)).toContain('Mine');
  });

  it('keeps both edits when two land at once', async () => {
    const { slug, editToken } = await createShare();

    const [a, b] = await Promise.all([
      edit(slug, '<p>Writer A</p>', editToken),
      edit(slug, '<p>Writer B</p>', editToken),
    ]);

    // Whatever the interleaving, neither request may report success while its
    // bytes are missing, and no version may hold the other writer's content.
    for (const [res, marker] of [
      [a, 'Writer A'],
      [b, 'Writer B'],
    ] as const) {
      if (res.status !== 200) {
        expect(res.status).toBe(409);
        continue;
      }
      const { version } = (await res.json()) as { version: number };
      const stored = await objectText(`shares/${slug}/v${version}.html`);
      expect(stored).toContain(marker);
    }

    // latest_version must point at an object that exists — the failure mode
    // that would 500 the share page for every visitor.
    const latest = await latestVersion(slug);
    const key = latest <= 1 ? `shares/${slug}.html` : `shares/${slug}/v${latest}.html`;
    expect(await objectText(key)).not.toBeNull();

    const view = await shareFetch(`/${slug}`);
    expect(view.status).toBe(200);
  });

  it('a writer that loses the CAS leaves no phantom version behind', async () => {
    const { slug, editToken } = await createShare();

    // A D1 stub that always loses: SELECT reports latest_version = 1, the CAS
    // UPDATE reports zero rows changed. That is exactly what a writer sees when
    // someone else commits between its put and its CAS — and it is the one
    // interleaving Promise.all can't be relied on to produce.
    const losingDb = {
      prepare(sql: string) {
        const stmt = {
          bind: () => stmt,
          first: async () => (sql.includes('SELECT') ? { latest_version: 1 } : null),
          run: async () => ({ meta: { changes: 0 } }),
        };
        return stmt;
      },
    };

    const result = await writeNewVersion(
      { ...env, DB: losingDb } as unknown as Bindings,
      slug,
      '<p>Loser</p>',
      13,
    );
    expect(result).toEqual({ ok: false, reason: 'conflict' });

    // Nothing the loser wrote may survive. A leftover object is not merely
    // wasted storage: its number sits below whatever latest_version the winners
    // reach, so the sweep's `version > latest_version` orphan rule never sees
    // it, and it shows up in the version list as a version the share never
    // served. Restoring it would publish content that was never live.
    const listed = await env.HTML_BUCKET.list({ prefix: `shares/${slug}/` });
    expect(listed.objects.map((o) => o.key)).toEqual([]);

    // And the share itself is untouched — the loser must not have moved it.
    const versions = await listVersions(slug, { editToken });
    expect(versions.versions.map((v) => v.version)).toEqual([1]);
  });
});
