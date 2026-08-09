import { env } from 'cloudflare:test';
import { STATS_TOP_REFERRERS, STATS_TREND_DAYS, type ShareStats } from '@qhs/shared';
import { describe, expect, it } from 'vitest';
import { dashboardFetch, shareFetch, uploadHtml } from './_helpers';

const HTML = '<!doctype html><html><body><h1>S</h1></body></html>';

/** Upload rate limit is 1/30s per IP, so every share gets its own IP. */
let ipCounter = 20;
async function createShare(): Promise<string> {
  const res = await uploadHtml(HTML, `198.51.100.${ipCounter++}`);
  expect(res.status).toBe(201);
  return ((await res.json()) as { slug: string }).slug;
}

/**
 * Writes a view row directly. Going through the share renderer would work but
 * gives no control over referrer or viewed_at, which is what these tests are
 * actually about.
 */
const NOW = Math.floor(Date.now() / 1000);

async function seedView(
  slug: string,
  opts: { ipHash?: string; referrer?: string | null; at?: number; isBot?: boolean } = {},
) {
  await env.DB.prepare(
    `INSERT INTO views (slug, viewed_at, ip_hash, ua, referrer, is_bot) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      slug,
      // Recent by default: the referrer breakdown only covers the retention
      // window, so a fixed past timestamp would silently drop out of it.
      opts.at ?? NOW,
      opts.ipHash ?? 'hash-a',
      null,
      opts.referrer ?? null,
      opts.isBot ? 1 : 0,
    )
    .run();
}

async function getStats(slug: string): Promise<ShareStats> {
  const res = await dashboardFetch(`/api/share/${slug}/stats`);
  expect(res.status).toBe(200);
  return (await res.json()) as ShareStats;
}

describe('GET /api/share/:slug/stats', () => {
  it('returns 404 for unknown slug', async () => {
    const res = await dashboardFetch('/api/share/nonexistent12/stats');
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'not_found' });
  });

  it('reports zeroes for a share nobody has viewed', async () => {
    const slug = await createShare();
    const s = await getStats(slug);
    expect(s).toMatchObject({
      slug,
      views: 0,
      uniqueViewers: 0,
      botViews: 0,
      lastViewedAt: null,
      referrers: [],
      deleted: false,
    });
    expect(Number.isNaN(Date.parse(s.createdAt))).toBe(false);
  });

  it('counts a view recorded by the share renderer', async () => {
    const slug = await createShare();
    await shareFetch(`/${slug}`, { headers: { 'CF-Connecting-IP': '203.0.113.7' } });
    const s = await getStats(slug);
    expect(s.views).toBe(1);
    expect(s.uniqueViewers).toBe(1);
    expect(s.lastViewedAt).not.toBeNull();
  });

  it('separates total views from unique viewers', async () => {
    const slug = await createShare();
    await seedView(slug, { ipHash: 'hash-a' });
    await seedView(slug, { ipHash: 'hash-a' });
    await seedView(slug, { ipHash: 'hash-b' });
    const s = await getStats(slug);
    expect(s.views).toBe(3);
    expect(s.uniqueViewers).toBe(2);
  });

  it('reports the most recent view as lastViewedAt', async () => {
    const slug = await createShare();
    await seedView(slug, { at: NOW - 9000 });
    await seedView(slug, { at: NOW - 10 });
    await seedView(slug, { at: NOW - 5000 });
    const s = await getStats(slug);
    expect(s.lastViewedAt).toBe(new Date((NOW - 10) * 1000).toISOString());
  });

  it('still serves stats for a deleted share', async () => {
    const slug = await createShare();
    await seedView(slug);
    await env.DB.prepare("UPDATE shares SET status='deleted', deleted_at=? WHERE slug=?")
      .bind(1_700_000_001, slug)
      .run();
    const s = await getStats(slug);
    expect(s.deleted).toBe(true);
    expect(s.views).toBe(1);
  });
});

describe('stats daily trend', () => {
  const DAY = 86_400;
  const utcDate = (at: number) => new Date(at * 1000).toISOString().slice(0, 10);

  it('returns a dense 30-day series ending today', async () => {
    const slug = await createShare();
    const s = await getStats(slug);
    expect(s.dailyViews).toHaveLength(STATS_TREND_DAYS);
    expect(s.dailyViews.every((d) => d.views === 0)).toBe(true);
    expect(s.dailyViews.at(-1)?.date).toBe(utcDate(NOW));
    // Oldest first, strictly ascending, no repeats.
    const dates = s.dailyViews.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('buckets views by UTC day and keeps quiet days as explicit zeroes', async () => {
    const slug = await createShare();
    await seedView(slug, { at: NOW });
    await seedView(slug, { at: NOW });
    await seedView(slug, { at: NOW - 2 * DAY });

    const s = await getStats(slug);
    const byDate = new Map(s.dailyViews.map((d) => [d.date, d.views]));
    expect(byDate.get(utcDate(NOW))).toBe(2);
    expect(byDate.get(utcDate(NOW - 2 * DAY))).toBe(1);
    expect(byDate.get(utcDate(NOW - DAY))).toBe(0);
    // Gap days are present, not omitted — a client can render the array as-is.
    expect(s.dailyViews.reduce((total, d) => total + d.views, 0)).toBe(3);
  });

  it('excludes crawler hits from the trend', async () => {
    const slug = await createShare();
    await seedView(slug, { at: NOW });
    await seedView(slug, { at: NOW, isBot: true });
    const s = await getStats(slug);
    expect(s.dailyViews.at(-1)?.views).toBe(1);
  });

  it('drops views older than the window without disturbing the series', async () => {
    const slug = await createShare();
    await seedView(slug, { at: NOW - 60 * DAY });
    await seedView(slug, { at: NOW });

    const s = await getStats(slug);
    expect(s.dailyViews).toHaveLength(STATS_TREND_DAYS);
    expect(s.dailyViews.reduce((total, d) => total + d.views, 0)).toBe(1);
    // The old view still counts toward the headline total.
    expect(s.views).toBe(2);
  });
});

describe('stats bot filtering', () => {
  const CHROME_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  it('keeps crawler views out of views and unique viewers', async () => {
    const slug = await createShare();
    await seedView(slug, { ipHash: 'human' });
    await seedView(slug, { ipHash: 'crawler-1', isBot: true });
    await seedView(slug, { ipHash: 'crawler-2', isBot: true });
    const s = await getStats(slug);
    expect(s.views).toBe(1);
    expect(s.uniqueViewers).toBe(1);
    expect(s.botViews).toBe(2);
  });

  it('keeps crawler traffic out of the referrer breakdown', async () => {
    const slug = await createShare();
    await seedView(slug, { referrer: 'https://news.ycombinator.com/' });
    await seedView(slug, { referrer: 'https://crawler.example/', isBot: true });
    const s = await getStats(slug);
    expect(s.referrers).toEqual([{ source: 'news.ycombinator.com', views: 1 }]);
  });

  it('does not let a later crawler hit move lastViewedAt', async () => {
    const slug = await createShare();
    await seedView(slug, { at: NOW - 9000 });
    await seedView(slug, { at: NOW - 10, isBot: true });
    const s = await getStats(slug);
    expect(s.lastViewedAt).toBe(new Date((NOW - 9000) * 1000).toISOString());
  });

  it('classifies a Slack unfurl as a bot view end to end', async () => {
    const slug = await createShare();
    await shareFetch(`/${slug}`, {
      headers: {
        'CF-Connecting-IP': '203.0.113.50',
        'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      },
    });
    const s = await getStats(slug);
    expect(s.views).toBe(0);
    expect(s.botViews).toBe(1);
  });

  it('counts a real browser view end to end', async () => {
    const slug = await createShare();
    await shareFetch(`/${slug}`, {
      headers: { 'CF-Connecting-IP': '203.0.113.51', 'User-Agent': CHROME_UA },
    });
    const s = await getStats(slug);
    expect(s.views).toBe(1);
    expect(s.botViews).toBe(0);
  });
});

describe('stats referrer breakdown', () => {
  // Every other test in this describe seeds `views` directly, which writes the
  // pre-normalization shape (a full URL) and therefore only ever exercised the
  // read path's legacy branch. That blind spot shipped: the write path stores a
  // bare hostname, the read path fed it back to a URL parser that requires a
  // scheme, and production reported every real referrer as 'other'.
  //
  // This one goes through the actual renderer instead, so the two halves have to
  // agree on the stored format. That is the whole point — no amount of testing
  // either half alone can catch a disagreement between them.
  it('round-trips a real Referer header through the renderer into the breakdown', async () => {
    const slug = await createShare();
    const browser = { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0' };

    for (const referer of [
      'https://news.ycombinator.com/item?id=123456',
      'https://www.reddit.com/r/webdev/comments/abc/',
    ]) {
      const res = await shareFetch(`/${slug}`, { headers: { ...browser, Referer: referer } });
      expect(res.status).toBe(200);
    }
    const direct = await shareFetch(`/${slug}`, { headers: browser });
    expect(direct.status).toBe(200);

    const s = await getStats(slug);
    expect(s.referrers).toEqual([
      { source: 'direct', views: 1 },
      { source: 'news.ycombinator.com', views: 1 },
      { source: 'reddit.com', views: 1 },
    ]);
  });

  it('groups by hostname, folding www and dropping path/query', async () => {
    const slug = await createShare();
    await seedView(slug, { referrer: 'https://www.google.com/search?q=secret+query' });
    await seedView(slug, { referrer: 'https://google.com/' });
    await seedView(slug, { referrer: 'https://news.ycombinator.com/item?id=1' });
    const s = await getStats(slug);
    expect(s.referrers).toEqual([
      { source: 'google.com', views: 2 },
      { source: 'news.ycombinator.com', views: 1 },
    ]);
  });

  it("buckets a missing referrer as 'direct' and an unparseable one as 'other'", async () => {
    const slug = await createShare();
    await seedView(slug, { referrer: null });
    await seedView(slug, { referrer: null });
    await seedView(slug, { referrer: 'definitely not a url' });
    const s = await getStats(slug);
    expect(s.referrers).toEqual([
      { source: 'direct', views: 2 },
      { source: 'other', views: 1 },
    ]);
  });

  it('folds the long tail into other so bucket views still sum to total views', async () => {
    const slug = await createShare();
    // 7 distinct hosts with 7,6,5,4,3,2,1 views → top 5 kept, tail (2+1) folded.
    const hosts = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    for (const [i, host] of hosts.entries()) {
      for (let n = 0; n < hosts.length - i; n++) {
        await seedView(slug, { referrer: `https://${host}.example/page` });
      }
    }
    const s = await getStats(slug);
    expect(s.referrers).toEqual([
      { source: 'a.example', views: 7 },
      { source: 'b.example', views: 6 },
      { source: 'c.example', views: 5 },
      { source: 'd.example', views: 4 },
      { source: 'e.example', views: 3 },
      { source: 'other', views: 3 },
    ]);
    const summed = s.referrers.reduce((total, r) => total + r.views, 0);
    expect(summed).toBe(s.views);
  });

  it('stays bounded when a caller mints a distinct referrer per view', async () => {
    const slug = await createShare();
    // `Referer` is client-supplied, so anyone holding the share URL can make
    // every hit its own group. The old query had no LIMIT and returned one row
    // per group to the Worker before folding — an unbounded D1 read and
    // response size on a public endpoint. 60 unique hosts is not an attack,
    // just enough to prove the bound holds without the count doing the work.
    const HOSTS = 60;
    for (let i = 0; i < HOSTS; i++) {
      await seedView(slug, { referrer: `https://host-${i}.example/${i}` });
    }

    const s = await getStats(slug);
    expect(s.views).toBe(HOSTS);
    // At most the top N plus one derived tail, regardless of how many exist.
    expect(s.referrers.length).toBeLessThanOrEqual(STATS_TOP_REFERRERS + 1);
    // And the tail is still honest: buckets reconcile with the total.
    expect(s.referrers.reduce((total, r) => total + r.views, 0)).toBe(s.views);
  });

  it('stores the hostname, not the raw header, so path and query never land in D1', async () => {
    const slug = await createShare();
    // Through the real renderer, not seedView — seedView INSERTs directly and
    // would skip the very normalisation under test. Every other referrer test
    // in this file goes around the write path, which is exactly why nothing
    // caught that the raw header was being persisted.
    await shareFetch(`/${slug}`, {
      headers: {
        'CF-Connecting-IP': '203.0.113.90',
        Referer: 'https://www.example.com/private/path?token=leaky',
      },
    });

    const row = await env.DB.prepare(`SELECT referrer FROM views WHERE slug = ?`)
      .bind(slug)
      .first<{ referrer: string | null }>();
    // Normalising at write time is what lets the query ORDER BY/LIMIT safely.
    // It also means a sensitive linking URL is never persisted at all.
    expect(row?.referrer).toBe('example.com');
  });

  it('emits a single other bucket when unparseable referrers already rank top', async () => {
    const slug = await createShare();
    // The junk has to be junk under both storage eras, which is why it has a
    // space in it. A stored value with no scheme is ambiguous: written before
    // normalization it means "raw header we could not parse", written after it
    // means "already-normalized hostname". Nothing in the row distinguishes
    // them, so `referrerSource` has to pick an era — and it picks the current
    // one, because those rows are every future row while the legacy ones expire
    // when the retention sweep nulls them. A single-token value like 'garbage'
    // therefore reads back as itself now, and 'localhost' survives as a source
    // instead of collapsing into 'other'.
    for (let n = 0; n < 10; n++) await seedView(slug, { referrer: 'not a url at all' });
    // 6 single-view hosts: 5 fill the remaining top slots, 1 falls to the tail.
    for (const host of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await seedView(slug, { referrer: `https://${host}.example/` });
    }
    const s = await getStats(slug);
    // 10 garbage + the 2 hosts pushed out of the top 5 = 12, in one bucket.
    expect(s.referrers.filter((r) => r.source === 'other')).toHaveLength(1);
    expect(s.referrers.find((r) => r.source === 'other')?.views).toBe(12);
    expect(s.referrers.reduce((total, r) => total + r.views, 0)).toBe(s.views);
  });
});
