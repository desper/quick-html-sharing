// HTTP client for the qhs API worker.
//
// Endpoint is pinned to the hosted production worker. QHS_ENDPOINT env var
// exists for internal dev/test only — intentionally undocumented in README so
// end users don't bypass the hosted service (which would break the monetization
// model for self-hosting).

const DEFAULT_ENDPOINT = 'https://api.qhs.fyi';
const ENDPOINT = process.env.QHS_ENDPOINT ?? DEFAULT_ENDPOINT;

const VERSION = '0.2.3';
const USER_AGENT = `qhs-mcp/${VERSION}`;

export interface UploadResult {
  slug: string;
  shareUrl: string;
  editToken: string;
  editUrl: string;
}

export interface ReferrerStat {
  /** Hostname, or the synthetic buckets 'direct' / 'other'. */
  source: string;
  views: number;
}

export interface DailyViewStat {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  views: number;
}

export interface StatsResult {
  slug: string;
  createdAt: string;
  views: number;
  uniqueViewers: number;
  /** Crawler / link-unfurl fetches, excluded from `views`. */
  botViews: number;
  lastViewedAt: string | null;
  referrers: ReferrerStat[];
  /** Human views per UTC day for the last 30 days, oldest first. */
  dailyViews: DailyViewStat[];
  deleted: boolean;
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const r = await fetch(`${ENDPOINT}${path}`, {
    ...init,
    headers: {
      'User-Agent': USER_AGENT,
      ...init.headers,
    },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`qhs ${init.method ?? 'GET'} ${path} → ${r.status}: ${text}`);
  }
  return (await r.json()) as T;
}

export function uploadHtml(html: string): Promise<UploadResult> {
  return call<UploadResult>('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html }),
  });
}

export function editHtml(
  slug: string,
  html: string,
  editToken: string,
): Promise<{ slug: string; ok: true }> {
  return call('/api/edit/' + encodeURIComponent(slug), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, editToken }),
  });
}

export function deleteShare(slug: string, editToken: string): Promise<{ slug: string; ok: true }> {
  return call('/api/share/' + encodeURIComponent(slug), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ editToken }),
  });
}

export function getStats(slug: string): Promise<StatsResult> {
  return call('/api/share/' + encodeURIComponent(slug) + '/stats', { method: 'GET' });
}

// ---------- version history ----------

export interface VersionEntry {
  version: number;
  createdAt: string;
  contentSize: number;
}

export interface VersionListResult {
  slug: string;
  latestVersion: number;
  versions: VersionEntry[];
}

export interface RestoreResult {
  slug: string;
  restoredFrom: number;
  newVersion: number;
}

/**
 * Version endpoints accept either credential. Exactly one is sent: a sync key
 * in the Authorization header, or an edit token in the body. Never both — the
 * server treats the bearer as authoritative and ignores a body token, so
 * sending both would hide which one actually authorized the call.
 *
 * These are POST, not GET, because an edit token may only travel in a body:
 * URL paths and query strings end up in server logs.
 */
export type VersionCredentials = { editToken: string } | { syncKey: string };

function credentialInit(creds: VersionCredentials): RequestInit {
  return 'syncKey' in creds
    ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.syncKey}` },
        body: '{}',
      }
    : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editToken: creds.editToken }),
      };
}

export function listVersions(slug: string, creds: VersionCredentials): Promise<VersionListResult> {
  return call('/api/share/' + encodeURIComponent(slug) + '/versions', credentialInit(creds));
}

export function restoreVersion(
  slug: string,
  version: number,
  creds: VersionCredentials,
): Promise<RestoreResult> {
  return call(
    '/api/share/' + encodeURIComponent(slug) + '/versions/' + version + '/restore',
    credentialInit(creds),
  );
}

/** Returns the raw source of an old version. Plain text, not parsed as JSON. */
export async function getVersionSource(
  slug: string,
  version: number,
  creds: VersionCredentials,
): Promise<string> {
  const init = credentialInit(creds);
  const path = '/api/share/' + encodeURIComponent(slug) + '/versions/' + version + '/raw';
  const r = await fetch(`${ENDPOINT}${path}`, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, ...init.headers },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`qhs POST ${path} → ${r.status}: ${text}`);
  }
  return r.text();
}
