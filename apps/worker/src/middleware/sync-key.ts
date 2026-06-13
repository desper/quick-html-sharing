import { SYNC_KEY_REGEX } from '@qhs/shared';
import { createMiddleware } from 'hono/factory';
import { sha256Hex } from '../lib/hash';
import type { AppEnv } from '../types';

/**
 * Sync key ("sync code") auth for the My Shares registry.
 *
 * IRON RULE: the raw key must NEVER be logged — not in console.log, not in
 * error messages, not by echoing request headers. Anything that leaves this
 * middleware is sha256(key) only. If you add logging anywhere near here,
 * log the hash or nothing.
 *
 * Keys are client-generated and the server keeps no key registry, so any
 * well-formed `qhsk_` string is a "valid empty ledger". Format validation
 * here only catches malformed input (edit token pasted as a sync code,
 * truncated copy) — typo'd-but-well-formed keys are a UI concern (D7).
 */

/** Extracts the bearer token from the Authorization header, if present. */
function bearerOf(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/);
  return match?.[1] ?? null;
}

const invalidKeyResponse = {
  error: 'invalid_sync_key',
  message: 'Malformed sync code — it should look like qhsk_ followed by 43 characters.',
} as const;

/**
 * Required variant: `Authorization: Bearer qhsk_...` must be present and
 * well-formed, else 401. On success sets `ownerKeyHash` = sha256(key).
 */
export const syncKeyAuth = createMiddleware<AppEnv>(async (c, next) => {
  const key = bearerOf(c.req.header('Authorization'));
  if (!key) {
    return c.json(
      { error: 'missing_sync_key', message: 'Authorization: Bearer <sync code> required.' },
      401,
    );
  }
  if (!SYNC_KEY_REGEX.test(key)) {
    return c.json(invalidKeyResponse, 401);
  }
  c.set('ownerKeyHash', await sha256Hex(key));
  await next();
});

/**
 * Optional variant (upload): no Authorization header → pass through with no
 * ownerKeyHash. A header that IS present but malformed still 401s — silently
 * dropping a bad key would "succeed" the upload without enrolling it, which
 * the user only discovers much later as a missing row in My Shares.
 */
export const syncKeyOptional = createMiddleware<AppEnv>(async (c, next) => {
  const authorization = c.req.header('Authorization');
  if (authorization === undefined) {
    await next();
    return;
  }
  const key = bearerOf(authorization);
  if (!key || !SYNC_KEY_REGEX.test(key)) {
    return c.json(invalidKeyResponse, 401);
  }
  c.set('ownerKeyHash', await sha256Hex(key));
  await next();
});
