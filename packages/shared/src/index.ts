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

// ---------- Version history ----------

/**
 * How many versions of a share survive. Older ones are pruned by the cleanup
 * cron.
 *
 * 10 rather than 3-5 because a vibe coder revising a page five times in one
 * afternoon would otherwise push out "yesterday's version" — which is exactly
 * the thing version history exists to rescue. AI-generated HTML measures in
 * the tens to low hundreds of KB, so 10 versions per share is cheap.
 */
export const RETENTION_VERSIONS = 10;

/**
 * Attempts `writeNewVersion` makes before giving up with a 409.
 *
 * Each attempt loses only to a concurrent writer that committed first, so
 * three consecutive losses means sustained contention on one share — vanishing
 * unlikely for a single-user tool, and retrying past that is worse than
 * telling the user to press save again.
 */
export const VERSION_WRITE_MAX_ATTEMPTS = 3;

/**
 * Shares processed per retention sweep run. Anything beyond this waits for the
 * next cron tick; the count skipped is logged rather than silently dropped.
 */
export const VERSION_SWEEP_MAX_SHARES = 50;

/**
 * Write rate limit for edit and restore, per IP.
 *
 * Restore is the reason this exists: a tiny request makes the server copy a
 * whole object, so a loop can inflate storage far faster than uploading could,
 * and retention caps steady-state size but not a burst. Edit rides along
 * because it had no limit at all — the 1 MB body was its only brake.
 *
 * Generous on purpose. Someone iterating on a page saves every few seconds;
 * this only stops scripts.
 */
export const WRITE_RATE_LIMIT_PERIOD_SECONDS = 60; // binding accepts 10 or 60
export const WRITE_RATE_LIMIT_PER_IP = 30;

export interface VersionEntry {
  version: number;
  /** ISO; from R2's `uploaded`, not a separately stored timestamp. */
  createdAt: string;
  contentSize: number;
}

export interface VersionListResponse {
  slug: string;
  latestVersion: number;
  /** Descending by version. At most RETENTION_VERSIONS entries. */
  versions: VersionEntry[];
}

export interface RestoreResponse {
  slug: string;
  restoredFrom: number;
  newVersion: number;
}

/**
 * How long a view row keeps its raw `ua` and `referrer`.
 *
 * These are the only free-text, viewer-attributable fields we store (the IP is
 * already salted+hashed on write). Retaining them forever has no product
 * value — nobody asks where traffic came from six months later — and turns a
 * view log into an indefinite behavioural record. After the window a sweep
 * nulls both columns; the row itself survives so historical view counts don't
 * silently change.
 *
 * The referrer breakdown is scoped to the same window, so anonymized rows
 * can't quietly reappear as 'direct'.
 */
export const VIEW_PII_RETENTION_SECONDS = 90 * 24 * 60 * 60; // 90 days

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

/**
 * How many referrer sources GET /api/share/:slug/stats returns. Everything
 * past the cut is folded into a single 'other' bucket so the totals still
 * reconcile against `views` — a truncated list that silently loses views
 * reads as a bug to anyone who adds up the numbers.
 */
export const STATS_TOP_REFERRERS = 5;

/**
 * Length of the daily view trend returned by the stats endpoint. Bounded so
 * the response stays a fixed size no matter how old or busy a share is.
 */
export const STATS_TREND_DAYS = 30;

export interface DailyViewStat {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  views: number;
}

export interface ReferrerStat {
  /**
   * Hostname with any leading `www.` stripped, or one of two synthetic
   * buckets: 'direct' (no Referer header — typed URL, bookmark, most native
   * apps) and 'other' (unparseable referrer, plus the long tail past
   * STATS_TOP_REFERRERS).
   *
   * Only the hostname is exposed, never path or query — the raw Referer of a
   * private page is itself sensitive, and the host is all the sender needs to
   * know where traffic came from.
   */
  source: string;
  views: number;
}

/**
 * How many location buckets the stats endpoint returns before folding the rest
 * into 'other'. Larger than STATS_TOP_REFERRERS because cities spread wider
 * than referring hosts do — a link passed around a company lands in a handful
 * of hosts but a dozen cities.
 */
export const STATS_TOP_LOCATIONS = 8;

export interface LocationStat {
  /** ISO 3166-1 alpha-2 as resolved by Cloudflare, or null if unresolved. */
  country: string | null;
  /**
   * City as resolved by Cloudflare. Frequently null even when `country` is
   * not — CF resolves a city only when it is confident, and a VPN, a corporate
   * egress, or a mobile carrier often leaves it blank. Null means unknown, not
   * "somewhere else".
   */
  city: string | null;
  /**
   * Display label, precomputed so every client renders the same string:
   * `"Taipei, TW"`, or `"TW"` when the city is unknown, or the synthetic
   * buckets 'unknown' (no country either) and 'other' (the tail past
   * STATS_TOP_LOCATIONS).
   */
  label: string;
  views: number;
}

export interface ShareStats {
  slug: string;
  createdAt: string; // ISO
  views: number;
  /**
   * Distinct salted IP hashes. Always <= views. This is an approximation by
   * construction: NAT/CGNAT collapses separate people into one hash, and a
   * viewer on a rotating mobile IP counts more than once.
   */
  uniqueViewers: number;
  /**
   * Views from crawlers and chat-app link unfurlers, excluded from `views`.
   * Reported rather than hidden: "Slack previewed it twice, nobody opened it"
   * is a real answer to "did anyone see my share", and a bare 0 is not.
   */
  botViews: number;
  lastViewedAt: string | null;
  /**
   * Descending by views, at most STATS_TOP_REFERRERS + 1 entries. Covers only
   * the last VIEW_PII_RETENTION_SECONDS — older rows have had their referrer
   * stripped, so counting them would just pad 'direct'. This means the
   * referrer views can sum to less than `views` on an old share.
   */
  referrers: ReferrerStat[];
  /**
   * Descending by views, at most STATS_TOP_LOCATIONS + 1 entries. Same
   * retention window as `referrers`, for the same reason: past the window the
   * sweep has nulled the columns, and counting those rows would inflate
   * 'unknown' with views whose location we simply no longer keep.
   */
  locations: LocationStat[];
  /**
   * Human views per UTC day for the last STATS_TREND_DAYS, oldest first,
   * including zero-view days. Gaps are filled server-side so a client can
   * render it directly without reconstructing the calendar.
   *
   * UTC, not the viewer's or sender's local time: the bucket has to be stable
   * for everyone reading the same share.
   */
  dailyViews: DailyViewStat[];
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
  /** Highest existing version. Monotonic — restore appends, never rewinds. */
  latest_version: number;
  /** Oldest version the retention sweep kept; makes the sweep converge. */
  versions_pruned_below: number;
  /** Unix seconds a writer last stranded an object by losing its CAS. */
  orphan_since: number | null;
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
  is_bot: 0 | 1;
  /** Resolved by Cloudflare at write time; nulled by the retention sweep. */
  country: string | null;
  city: string | null;
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
