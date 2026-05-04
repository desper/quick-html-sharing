/// <reference types="@cloudflare/workers-types" />

export interface Bindings {
  DB: D1Database;
  HTML_BUCKET: R2Bucket;
  DASHBOARD_HOST: string;
  SHARE_HOST: string;
  IP_HASH_SALT: string;
}

export interface Variables {
  /** Set by uploadRateLimit middleware so the upload handler doesn't re-hash. */
  senderIpHash: string;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
