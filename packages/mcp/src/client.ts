// HTTP client for the qhs API worker.
//
// Endpoint is pinned to the hosted production worker. QHS_ENDPOINT env var
// exists for internal dev/test only — intentionally undocumented in README so
// end users don't bypass the hosted service (which would break the monetization
// model for self-hosting).

const DEFAULT_ENDPOINT = 'https://api.qhs.fyi';
const ENDPOINT = process.env.QHS_ENDPOINT ?? DEFAULT_ENDPOINT;

const VERSION = '0.2.2';
const USER_AGENT = `qhs-mcp/${VERSION}`;

export interface UploadResult {
  slug: string;
  shareUrl: string;
  editToken: string;
  editUrl: string;
}

export interface StatsResult {
  slug: string;
  createdAt: string;
  views: number;
  lastViewedAt: string | null;
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

export function editHtml(slug: string, html: string, editToken: string): Promise<{ slug: string; ok: true }> {
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
