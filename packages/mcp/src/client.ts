// HTTP client for the qhs API worker.
//
// Endpoint is pinned to the hosted production worker. QHS_ENDPOINT env var
// exists for internal dev/test only — intentionally undocumented in README so
// end users don't bypass the hosted service (which would break the monetization
// model for self-hosting).

const DEFAULT_ENDPOINT = 'https://api.qhs.fyi';
const ENDPOINT = process.env.QHS_ENDPOINT ?? DEFAULT_ENDPOINT;

const VERSION = '0.4.0';
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

/**
 * Uploads HTML. Pass the saved sync key to enrol the share as you create it.
 *
 * Without the bearer the server stores `owner_key_hash = NULL`, and a share
 * that was never enrolled cannot be reached by sync key from anywhere — so
 * version history and restore silently stop working on the user's other
 * machines even though the sync code was saved on both. The web uploader has
 * always sent it; the agent integrations did not, which made the cross-device
 * story true for the dashboard and false for MCP and the skill.
 */
export function uploadHtml(html: string, syncKey?: string | null): Promise<UploadResult> {
  return call<UploadResult>('/api/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(syncKey ? { Authorization: `Bearer ${syncKey}` } : {}),
    },
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

/**
 * Accepts either credential, same as the version endpoints. The server has
 * always taken a sync-key bearer here (`authorizeShareOwnership`); this client
 * used to send only an edit token, which made deleting a share created on
 * another machine impossible from the agent even though the API allowed it.
 */
export function deleteShare(
  slug: string,
  creds: ShareCredentials,
): Promise<{ slug: string; ok: true }> {
  return call('/api/share/' + encodeURIComponent(slug), {
    method: 'DELETE',
    ...credentialPayload(creds),
  });
}

export interface MyShareItem {
  slug: string;
  createdAt: string;
  shareUrl: string;
}

/**
 * Every share enrolled under this sync key, newest first.
 *
 * Paginated on the server (seek on `(created_at, slug)`), so this follows the
 * cursor rather than assuming one page. `maxPages` is a stop, not a limit we
 * expect to hit — but a caller that silently returned the first 100 of 400
 * shares would look exactly like a caller that returned all 100 of them, so
 * the truncation is reported instead of swallowed.
 */
export async function listMyShares(
  syncKey: string,
  maxPages = 5,
): Promise<{ shares: MyShareItem[]; truncated: boolean }> {
  const shares: MyShareItem[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const query: string = `?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res: { shares: MyShareItem[]; nextCursor: string | null } = await call(
      `/api/my-shares${query}`,
      { method: 'GET', headers: { Authorization: `Bearer ${syncKey}` } },
    );
    shares.push(...res.shares);
    if (!res.nextCursor) return { shares, truncated: false };
    cursor = res.nextCursor;
  }
  return { shares, truncated: true };
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

/** Either credential authorizes a share operation; `deleteShare` takes one too. */
export type ShareCredentials = { editToken: string } | { syncKey: string };
/** Historic name, kept so the version helpers below still read as they did. */
export type VersionCredentials = ShareCredentials;

/**
 * Exactly one credential goes on the wire: a sync key in the Authorization
 * header, or an edit token in the body. Never both — the server treats the
 * bearer as authoritative and ignores a body token, so sending both would hide
 * which one actually authorized the call.
 *
 * The edit token travels in a body and never in a path or query string, which
 * is what forces the version endpoints to be POST: URLs end up in server logs.
 */
function credentialPayload(creds: ShareCredentials): {
  headers: Record<string, string>;
  body: string;
} {
  return 'syncKey' in creds
    ? {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.syncKey}` },
        body: '{}',
      }
    : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editToken: creds.editToken }),
      };
}

function credentialInit(creds: ShareCredentials): RequestInit {
  return { method: 'POST', ...credentialPayload(creds) };
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
