/// <reference types="@cloudflare/workers-types" />

export interface Bindings {
  DB: D1Database;
  HTML_BUCKET: R2Bucket;
  /**
   * "dashboard" → serve /api/* + abuse report ingress. "share" → render user
   * HTML at /:slug. Optional: when unset, dispatch falls back to URL host
   * compared against SHARE_HOST (the original v1 behaviour, kept so tests
   * can simulate both roles from a single deploy).
   */
  WORKER_ROLE?: 'dashboard' | 'share';
  /** Hostname the dashboard is canonically served on (used to construct outbound links). */
  DASHBOARD_HOST: string;
  /** Hostname the share renderer is canonically served on (used to construct share URLs). */
  SHARE_HOST: string;
  IP_HASH_SALT: string;
}

export interface Variables {
  /** Set by uploadRateLimit middleware so the upload handler doesn't re-hash. */
  senderIpHash: string;
  /**
   * sha256 of the caller's sync key, set by sync-key middleware. Present on
   * syncKeyAuth routes; may be absent on syncKeyOptional routes (no bearer).
   * The raw key is never stored on context and never logged.
   */
  ownerKeyHash?: string;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
