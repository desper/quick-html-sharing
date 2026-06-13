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

/**
 * Sync key ("sync code") = `qhsk_` + base64url-encoded 32 random bytes
 * (43 chars, no padding) → 256 bits of entropy. Client-generated; the server
 * stores only sha256(key) and has no key registry.
 *
 * Transport rules (security-critical):
 * - travels ONLY via `Authorization: Bearer qhsk_...` header or request body
 * - NEVER in a URL path or query string (URLs end up in server logs)
 */
export const SYNC_KEY_PREFIX = 'qhsk_';
export const SYNC_KEY_BYTES = 32;
/**
 * Strict format check — prefix + exactly 43 base64url chars. Rejects edit
 * tokens pasted as sync codes and typo'd keys that would otherwise silently
 * create an empty registry.
 */
export const SYNC_KEY_REGEX = /^qhsk_[A-Za-z0-9_-]{43}$/;

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

// ---------- My Shares (sync key registry) ----------

/** Page size bounds for GET /api/my-shares cursor pagination. */
export const MY_SHARES_DEFAULT_LIMIT = 50;
export const MY_SHARES_MAX_LIMIT = 100;

/** Max edit tokens per POST /api/my-shares/claim call (client loops batches). */
export const CLAIM_MAX_TOKENS = 50;

/**
 * My Shares rate limits (Workers Rate Limiting binding, per CF location).
 * Loose-filter numbers: a real client paginates a 500-share registry in 5
 * requests and claims its whole localStorage in 1-2 — these only stop loops.
 * IP layer is the actual abuse floor (keys are free to mint, so the per-key
 * layer alone would be trivially bypassable); key layer just keeps one noisy
 * key from burning its IP's whole budget for cohabiting users (CGNAT, office).
 */
export const MY_SHARES_RATE_LIMIT_PERIOD_SECONDS = 60; // binding accepts 10 or 60
export const MY_SHARES_RATE_LIMIT_PER_IP = 60;
export const MY_SHARES_RATE_LIMIT_PER_KEY = 30;

export interface MyShareItem {
  slug: string;
  createdAt: string; // ISO
  shareUrl: string;
}

export interface MySharesResponse {
  shares: MyShareItem[];
  /** Opaque cursor for the next page; null = no more pages. */
  nextCursor: string | null;
}

export type ClaimOutcome = 'claimed' | 'already-yours' | 'owned-by-other' | 'not-found';

export interface ClaimRequest {
  editTokens: string[];
}

export interface ClaimResponse {
  /** Aligned to the request's editTokens order (tokens are never echoed back). */
  results: { result: ClaimOutcome; slug: string | null }[];
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
  owner_key_hash: string | null; // sha256(sync key); NULL = unclaimed
  owner_claimed_at: number | null;
  vault_ciphertext: string | null; // v2 placeholder
  vault_updated_at: number | null; // v2 placeholder
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
