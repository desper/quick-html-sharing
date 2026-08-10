import type { ShareRow } from '@qhs/shared';
import { type Context, Hono } from 'hono';
import { isBotUserAgent } from '../lib/bot';
import { hashIp } from '../lib/hash';
import { getClientIp } from '../lib/ip';
import { htmlObjectKey } from '../lib/objectKey';
import { normalizeReferrer } from '../lib/referrer';
import { sharePageSecurityHeaders } from '../middleware/security-headers';
import type { AppEnv } from '../types';

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
            sender_ip_hash, content_size, latest_version
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
  // The share URL always serves the newest version. `latest_version` rides
  // along on the SELECT above, so this costs no extra query and no extra R2
  // call: the hot path is exactly as expensive as it was before versioning.
  const obj = await c.env.HTML_BUCKET.get(htmlObjectKey(slug, row.latest_version));
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
    // Normalised here, not in the stats query. The header is attacker-supplied
    // and unbounded; storing it raw let anyone with the share URL create
    // unlimited GROUP BY rows. See lib/referrer.ts.
    const referrer = normalizeReferrer(c.req.header('Referer'));
    // Classified at write time, not at read time: the UA is only meaningful
    // here, and a stored flag keeps the stats query a plain indexed filter.
    const isBot = isBotUserAgent(ua) ? 1 : 0;
    // Cloudflare resolves this per request, so there is no GeoIP lookup and no
    // third party. It also has to be captured here or not at all: the only
    // other field that could infer location is the IP, and that is stored as a
    // salted one-way hash.
    //
    // Both are optional on purpose. CF often resolves a country but not a city
    // (VPN, corporate egress, mobile carrier), and an absent value must stay
    // NULL — "unknown" is a real answer and guessing would be worse than none.
    const cf = c.req.raw.cf;
    const country = typeof cf?.country === 'string' ? cf.country : null;
    const city = typeof cf?.city === 'string' ? cf.city : null;
    await c.env.DB.prepare(
      `INSERT INTO views (slug, viewed_at, ip_hash, ua, referrer, is_bot, country, city)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(slug, now, ipHash, ua, referrer, isBot, country, city)
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
 * To avoid covering content in the bottom-right corner (chat bubbles, back-to-top
 * buttons, etc.), the badge collapses to a tiny "qhs" pill by default and expands
 * to the full "Hosted by qhs · Report" only on hover or keyboard focus. Pure CSS,
 * no JS — the expansion is :hover/:focus-within, and the Report link stays in the
 * DOM (opacity-toggled, not display:none) so it remains keyboard-reachable. All
 * selectors are scoped under #__qhs_wm so user styles are never touched.
 *
 * Keeps the user's HTML byte-identical except for one appended <style> + <div>.
 */
function injectWatermark(html: string, slug: string, dashboardHost: string): string {
  const reportUrl = `https://${dashboardHost}/report?slug=${encodeURIComponent(slug)}`;
  const css =
    '#__qhs_wm{position:fixed;bottom:8px;right:8px;z-index:2147483647;font:11px/1.4 system-ui,sans-serif;opacity:.7;transition:opacity .15s}' +
    '#__qhs_wm:hover{opacity:1}' +
    '#__qhs_wm .__qhs_dot{display:inline-block;background:rgba(0,0,0,.55);color:#fff;padding:4px 7px;border-radius:6px;backdrop-filter:blur(6px);user-select:none;transition:opacity .15s}' +
    '#__qhs_wm .__qhs_full{position:absolute;right:0;bottom:0;white-space:nowrap;background:rgba(0,0,0,.7);color:#fff;padding:5px 9px;border-radius:6px;backdrop-filter:blur(6px);opacity:0;pointer-events:none;transition:opacity .15s}' +
    '#__qhs_wm:hover .__qhs_dot,#__qhs_wm:focus-within .__qhs_dot{opacity:0}' +
    '#__qhs_wm:hover .__qhs_full,#__qhs_wm:focus-within .__qhs_full{opacity:1;pointer-events:auto}' +
    '#__qhs_wm a{color:#fff;text-decoration:underline}';
  const watermark = `\n<!-- quick-html-sharing watermark -->\n<style>${css}</style>\n<div id="__qhs_wm"><span class="__qhs_dot">qhs</span><span class="__qhs_full">Hosted by qhs · <a href="${reportUrl}" rel="noopener">Report</a></span></div>\n`;
  // Append before </body> if present, else at end.
  const i = html.lastIndexOf('</body>');
  if (i === -1) return html + watermark;
  return html.slice(0, i) + watermark + html.slice(i);
}
