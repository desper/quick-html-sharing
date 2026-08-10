import {
  type DailyViewStat,
  type LocationStat,
  type ReferrerStat,
  STATS_TOP_LOCATIONS,
  STATS_TOP_REFERRERS,
  STATS_TREND_DAYS,
  type ShareRow,
  type ShareStats,
  VIEW_PII_RETENTION_SECONDS,
} from '@qhs/shared';
import { Hono } from 'hono';
import { referrerSource } from '../lib/referrer';
import type { AppEnv } from '../types';

const SECONDS_PER_DAY = 86_400;

/**
 * GET /api/share/:slug/stats
 *
 * Public read of share metadata (created_at, view count, unique viewers,
 * referrer breakdown, last viewed). No auth — anyone with the slug can see
 * counts. This matches the share's security model: link IS the secret.
 */
export const statsRoute = new Hono<AppEnv>();

statsRoute.get('/share/:slug/stats', async (c) => {
  const slug = c.req.param('slug');

  const row = await c.env.DB.prepare(
    `SELECT slug, status, created_at, deleted_at FROM shares WHERE slug = ?`,
  )
    .bind(slug)
    .first<Pick<ShareRow, 'slug' | 'status' | 'created_at' | 'deleted_at'>>();

  if (!row) {
    return c.json({ error: 'not_found', message: 'Share not found.' }, 404);
  }

  const now = Math.floor(Date.now() / 1000);
  // The trend starts at midnight UTC so the oldest bucket is a whole day
  // rather than a partial one that looks like a dip.
  const trendStart = (Math.floor(now / SECONDS_PER_DAY) - (STATS_TREND_DAYS - 1)) * SECONDS_PER_DAY;

  // Independent aggregates over the same slug — no transaction needed, stats
  // are a snapshot and a view landing between them is not a bug.
  const [counts, referrerRows, referrerTotal, locationRows, dailyRows] = await Promise.all([
    // Human views and bot views come from one pass: SUM(is_bot) rather than a
    // second query, since both numbers are always reported together.
    c.env.DB.prepare(
      `SELECT COUNT(*) FILTER (WHERE is_bot = 0) AS views,
              COUNT(DISTINCT CASE WHEN is_bot = 0 THEN ip_hash END) AS unique_viewers,
              MAX(CASE WHEN is_bot = 0 THEN viewed_at END) AS last_viewed,
              COUNT(*) FILTER (WHERE is_bot = 1) AS bot_views
       FROM views WHERE slug = ?`,
    )
      .bind(slug)
      .first<{
        views: number;
        unique_viewers: number;
        last_viewed: number | null;
        bot_views: number;
      }>(),
    // LIMIT is the point, not an optimisation. "Distinct referrers is small"
    // was the old assumption here and it was wrong: `Referer` is supplied by
    // the client, so anyone holding the share URL could mint a new group per
    // request and make this query return unboundedly many rows. Values are now
    // normalised on write (lib/referrer.ts), which is what makes ordering by
    // count and cutting at N correct — the grouping key is already the bucket
    // we report, so the top N here is the real top N.
    //
    // Scoped to the retention window on purpose: past it the sweep has nulled
    // `referrer`, and those rows would otherwise be indistinguishable from a
    // genuine no-referrer visit and inflate 'direct' over time.
    c.env.DB.prepare(
      `SELECT referrer, COUNT(*) AS n FROM views
       WHERE slug = ? AND is_bot = 0 AND viewed_at >= ?
       GROUP BY referrer ORDER BY n DESC LIMIT ?`,
    )
      .bind(slug, now - VIEW_PII_RETENTION_SECONDS, STATS_TOP_REFERRERS)
      .all<{ referrer: string | null; n: number }>(),
    // The tail is derived, not listed. Total views in the same window minus the
    // top buckets gives 'other' without reading a row per distinct source.
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM views
       WHERE slug = ? AND is_bot = 0 AND viewed_at >= ?`,
    )
      .bind(slug, now - VIEW_PII_RETENTION_SECONDS)
      .first<{ n: number }>(),
    // Same shape as the referrer query, and bounded for a different reason.
    // Country and city come from Cloudflare rather than from the client, so
    // there is no cardinality attack here — but a link that genuinely travels
    // still lands in more cities than anyone wants listed, and the tail is not
    // information. Shares the referrer window so the two breakdowns describe
    // the same set of views.
    c.env.DB.prepare(
      `SELECT country, city, COUNT(*) AS n FROM views
       WHERE slug = ? AND is_bot = 0 AND viewed_at >= ?
       GROUP BY country, city ORDER BY n DESC LIMIT ?`,
    )
      .bind(slug, now - VIEW_PII_RETENTION_SECONDS, STATS_TOP_LOCATIONS)
      .all<{ country: string | null; city: string | null; n: number }>(),
    // Bucketed by integer division on the stored unix seconds — no date
    // functions, so the grouping key is index-friendly and timezone-free.
    c.env.DB.prepare(
      `SELECT viewed_at / ${SECONDS_PER_DAY} AS day, COUNT(*) AS n FROM views
       WHERE slug = ? AND is_bot = 0 AND viewed_at >= ?
       GROUP BY day`,
    )
      .bind(slug, trendStart)
      .all<{ day: number; n: number }>(),
  ]);

  const body: ShareStats = {
    slug,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    views: counts?.views ?? 0,
    uniqueViewers: counts?.unique_viewers ?? 0,
    botViews: counts?.bot_views ?? 0,
    lastViewedAt: counts?.last_viewed ? new Date(counts.last_viewed * 1000).toISOString() : null,
    referrers: summarizeReferrers(referrerRows.results ?? [], referrerTotal?.n ?? 0),
    // Reuses the referrer window total — both breakdowns cover the same rows,
    // so a second identical COUNT would be a wasted query.
    locations: summarizeLocations(locationRows.results ?? [], referrerTotal?.n ?? 0),
    dailyViews: buildTrend(dailyRows.results ?? [], trendStart),
    deleted: row.status === 'deleted',
  };
  return c.json(body);
});

/**
 * Expands sparse day buckets into a dense STATS_TREND_DAYS-long series.
 *
 * Filling the gaps here rather than in the client is what makes the shape
 * honest: a sparse list rendered as bars silently closes up the quiet days and
 * turns two views a month apart into a flat, busy-looking chart.
 */
function buildTrend(rows: { day: number; n: number }[], trendStart: number): DailyViewStat[] {
  const byDay = new Map(rows.map((r) => [r.day, r.n]));
  const firstDay = trendStart / SECONDS_PER_DAY;

  return Array.from({ length: STATS_TREND_DAYS }, (_, i) => {
    const day = firstDay + i;
    return {
      date: new Date(day * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10),
      views: byDay.get(day) ?? 0,
    };
  });
}

/**
 * Turns a (country, city) pair into the one string every client renders.
 *
 * Precomputed server-side so the web page, the MCP server and the skill cannot
 * drift into three different renderings of the same row — and so the rule for
 * a half-resolved location (country but no city, which is common) is decided
 * once, here.
 */
function locationLabel(country: string | null, city: string | null): string {
  if (!country) return 'unknown';
  return city ? `${city}, ${country}` : country;
}

/**
 * Folds grouped location rows into at most STATS_TOP_LOCATIONS + 1 buckets.
 *
 * Mirrors summarizeReferrers, including deriving the tail from the window
 * total rather than listing it. The extra wrinkle is that two grouped rows can
 * collapse into one label — (TW, null) and (TW, '') both read as 'TW' — so the
 * fold happens on the label, not on the raw pair.
 */
function summarizeLocations(
  rows: { country: string | null; city: string | null; n: number }[],
  windowTotal: number,
): LocationStat[] {
  const byLabel = new Map<string, LocationStat>();
  for (const r of rows) {
    // Empty string is not a location. CF sends null for unresolved, but a
    // blank would otherwise render as "Taipei, " or a bare comma.
    const country = r.country || null;
    const city = r.city || null;
    const label = locationLabel(country, city);
    const existing = byLabel.get(label);
    if (existing) {
      existing.views += r.n;
    } else {
      byLabel.set(label, { country, city, label, views: r.n });
    }
  }

  const byViewsDesc = (a: LocationStat, b: LocationStat) =>
    b.views - a.views || a.label.localeCompare(b.label);
  const top = [...byLabel.values()].sort(byViewsDesc);

  // Clamped at zero for the same reason as the referrer tail: labels can merge
  // rows, and a negative bucket is worse than a small overcount.
  const tailViews = Math.max(0, windowTotal - top.reduce((sum, r) => sum + r.views, 0));
  if (tailViews === 0) return top;

  const existingOther = top.find((r) => r.label === 'other');
  if (existingOther) {
    existingOther.views += tailViews;
  } else {
    top.push({ country: null, city: null, label: 'other', views: tailViews });
  }
  return top.sort(byViewsDesc);
}

/**
 * Folds grouped referrer rows into at most STATS_TOP_REFERRERS + 1 buckets.
 *
 * The tail is summed into 'other' rather than dropped so the bucket views
 * always add up to the total view count.
 */
function summarizeReferrers(
  rows: { referrer: string | null; n: number }[],
  windowTotal: number,
): ReferrerStat[] {
  const bySource = new Map<string, number>();
  for (const r of rows) {
    const source = referrerSource(r.referrer);
    bySource.set(source, (bySource.get(source) ?? 0) + r.n);
  }

  // Ties break on source name so the response is deterministic.
  const byViewsDesc = (a: ReferrerStat, b: ReferrerStat) =>
    b.views - a.views || a.source.localeCompare(b.source);

  const top = [...bySource].map(([source, views]) => ({ source, views })).sort(byViewsDesc);

  // The tail is what the LIMIT left behind, derived rather than counted: total
  // views in the window minus what the top buckets account for. This is why the
  // buckets still reconcile with the window total even though the query never
  // sees the long tail.
  //
  // Rows written before referrers were normalised can group more finely than
  // they report, so two top rows can fold into one source here and leave the
  // arithmetic slightly generous. Clamped at zero rather than allowed to go
  // negative — a negative bucket is worse than a small overcount.
  const tailViews = Math.max(0, windowTotal - top.reduce((sum, r) => sum + r.views, 0));
  if (tailViews === 0) return top;

  // 'other' may already be in the top slice (unparseable referrers); merging
  // avoids emitting the same source twice.
  const existingOther = top.find((r) => r.source === 'other');
  if (existingOther) {
    existingOther.views += tailViews;
  } else {
    top.push({ source: 'other', views: tailViews });
  }
  return top.sort(byViewsDesc);
}
