import {
  type DailyViewStat,
  type ReferrerStat,
  STATS_TOP_REFERRERS,
  STATS_TREND_DAYS,
  type ShareRow,
  type ShareStats,
  VIEW_PII_RETENTION_SECONDS,
} from '@qhs/shared';
import { Hono } from 'hono';
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
  const [counts, referrerRows, dailyRows] = await Promise.all([
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
    // Grouping in SQL keeps the response row count proportional to the number
    // of distinct referrers (small), not to the number of views (unbounded).
    //
    // Scoped to the retention window on purpose: past it the sweep has nulled
    // `referrer`, and those rows would otherwise be indistinguishable from a
    // genuine no-referrer visit and inflate 'direct' over time.
    c.env.DB.prepare(
      `SELECT referrer, COUNT(*) AS n FROM views
       WHERE slug = ? AND is_bot = 0 AND viewed_at >= ?
       GROUP BY referrer`,
    )
      .bind(slug, now - VIEW_PII_RETENTION_SECONDS)
      .all<{ referrer: string | null; n: number }>(),
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
    referrers: summarizeReferrers(referrerRows.results ?? []),
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
 * Reduces a raw Referer header to the hostname we report to the sender.
 *
 * Drops path and query deliberately: a referrer URL can itself be sensitive
 * (the linking page may be private), and the host is the whole signal here.
 * `www.` is stripped so google.com and www.google.com don't split one source
 * into two rows.
 */
function referrerSource(raw: string | null): string {
  if (!raw) return 'direct';
  try {
    const host = new URL(raw).hostname.replace(/^www\./, '');
    return host || 'direct';
  } catch {
    // Referer is attacker-controllable and not guaranteed to be a valid URL.
    return 'other';
  }
}

/**
 * Folds grouped referrer rows into at most STATS_TOP_REFERRERS + 1 buckets.
 *
 * The tail is summed into 'other' rather than dropped so the bucket views
 * always add up to the total view count.
 */
function summarizeReferrers(rows: { referrer: string | null; n: number }[]): ReferrerStat[] {
  const bySource = new Map<string, number>();
  for (const r of rows) {
    const source = referrerSource(r.referrer);
    bySource.set(source, (bySource.get(source) ?? 0) + r.n);
  }

  // Ties break on source name so the response is deterministic.
  const byViewsDesc = (a: ReferrerStat, b: ReferrerStat) =>
    b.views - a.views || a.source.localeCompare(b.source);

  const sorted = [...bySource].map(([source, views]) => ({ source, views })).sort(byViewsDesc);
  if (sorted.length <= STATS_TOP_REFERRERS) return sorted;

  const top = sorted.slice(0, STATS_TOP_REFERRERS);
  const tailViews = sorted.slice(STATS_TOP_REFERRERS).reduce((sum, r) => sum + r.views, 0);

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
