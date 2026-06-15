import { SELF } from 'cloudflare:test';

/**
 * Sends a Request to the Worker and returns Response. Default Host is the
 * dashboard host, matching the public API surface.
 */
export async function dashboardFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `https://app.example.com${path}`;
  return SELF.fetch(url, init);
}

export async function shareFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `https://s.example.com${path}`;
  return SELF.fetch(url, init);
}

export async function uploadHtml(
  html: string,
  ip = '198.51.100.1',
  syncKey?: string,
): Promise<Response> {
  return dashboardFetch('/api/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
      ...(syncKey ? { Authorization: `Bearer ${syncKey}` } : {}),
    },
    body: JSON.stringify({ html }),
  });
}

/** Well-formed sync key from a single repeated base64url char (tests only). */
export function testSyncKey(ch: string): string {
  return `qhsk_${ch.repeat(43)}`;
}

/** Uploads and returns the parsed body; fails the test on a non-201. */
export async function uploadParsed(
  html: string,
  ip: string,
  syncKey?: string,
): Promise<{ slug: string; editToken: string }> {
  const res = await uploadHtml(html, ip, syncKey);
  if (res.status !== 201) {
    throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { slug: string; editToken: string };
}

export async function listShares(syncKey: string, query = ''): Promise<Response> {
  return dashboardFetch(`/api/my-shares${query}`, {
    headers: { Authorization: `Bearer ${syncKey}` },
  });
}

export async function claimTokens(syncKey: string, editTokens: unknown): Promise<Response> {
  return dashboardFetch('/api/my-shares/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${syncKey}` },
    body: JSON.stringify({ editTokens }),
  });
}
