import { createMiddleware } from 'hono/factory';
import { UPLOAD_RATE_MAX_PER_WINDOW, UPLOAD_RATE_WINDOW_SECONDS } from '@qhs/shared';
import type { AppEnv } from '../types';
import { getClientIp } from '../lib/ip';
import { hashIp } from '../lib/hash';

/**
 * Upload rate limit: at most N uploads per window per sender IP.
 *
 * Uses the existing `shares` table as a sliding-window counter. Slightly
 * heavier than KV but avoids a second store, and "shares created in last 30s
 * by this IP" is the actual semantic we want anyway.
 */
export const uploadRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const ip = getClientIp(c);
  const ipHash = await hashIp(ip, c.env.IP_HASH_SALT);
  const since = Math.floor(Date.now() / 1000) - UPLOAD_RATE_WINDOW_SECONDS;

  const result = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM shares WHERE sender_ip_hash = ? AND created_at > ?`,
  )
    .bind(ipHash, since)
    .first<{ n: number }>();

  if ((result?.n ?? 0) >= UPLOAD_RATE_MAX_PER_WINDOW) {
    return c.json(
      {
        error: 'rate_limited',
        message: `Too fast — wait ${UPLOAD_RATE_WINDOW_SECONDS}s between uploads.`,
      },
      429,
      { 'Retry-After': String(UPLOAD_RATE_WINDOW_SECONDS) },
    );
  }

  c.set('senderIpHash', ipHash);
  await next();
});
