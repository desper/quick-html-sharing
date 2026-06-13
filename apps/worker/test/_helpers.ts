import { SELF } from 'cloudflare:test';

/**
 * Sends a Request to the Worker and returns Response. Default Host is the
 * dashboard host, matching the public API surface.
 */
export async function dashboardFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `https://app.example.com${path}`;
  return SELF.fetch(url, init);
}

export async function shareFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `https://s.example.com${path}`;
  return SELF.fetch(url, init);
}

export async function uploadHtml(
  html: string,
  ip = '198.51.100.1',
): Promise<Response> {
  return dashboardFetch('/api/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
    },
    body: JSON.stringify({ html }),
  });
}
