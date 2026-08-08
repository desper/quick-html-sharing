import { WRITE_RATE_LIMIT_PERIOD_SECONDS } from '@qhs/shared';
import { createMiddleware } from 'hono/factory';
import { hashIp } from '../lib/hash';
import { getClientIp } from '../lib/ip';
import type { AppEnv } from '../types';

/**
 * Per-IP write limit for the endpoints that create a new version: edit and
 * restore.
 *
 * Restore is the asymmetric one. Edit costs the caller a full HTML upload,
 * which is its own brake; restore costs a few dozen bytes and makes the server
 * copy up to 1 MB, so a loop inflates storage far faster than uploading could.
 * Retention bounds steady-state size, not a burst — as the outside voice put
 * it, retention is not an abuse control.
 *
 * Keyed on IP hash only. A per-token layer would be theatre here for the same
 * reason it is on My Shares: the credential is client-held, and anyone able to
 * loop restore already has it.
 *
 * FAIL-OPEN, matching mySharesRateLimit: a missing binding (local dev, tests,
 * share env) or a throwing limiter must never turn into an outage. This is a
 * filter, not an auth gate — authorization has already run by this point.
 */
export const writeRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  let limited = false;
  try {
    const limiter = c.env.WRITE_RATE_LIMIT_IP;
    if (limiter) {
      const ipHash = await hashIp(getClientIp(c), c.env.IP_HASH_SALT);
      limited = !(await limiter.limit({ key: ipHash })).success;
    }
  } catch {
    limited = false;
  }

  if (limited) {
    return c.json(
      { error: 'rate_limited', message: 'Too many writes — slow down and retry shortly.' },
      429,
      { 'Retry-After': String(WRITE_RATE_LIMIT_PERIOD_SECONDS) },
    );
  }
  await next();
});
