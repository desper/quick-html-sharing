import { env } from 'cloudflare:test';
import {
  PENDING_CLEANUP_AGE_SECONDS,
  RETENTION_VERSIONS,
  VIEW_PII_RETENTION_SECONDS,
} from '@qhs/shared';
import { describe, expect, it } from 'vitest';
import {
  ANONYMIZE_BATCH_SIZE,
  anonymizeOldViews,
  cleanupStalePending,
  pruneOldVersions,
} from '../src/routes/cleanup';
import type { Bindings } from '../src/types';
import { dashboardFetch, uploadHtml, uploadParsed } from './_helpers';

const NOW = Math.floor(Date.now() / 1000);
const OUTSIDE_WINDOW = NOW - VIEW_PII_RETENTION_SECONDS - 60;

let ipCounter = 60;
async function createShare(): Promise<string> {
  const res = await uploadHtml('<!doctype html><p>c</p>', `198.51.100.${ipCounter++}`);
  expect(res.status).toBe(201);
  return ((await res.json()) as { slug: string }).slug;
}

async function insertPendingShare(slug: string, createdAt: number) {
  await env.DB.prepare(
    `INSERT INTO shares (slug, status, edit_token_hash, created_at, sender_ip_hash, content_size)
     VALUES (?, 'pending', 'token-hash', ?, 'ip-hash', 0)`,
  )
    .bind(slug, createdAt)
    .run();
}

async function insertView(
  slug: string,
  opts: {
    at: number;
    ua?: string | null;
    referrer?: string | null;
    country?: string | null;
    city?: string | null;
  },
) {
  await env.DB.prepare(
    `INSERT INTO views (slug, viewed_at, ip_hash, ua, referrer, is_bot, country, city)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      slug,
      opts.at,
      'viewer-hash',
      opts.ua ?? 'Mozilla/5.0',
      opts.referrer ?? 'https://x.test/',
      opts.country === undefined ? 'TW' : opts.country,
      opts.city === undefined ? 'Taipei' : opts.city,
    )
    .run();
}

describe('anonymizeOldViews', () => {
  it('strips every raw viewer field past the retention window', async () => {
    const slug = await createShare();
    await insertView(slug, { at: OUTSIDE_WINDOW });

    expect(await anonymizeOldViews(env)).toBe(1);

    const row = await env.DB.prepare(
      `SELECT ua, referrer, country, city, ip_hash FROM views WHERE slug = ?`,
    )
      .bind(slug)
      .first<{
        ua: string | null;
        referrer: string | null;
        country: string | null;
        city: string | null;
        ip_hash: string;
      }>();
    expect(row?.ua).toBeNull();
    expect(row?.referrer).toBeNull();
    // Location expires on the same clock. It is at least as identifying as a
    // user agent, so exempting it would be backwards.
    expect(row?.country).toBeNull();
    expect(row?.city).toBeNull();
    // The row and its (already hashed) viewer identity survive — deleting it
    // would rewrite the share's historical view count.
    expect(row?.ip_hash).toBe('viewer-hash');
  });

  it('leaves rows inside the window untouched', async () => {
    const slug = await createShare();
    await insertView(slug, { at: NOW - 60 });

    expect(await anonymizeOldViews(env)).toBe(0);

    const row = await env.DB.prepare(`SELECT ua, referrer FROM views WHERE slug = ?`)
      .bind(slug)
      .first<{ ua: string | null; referrer: string | null }>();
    expect(row?.ua).toBe('Mozilla/5.0');
    expect(row?.referrer).toBe('https://x.test/');
  });

  it('is idempotent — a second run has nothing to do', async () => {
    const slug = await createShare();
    await insertView(slug, { at: OUTSIDE_WINDOW });

    expect(await anonymizeOldViews(env)).toBe(1);
    expect(await anonymizeOldViews(env)).toBe(0);
  });

  it('drains a backlog larger than one batch', async () => {
    const slug = await createShare();
    const rows = ANONYMIZE_BATCH_SIZE + 50;

    // Every other test here has a handful of rows, so all of them fit in one
    // batch and none exercises the loop. The failure this guards against only
    // appears at scale: the old single UPDATE had no bound, and a backlog big
    // enough to blow D1's execution limit would fail the whole statement and
    // then fail identically every ten minutes forever.
    await env.DB.batch(
      Array.from({ length: rows }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO views (slug, viewed_at, ip_hash, ua, referrer, is_bot)
           VALUES (?, ?, ?, ?, ?, 0)`,
        ).bind(slug, OUTSIDE_WINDOW, `hash-${i}`, 'Mozilla/5.0', 'example.com'),
      ),
    );

    expect(await anonymizeOldViews(env)).toBe(rows);

    const left = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM views
       WHERE slug = ? AND (ua IS NOT NULL OR referrer IS NOT NULL)`,
    )
      .bind(slug)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);

    // The rows themselves survive — anonymizing must not shrink view counts.
    const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM views WHERE slug = ?`)
      .bind(slug)
      .first<{ n: number }>();
    expect(total?.n).toBe(rows);
  });

  it('does not shrink the view count it anonymizes', async () => {
    const slug = await createShare();
    await insertView(slug, { at: OUTSIDE_WINDOW });
    await insertView(slug, { at: NOW - 60 });

    await anonymizeOldViews(env);

    const res = await dashboardFetch(`/api/share/${slug}/stats`);
    const stats = (await res.json()) as { views: number; referrers: { source: string }[] };
    expect(stats.views).toBe(2);
    // The anonymized row must not resurface as a 'direct' visit — only the
    // in-window row contributes a source.
    expect(stats.referrers).toEqual([{ source: 'x.test', views: 1 }]);
  });
});

