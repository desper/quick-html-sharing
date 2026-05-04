import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types';

/**
 * Headers applied to dashboard / API responses (NOT to share pages).
 * Strict — denies framing, stops MIME sniffing, opts out of cross-origin
 * windows opening into us.
 */
export const dashboardSecurityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Permissions-Policy', 'interest-cohort=()');
});

/**
 * Headers applied to user-uploaded HTML on the share subdomain.
 *
 * The share host serves untrusted HTML, so we cannot apply a strict
 * Content-Security-Policy that breaks the user's content. Instead we:
 *   - Block embedding into the dashboard origin (frame-ancestors 'none').
 *   - Set Cross-Origin-Resource-Policy: same-site so other sites can't read
 *     our HTML response bodies via script.
 *   - X-Content-Type-Options to block MIME sniffing.
 *
 * The MAIN security boundary is that this content lives on a separate
 * subdomain — the dashboard's cookies are SameSite=Strict and path-scoped, so
 * even if the uploaded HTML runs JS, it has no path to dashboard auth.
 */
export const sharePageSecurityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header(
    'Content-Security-Policy',
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  c.header('Cross-Origin-Resource-Policy', 'same-site');
  c.header('Referrer-Policy', 'no-referrer');
  // Don't allow Chrome FLoC etc on user content.
  c.header('Permissions-Policy', 'interest-cohort=()');
});
