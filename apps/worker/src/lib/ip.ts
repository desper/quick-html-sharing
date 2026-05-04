import type { Context } from 'hono';

/**
 * Extracts the client IP from a Cloudflare-fronted request.
 *
 * `CF-Connecting-IP` is set by Cloudflare and cannot be spoofed by the client
 * when traffic actually arrives via the CF edge. Falls back to a fixed
 * placeholder so dev / test runs (where this header is absent) still work.
 */
export function getClientIp(c: Context): string {
  return c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? '0.0.0.0';
}
