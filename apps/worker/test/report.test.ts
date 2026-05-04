import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { dashboardFetch, uploadHtml } from './_helpers';

async function createShare(): Promise<string> {
  const res = await uploadHtml('<!doctype html><html><body>x</body></html>', '198.51.100.40');
  return ((await res.json()) as { slug: string }).slug;
}

describe('POST /api/report/:slug', () => {
  it('happy path stores report', async () => {
    const slug = await createShare();
    const res = await dashboardFetch(`/api/report/${slug}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.50',
      },
      body: JSON.stringify({ reason: 'phishing for bank login' }),
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT reason, status FROM reports WHERE slug = ?')
      .bind(slug)
      .first<{ reason: string; status: string }>();
    expect(row?.reason).toBe('phishing for bank login');
    expect(row?.status).toBe('open');
  });

  it('dedupes same reporter on same slug', async () => {
    const slug = await createShare();
    const r1 = await dashboardFetch(`/api/report/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.51' },
      body: JSON.stringify({ reason: 'first' }),
    });
    const r2 = await dashboardFetch(`/api/report/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.51' },
      body: JSON.stringify({ reason: 'second attempt' }),
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { deduped?: boolean }).deduped).toBe(true);

    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE slug = ?')
      .bind(slug)
      .first<{ n: number }>();
    expect(c?.n).toBe(1);
  });

  it('different reporters on same slug both stored', async () => {
    const slug = await createShare();
    await dashboardFetch(`/api/report/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.60' },
      body: JSON.stringify({ reason: 'r1' }),
    });
    await dashboardFetch(`/api/report/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.61' },
      body: JSON.stringify({ reason: 'r2' }),
    });
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE slug = ?')
      .bind(slug)
      .first<{ n: number }>();
    expect(c?.n).toBe(2);
  });

  it('rejects empty reason', async () => {
    const slug = await createShare();
    const res = await dashboardFetch(`/api/report/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown slug', async () => {
    const res = await dashboardFetch(`/api/report/nonexistent12`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});