describe('deleting a share', () => {
  it('anonymizes its view rows immediately, without dropping the count', async () => {
    const res = await uploadHtml('<!doctype html><p>d</p>', `198.51.100.${ipCounter++}`);
    const { slug, editToken } = (await res.json()) as { slug: string; editToken: string };
    await insertView(slug, { at: NOW - 60 });

    const del = await dashboardFetch(`/api/share/${slug}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editToken }),
    });
    expect(del.status).toBe(200);

    const row = await env.DB.prepare(
      `SELECT ua, referrer, country, city FROM views WHERE slug = ?`,
    )
      .bind(slug)
      .first<{
        ua: string | null;
        referrer: string | null;
        country: string | null;
        city: string | null;
      }>();
    expect(row?.ua).toBeNull();
    expect(row?.referrer).toBeNull();
    expect(row?.country).toBeNull();
    expect(row?.city).toBeNull();

    const stats = (await (await dashboardFetch(`/api/share/${slug}/stats`)).json()) as {
      views: number;
      deleted: boolean;
    };
    expect(stats.views).toBe(1);
    expect(stats.deleted).toBe(true);
  });
});

describe('pruneOldVersions', () => {
  /** Builds a share that already has `count` versions, without N edit calls. */
  async function shareWithVersions(count: number, ip: string): Promise<string> {
    const { slug } = await uploadParsed('<p>v1</p>', ip);
    for (let v = 2; v <= count; v++) {
      await env.HTML_BUCKET.put(`shares/${slug}/v${v}.html`, `<p>v${v}</p>`);
    }
    await env.DB.prepare(`UPDATE shares SET latest_version = ? WHERE slug = ?`)
      .bind(count, slug)
      .run();
    return slug;
  }

  async function existingVersions(slug: string): Promise<number[]> {
    const found: number[] = [];
    if (await env.HTML_BUCKET.head(`shares/${slug}.html`)) found.push(1);
    const listed = await env.HTML_BUCKET.list({ prefix: `shares/${slug}/` });
    for (const o of listed.objects) {
      const n = /\/v(\d+)\.html$/.exec(o.key)?.[1];
      if (n) found.push(Number.parseInt(n, 10));
    }
    return found.sort((a, b) => a - b);
  }

  it('does nothing until a share exceeds the retention window', async () => {
    const slug = await shareWithVersions(RETENTION_VERSIONS, '198.51.100.150');
    const result = await pruneOldVersions(env);
    expect(result.pruned).toBe(0);
    expect(await existingVersions(slug)).toHaveLength(RETENTION_VERSIONS);
  });

  it('keeps the newest N and drops the oldest, including v1 at the flat key', async () => {
    const slug = await shareWithVersions(RETENTION_VERSIONS + 2, '198.51.100.151');

    await pruneOldVersions(env);

    // v1 lives outside the prefix, so a sweep that only listed the prefix
    // would leave it behind forever.
    expect(await existingVersions(slug)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(await env.HTML_BUCKET.head(`shares/${slug}.html`)).toBeNull();
  });

  it('converges — a second run with no new versions does nothing', async () => {
    await shareWithVersions(RETENTION_VERSIONS + 2, '198.51.100.152');

    const first = await pruneOldVersions(env);
    expect(first.pruned).toBeGreaterThan(0);

    // The naive condition (latest_version > N) would match this share forever,
    // re-listing it every ten minutes and starving anything behind the cap.
    const second = await pruneOldVersions(env);
    expect(second.pruned).toBe(0);
    expect(second.skipped).toBe(0);
  });

  it('leaves an in-flight orphan alone and collects it once aged', async () => {
    const slug = await shareWithVersions(RETENTION_VERSIONS + 2, '198.51.100.153');
    // A writer that put its object and then lost the CAS: the object exists,
    // latest_version never moved past it, and the writer flagged the share.
    await env.HTML_BUCKET.put(`shares/${slug}/v99.html`, '<p>in flight</p>');
    await env.DB.prepare(`UPDATE shares SET orphan_since = ? WHERE slug = ?`)
      .bind(Math.floor(Date.now() / 1000), slug)
      .run();

    await pruneOldVersions(env);
    // Deleting this would 500 the share the moment that writer's CAS lands.
    expect(await env.HTML_BUCKET.head(`shares/${slug}/v99.html`)).not.toBeNull();

    // Same object, swept from far enough in the future that it is past the
    // grace period. R2 owns `uploaded`, so moving the clock is the only way
    // to exercise this branch.
    await pruneOldVersions(env, Date.now() + (PENDING_CLEANUP_AGE_SECONDS + 60) * 1000);
    expect(await env.HTML_BUCKET.head(`shares/${slug}/v99.html`)).toBeNull();
  });

  it('collects an orphan on a share that never crossed the retention threshold', async () => {
    const { slug } = await uploadParsed('<p>v1</p>', '198.51.100.157');
    await env.HTML_BUCKET.put(`shares/${slug}/v2.html`, '<p>stranded</p>');
    // What writeNewVersion records when it wins the R2 create but loses the
    // CAS. Without this flag the share has 1 version, never qualifies for the
    // retention scan, and its orphan would sit in R2 forever.
    await env.DB.prepare(`UPDATE shares SET orphan_since = ? WHERE slug = ?`)
      .bind(Math.floor(Date.now() / 1000), slug)
      .run();

    await pruneOldVersions(env, Date.now() + (PENDING_CLEANUP_AGE_SECONDS + 60) * 1000);

    expect(await env.HTML_BUCKET.head(`shares/${slug}/v2.html`)).toBeNull();
    // Flag cleared, so the share stops being re-scanned every ten minutes.
    const row = await env.DB.prepare(`SELECT orphan_since FROM shares WHERE slug = ?`)
      .bind(slug)
      .first<{ orphan_since: number | null }>();
    expect(row?.orphan_since).toBeNull();
  });

  it('clears every version of a deleted share, then stops looking at it', async () => {
    const syncKeyIp = '198.51.100.154';
    const slug = await shareWithVersions(3, syncKeyIp);
    await env.DB.prepare(`UPDATE shares SET status = 'deleted', deleted_at = ? WHERE slug = ?`)
      .bind(Math.floor(Date.now() / 1000), slug)
      .run();

    const first = await pruneOldVersions(env);
    expect(first.pruned).toBe(3);
    expect(await existingVersions(slug)).toEqual([]);

    // Marked done — otherwise every deleted share would be re-listed forever.
    const second = await pruneOldVersions(env);
    expect(second.pruned).toBe(0);
  });

  it('sweeps a deleted share that was never edited', async () => {
    const { slug } = await uploadParsed('<p>only</p>', '198.51.100.155');
    await env.DB.prepare(`UPDATE shares SET status = 'deleted', deleted_at = ? WHERE slug = ?`)
      .bind(Math.floor(Date.now() / 1000), slug)
      .run();

    // latest_version = 1 = versions_pruned_below. A strict < comparison would
    // skip this row entirely and leak the object.
    const result = await pruneOldVersions(env);
    expect(result.pruned).toBe(1);
    expect(await env.HTML_BUCKET.head(`shares/${slug}.html`)).toBeNull();
  });

  it('finishes a deleted share whose listing came back truncated', async () => {
    const slug = await shareWithVersions(5, '198.51.100.160');
    await env.DB.prepare(`UPDATE shares SET status = 'deleted', deleted_at = ? WHERE slug = ?`)
      .bind(Math.floor(Date.now() / 1000), slug)
      .run();

    // R2 can return fewer objects than exist and set `truncated` — the docs are
    // explicit that it "may return fewer to manage memory pressure" and that
    // callers must trust `truncated` rather than the object count. So this is
    // not a >1000-objects edge case; it can happen to any share, any time.
    //
    // If the sweep marks a deleted share done after seeing only one page, the
    // objects it never listed stay in R2 forever — for a share the user
    // explicitly deleted. That is a privacy failure, not a storage bill.
    const bucket = env.HTML_BUCKET;
    const realList = bucket.list.bind(bucket);
    const truncating = new Proxy(bucket, {
      get(target, prop, _receiver) {
        if (prop === 'list') {
          // Page 1 is short and truncated; page 2 (cursor set) returns the rest
          // and ends. Real R2 always advances the cursor — a stub that returns
          // `truncated: true` forever would just hang the caller.
          return async (opts: R2ListOptions) => {
            const full = await realList({ ...opts, cursor: undefined });
            return opts.cursor === undefined
              ? { ...full, objects: full.objects.slice(0, 2), truncated: true, cursor: 'page2' }
              : { ...full, objects: full.objects.slice(2), truncated: false, cursor: undefined };
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await pruneOldVersions({ ...env, HTML_BUCKET: truncating } as unknown as Bindings);

    // The share was deleted; nothing of it may survive. Give the sweep as many
    // honest passes as it wants — what it must never do is declare the share
    // finished while objects it never saw are still there.
    for (let pass = 0; pass < 5; pass++) {
      if ((await existingVersions(slug)).length === 0) break;
      await pruneOldVersions(env);
    }
    expect(await existingVersions(slug)).toEqual([]);
  });

  it('leaves unrecognised objects in the prefix alone', async () => {
    const slug = await shareWithVersions(RETENTION_VERSIONS + 2, '198.51.100.156');
    await env.HTML_BUCKET.put(`shares/${slug}/notes.txt`, 'hand-written');

    await pruneOldVersions(env);

    expect(await env.HTML_BUCKET.head(`shares/${slug}/notes.txt`)).not.toBeNull();
  });

  it('reports how many shares it deferred instead of silently truncating', async () => {
    // Cheaper than building 51 shares: the count comes from a COUNT(*) over
    // the same predicate, so one over-cap share proves the accounting.
    for (let i = 0; i < 3; i++) {
      await shareWithVersions(RETENTION_VERSIONS + 1, `198.51.100.${160 + i}`);
    }
    const result = await pruneOldVersions(env);
    expect(result.skipped).toBe(0);
    expect(result.pruned).toBe(3);
  });
});

describe('cleanupStalePending', () => {
  it('deletes a stale pending share along with its view rows', async () => {
    const slug = 'stalepending1';
    await insertPendingShare(slug, NOW - 3600);
    await insertView(slug, { at: NOW - 3500 });

    expect(await cleanupStalePending(env)).toBe(1);

    const share = await env.DB.prepare(`SELECT slug FROM shares WHERE slug = ?`).bind(slug).first();
    expect(share).toBeNull();
    // Views must go with it: a view whose share row is gone is unreachable
    // data no later sweep would ever find.
    const views = await env.DB.prepare(`SELECT COUNT(*) AS n FROM views WHERE slug = ?`)
      .bind(slug)
      .first<{ n: number }>();
    expect(views?.n).toBe(0);
  });

  it('leaves a fresh pending share alone', async () => {
    await insertPendingShare('freshpending1', NOW - 10);
    expect(await cleanupStalePending(env)).toBe(0);
  });

  it('leaves committed shares and their views alone', async () => {
    const slug = await createShare();
    await insertView(slug, { at: NOW - 3600 });

    await cleanupStalePending(env);

    const views = await env.DB.prepare(`SELECT COUNT(*) AS n FROM views WHERE slug = ?`)
      .bind(slug)
      .first<{ n: number }>();
    expect(views?.n).toBe(1);
  });
});
