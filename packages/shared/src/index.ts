// Shared types between apps/worker and apps/web.
// Keep this file dependency-free so both runtimes can import it cheaply.

/**
 * Slug = the unguessable share id. 12 chars from a 36-char alphabet
 * → ~62 bits of entropy → brute force at 1000 req/s takes ~10^9 years.
 */
export const SLUG_LENGTH = 12;
export const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Edit token = base64url-encoded 16 random bytes (~22 chars).
 * Lives only in URL fragment, never sent to server.
 */
export const EDIT_TOKEN_BYTES = 16;

/** Max HTML body in bytes for v1. */
export const MAX_HTML_BYTES = 1_000_000; // 1 MB

/** Upload rate limit: 1 share per 30s per IP. */
export const UPLOAD_RATE_WINDOW_SECONDS = 30;
export const UPLOAD_RATE_MAX_PER_WINDOW = 1;

/** Minimum cleanup age for stale pending uploads. */
export const PENDING_CLEANUP_AGE_SECONDS = 300; // 5 min

// ---------- API contracts ----------

export interface UploadRequest {
  html: string;
}

export interface UploadResponse {
  slug: string;
  shareUrl: string; // canonical URL on s.<domain>
  editToken: string; // raw, only returned once
  editUrl: string; // shareUrl + `#edit=<editToken>`
}

export interface EditRequest {
  html: string;
  editToken: string;
}

export interface ShareStats {
  slug: string;
  createdAt: string; // ISO
  views: number;
  lastViewedAt: string | null;
  deleted: boolean;
}

export interface ReportRequest {
  reason: string;
  reporterEmail?: string;
}

export interface ApiError {
  error: string;
  message: string;
}

// ---------- D1 row types ----------

export type ClientChannel = 'mcp' | 'skill' | 'web' | 'curl' | 'other';

export interface ShareRow {
  slug: string;
  status: 'pending' | 'committed' | 'deleted';
  edit_token_hash: string; // sha256(editToken)
  created_at: number; // unix seconds
  committed_at: number | null;
  deleted_at: number | null;
  sender_ip_hash: string;
  content_size: number;
  client: ClientChannel;
}

export interface ViewRow {
  id: number;
  slug: string;
  viewed_at: number;
  ip_hash: string;
  ua: string | null;
  referrer: string | null;
}

export interface ReportRow {
  id: number;
  slug: string;
  reason: string;
  reporter_email: string | null;
  reporter_ip_hash: string;
  reported_at: number;
  status: 'open' | 'actioned' | 'dismissed';
}
