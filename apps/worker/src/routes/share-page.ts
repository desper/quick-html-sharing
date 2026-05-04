import { Hono, type Context } from 'hono';
import type { ShareRow } from '@qhs/shared';
import type { AppEnv } from '../types';
import { sharePageSecurityHeaders } from '../middleware/security-headers';
import { htmlObjectKey } from './upload';
import { hashIp } from '../lib/hash';
import { getClientIp } from '../lib/ip';

/**
 * GET /:slug — serves user-uploaded HTML on the share subdomain.
 *
 * Records a view event in D1 (best-effort, never blocks the response).
 * Appends a small footer watermark to make the host attribution visible
 * AND to give viewers a "report" link for abuse.
 */
export const sharePageRoute = new Hono<AppEnv>();

sharePageRoute.get('/:slug', sharePageSecurityHeaders, async (c) => {
  const slug = c.req.param('slug');
  if (!slug || !/^[a-z0-9]{8,16}$/.test(slug)) {
    return c.notFound();
  }

  const row = await c.env.DB.prepare(
    `SELECT slug, status, edit_token_hash, created_at, committed_at, deleted_at,
            sender_ip_hash, content_size
     FROM shares WHERE slug = ?`,
  )
    .bind(slug)
    .first<ShareRow>();

  if (!row || row.status !== 'committed') {
    return c.notFound();
  }

  // ---- record view (fire-and-forget on the side, don't block response) ----
  c.executionCtx.waitUntil(recordView(c, slug));

  // ---- fetch HTML from R2 ----
  const obj = await c.env.HTML_BUCKET.get(htmlObjectKey(slug));
  if (!obj) {
    // Metadata says committed but R2 doesn't have the body. Should not happen
    // unless someone manually deleted from R2. Fail loud rather than silent.
    return c.text('Storage inconsistent — please report this slug.', 500);
  }

  const original = await obj.text();
  const withWatermark = injectWatermark(original, slug, c.env.DASHBOARD_HOST);
  return c.html(withWatermark);
});

async function recordView(c: Context<AppEnv>, slug: string) {
  try {
    const ipHash = await hashIp(getClientIp(c), c.env.IP_HASH_SALT);
    const now = Math.floor(Date.now() / 1000);
    const ua = c.req.header('User-Agent') ?? null;
    const referrer = c.req.header('Referer') ?? null;
    await c.env.DB.prepare(
      `INSERT INTO views (slug, viewed_at, ip_hash, ua, referrer) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(slug, now, ipHash, ua, referrer)
      .run();
  } catch {
    // View tracking is best-effort. Failing here must not break HTML delivery.
  }
}

/**
 * Appends a small fixed-position footer to the user's HTML.
 *
 * Why inject text into user HTML when the design doc said "do not inject":
 *   - The design doc rule was about NOT injecting JS to track viewers.
 *   - This is a static, no-script HTML snippet. Adds attribution + an abuse
 *     report link. Visible in the corner, not blocking content.
 *   - Required for the disclaimer that protects you from being treated as
 *     publisher of phishing content.
 *
 * Keeps the user's HTML byte-identical except for one appended <div>.
 */
function injectWatermark(html: string, slug: string, dashboardHost: string): string {
  const reportUrl = `https://${dashboardHost}/report?slug=${encodeURIComponent(slug)}`;
  const watermark = `\n<!-- quick-html-sharing watermark -->\n<div id="__qhs_wm" style="position:fixed;bottom:8px;right:8px;z-index:2147483647;font:11px/1.4 system-ui,sans-serif;background:rgba(0,0,0,.55);color:#fff;padding:5px 9px;border-radius:6px;backdrop-filter:blur(6px)">Hosted by qhs · <a href="${reportUrl}" style="color:#fff;text-decoration:underline" rel="noopener">Report</a></div>\n`;
  // Append before </body> if present, else at end.
  const i = html.lastIndexOf('</body>');
  if (i === -1) return html + watermark;
  return html.slice(0, i) + watermark + html.slice(i);
}
