import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { shareFetch, uploadHtml } from './_helpers';

const HTML = '<!doctype html><html><body><h1>X</h1></body></html>';

async function createShare(): Promise<string> {
  const res = await uploadHtml(HTML, `198.51.100.${Math.floor(Math.random() * 200) + 20}`);
  expect(res.status).toBe(201);
  return ((await res.json()) as { slug: string }).slug;
}

describe('GET /:slug on share subdomain', () => {
  it('returns 200 + HTML for committed share', async () => {
    const slug = await createShare();
    const res = await shareFetch(`/${slug}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<h1>X</h1>');
  });

  it('appends watermark with report link', async () => {
    const slug = await createShare();
    const res = await shareFetch(`/${slug}`);
    const text = await res.text();
    expect(text).toContain('id="__qhs_wm"');
    expect(text).toContain(`/report?slug=${slug}`);
  });

  it('returns 404 for unknown slug', async () => {
    const res = await shareFetch('/nonexistent12');
    expect(res.status).toBe(404);
  });

  it('returns 404 for malformed slug (uppercase)', async () => {
    const res = await shareFetch('/ABCDEFGHIJKL');
    expect(res.status).toBe(404);
  });

  it('returns 404 for deleted share', async () => {
    const slug = await createShare();
    await env.DB.prepare("UPDATE shares SET status='deleted', deleted_at=? WHERE slug=?")
      .bind(Math.floor(Date.now() / 1000), slug)
      .run();
    const res = await shareFetch(`/${slug}`);
    expect(res.status).toBe(404);
  });

  it('records a view row per request', async () => {
    const slug = await createShare();
    await shareFetch(`/${slug}`, { headers: { 'CF-Connecting-IP': '203.0.113.1' } });
    await shareFetch(`/${slug}`, { headers: { 'CF-Connecting-IP': '203.0.113.2' } });
    // waitUntil completes before SELF.fetch resolves in vitest-pool-workers.
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM views WHERE slug = ?')
      .bind(slug)
      .first<{ n: number }>();
    expect(c?.n).toBe(2);
  });

  it('serves CSP and isolation headers', async () => {
    const slug = await createShare();
    const res = await shareFetch(`/${slug}`);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-site');
  });
});
