import { MY_SHARES_RATE_LIMIT_PERIOD_SECONDS } from '@qhs/shared';
import { createMiddleware } from 'hono/factory';
import { hashIp } from '../lib/hash';
import { getClientIp } from '../lib/ip';
import type { AppEnv } from '../types';

/**
 * Two-layer rate limit for the My Shares registry endpoints, on the official
 * Workers Rate Limiting binding (eng-review Layer 1).
 *
 * Layering (eng-review T4 / Codex #3): sync keys are client-minted with no
 * server registry, so an attacker gets a fresh per-key bucket for free —
 * per-key limiting alone is theater. The IP layer is the real abuse floor;
 * the key layer only stops one noisy key from draining a shared IP's budget
 * (CGNAT, office NAT). Both keys into the limiter are hashes — never the raw
 * sync key (see sync-key.ts IRON RULE).
 *
 * FAIL-OPEN (eng-review Issue 3A): binding absent (local dev, tests without
 * injection, share env) or limit() throwing must never block a legitimate
 * user — this is a loose filter, not an auth gate. Bindings are read from
 * c.env per call, so tests inject fakes by passing env overrides.
 *
 * Mount AFTER syncKeyAuth: ownerKeyHash is already on context, and requests
 * that fail auth (401) never reach the limiter.
 */
export const mySharesRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  let limited = false;
  try {
    const ipLimiter = c.env.MY_SHARES_RATE_LIMIT_IP;
    if (ipLimiter) {
      const ipHash = await hashIp(getClientIp(c), c.env.IP_HASH_SALT);
      limited = !(await ipLimiter.limit({ key: ipHash })).success;
    }
    const keyLimiter = c.env.MY_SHARES_RATE_LIMIT_KEY;
    const ownerKeyHash = c.get('ownerKeyHash');
    if (!limited && keyLimiter && ownerKeyHash) {
      limited = !(await keyLimiter.limit({ key: ownerKeyHash })).success;
    }
  } catch {
    limited = false; // fail-open: a broken limiter must not become an outage
  }

  if (limited) {
    return c.json(
      { error: 'rate_limited', message: 'Too many requests — slow down and retry shortly.' },
      429,
      { 'Retry-After': String(MY_SHARES_RATE_LIMIT_PERIOD_SECONDS) },
    );
  }
  await next();
});
