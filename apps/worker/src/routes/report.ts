import { Hono } from 'hono';
import type { ReportRequest } from '@qhs/shared';
import type { AppEnv } from '../types';
import { hashIp } from '../lib/hash';
import { getClientIp } from '../lib/ip';

/**
 * POST /api/report/:slug
 * Body: { reason, reporterEmail? }
 *
 * Dedupe on (slug, reporter_ip_hash) UNIQUE constraint — same reporter
 * resubmitting on the same slug returns 200 idempotently. This stops bad
 * actors from spamming admin notifications by hammering /report.
 */
export const reportRoute = new Hono<AppEnv>();

reportRoute.post('/report/:slug', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req
    .json<Partial<ReportRequest>>()
    .catch(() => ({}) as Partial<ReportRequest>);

  if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
    return c.json({ error: 'bad_request', message: 'Missing reason.' }, 400);
  }
  if (body.reason.length > 2000) {
    return c.json({ error: 'payload_too_large', message: 'Reason too long.' }, 413);
  }
  if (body.reporterEmail !== undefined && typeof body.reporterEmail !== 'string') {
    return c.json({ error: 'bad_request', message: 'Bad reporterEmail.' }, 400);
  }

  // Confirm slug exists (shouldn't surface non-existent slugs).
  const exists = await c.env.DB.prepare(`SELECT 1 FROM shares WHERE slug = ?`)
    .bind(slug)
    .first();
  if (!exists) {
    return c.json({ error: 'not_found', message: 'Share not found.' }, 404);
  }

  const reporterIpHash = await hashIp(getClientIp(c), c.env.IP_HASH_SALT);
  const now = Math.floor(Date.now() / 1000);

  try {
    await c.env.DB.prepare(
      `INSERT INTO reports (slug, reason, reporter_email, reporter_ip_hash, reported_at, status)
       VALUES (?, ?, ?, ?, ?, 'open')`,
    )
      .bind(slug, body.reason.trim(), body.reporterEmail ?? null, reporterIpHash, now)
      .run();
  } catch (err) {
    // UNIQUE constraint on (slug, reporter_ip_hash) — already reported by this
    // IP. Treat as success: report was already received, no admin spam.
    if (isConstraintError(err)) {
      return c.json({ slug, ok: true, deduped: true });
    }
    throw err;
  }

  return c.json({ slug, ok: true });
});

function isConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint|constraint failed/i.test(msg);
}
