import { Hono } from 'hono';
import { MAX_HTML_BYTES, type ClientChannel, type UploadResponse } from '@qhs/shared';
import type { AppEnv } from '../types';
import { generateSlug } from '../lib/slug';
import { generateEditToken } from '../lib/tokens';
import { sha256Hex } from '../lib/hash';
import { uploadRateLimit } from '../middleware/rate-limit';

/**
 * Classifies the requesting client from its User-Agent header so we can later
 * answer "how many shares came from MCP vs Skill vs Web vs other".
 *
 * Conservative: matches the prefixes our own packages stamp. Everything else
 * is bucketed by a broad regex or falls through to 'other'.
 */
function classifyClient(ua: string | null | undefined): ClientChannel {
  if (!ua) return 'other';
  if (ua.startsWith('qhs-mcp/')) return 'mcp';
  if (ua.startsWith('qhs-skill/')) return 'skill';
  if (ua.startsWith('curl/')) return 'curl';
  if (/mozilla|chrome|safari|firefox|edge|webkit/i.test(ua)) return 'web';
  return 'other';
}

/**
 * POST /api/upload
 *
 * Body: { html: string }
 * Returns: { slug, shareUrl, editToken, editUrl }
 *
 * Transactional pattern (resilient to partial failures):
 *
 *   ┌─────────────────────────────┐
 *   │ 1. INSERT shares (pending)  │ ← PRIMARY KEY collision retry up to 5x
 *   └────────────┬────────────────┘
 *                ▼
 *   ┌─────────────────────────────┐
 *   │ 2. R2 PUT html              │
 *   └────────────┬────────────────┘
 *                ▼
 *   ┌─────────────────────────────┐
 *   │ 3. UPDATE shares (committed)│
 *   └─────────────────────────────┘
 *
 * If step 2 or 3 fails, the pending row is left for the cleanup job
 * (sweeps rows older than PENDING_CLEANUP_AGE_SECONDS).
 */
export const uploadRoute = new Hono<AppEnv>();

uploadRoute.post('/upload', uploadRateLimit, async (c) => {
  // ---- validate ----
  const contentType = c.req.header('Content-Type') ?? '';
  let html: string;
  if (contentType.includes('application/json')) {
    const body = await c.req
      .json<{ html?: unknown }>()
      .catch(() => ({}) as { html?: unknown });
    if (typeof body.html !== 'string' || body.html.length === 0) {
      return c.json({ error: 'bad_request', message: 'Missing html string in body.' }, 400);
    }
    html = body.html;
  } else if (contentType.includes('text/html') || contentType.includes('text/plain')) {
    html = await c.req.text();
  } else {
    return c.json(
      { error: 'unsupported_media_type', message: 'Content-Type must be JSON or text/html.' },
      415,
    );
  }

  if (html.length === 0) {
    return c.json({ error: 'bad_request', message: 'Empty body.' }, 400);
  }
  // Use byte length, not char count — UTF-8 multibyte chars matter.
  const byteLength = new TextEncoder().encode(html).byteLength;
  if (byteLength > MAX_HTML_BYTES) {
    return c.json(
      { error: 'payload_too_large', message: `Max ${MAX_HTML_BYTES} bytes (got ${byteLength}).` },
      413,
    );
  }

  // Cheap sniff: must look like HTML. Catches accidental binary or pure text.
  if (!looksLikeHtml(html)) {
    return c.json(
      { error: 'unsupported_media_type', message: 'Body does not look like HTML.' },
      415,
    );
  }

  // ---- generate slug + token ----
  const editToken = generateEditToken();
  const editTokenHash = await sha256Hex(editToken);
  const senderIpHash = c.get('senderIpHash');
  const client = classifyClient(c.req.header('User-Agent'));
  const now = Math.floor(Date.now() / 1000);

  let slug = '';
  let pendingInserted = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateSlug();
    try {
      await c.env.DB.prepare(
        `INSERT INTO shares (slug, status, edit_token_hash, created_at, sender_ip_hash, content_size, client)
         VALUES (?, 'pending', ?, ?, ?, ?, ?)`,
      )
        .bind(candidate, editTokenHash, now, senderIpHash, byteLength, client)
        .run();
      slug = candidate;
      pendingInserted = true;
      break;
    } catch (err) {
      // SQLite UNIQUE / PRIMARY KEY collision → retry. Anything else → bubble.
      if (!isConstraintError(err)) throw err;
    }
  }
  if (!pendingInserted) {
    return c.json(
      { error: 'internal', message: 'Could not generate unique slug, retry.' },
      500,
    );
  }

  // ---- R2 write ----
  try {
    await c.env.HTML_BUCKET.put(htmlObjectKey(slug), html, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });
  } catch (err) {
    // R2 failed — leave pending row for cleanup, surface 502 to caller.
    return c.json(
      { error: 'storage_failed', message: 'Could not store HTML, please retry.' },
      502,
    );
  }

  // ---- commit ----
  await c.env.DB.prepare(
    `UPDATE shares SET status = 'committed', committed_at = ? WHERE slug = ? AND status = 'pending'`,
  )
    .bind(now, slug)
    .run();

  const shareUrl = `https://${c.env.SHARE_HOST}/${slug}`;
  const body: UploadResponse = {
    slug,
    shareUrl,
    editToken,
    editUrl: `${shareUrl}#edit=${editToken}`,
  };
  return c.json(body, 201);
});

/** Where uploaded HTML lives in R2. */
export function htmlObjectKey(slug: string): string {
  return `shares/${slug}.html`;
}

function looksLikeHtml(input: string): boolean {
  // Accept anything containing an HTML-ish tag in the first 4KB.
  return /<\w/.test(input.slice(0, 4096));
}

function isConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint|PRIMARY KEY|constraint failed/i.test(msg);
}
