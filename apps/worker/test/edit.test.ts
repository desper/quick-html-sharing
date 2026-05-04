import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { dashboardFetch, shareFetch, uploadHtml } from './_helpers';

const ORIGINAL = '<!doctype html><html><body><h1>Original</h1></body></html>';
const REPLACED = '<!doctype html><html><body><h1>Replaced</h1></body></html>';

async function createShare(ip: string): Promise<{ slug: string; editToken: string }> {
  const res = await uploadHtml(ORIGINAL, ip);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { slug: string; editToken: string };
  return body;
}

describe('POST /api/edit/:slug', () => {
  it('correct token replaces HTML', async () => {
    const { slug, editToken } = await createShare('198.51.100.30');
    const res = await dashboardFetch(`/api/edit/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: REPLACED, editToken }),
    });
    expect(res.status).toBe(200);
    const view = await shareFetch(`/${slug}`);
    expect(await view.text()).toContain('Replaced');
  });

  it('wrong token returns 403 and does NOT replace', async () => {
    const { slug } = await createShare('198.51.100.31');
    const res = await dashboardFetch(`/api/edit/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: REPLACED, editToken: 'definitely-wrong' }),
    });
    expect(res.status).toBe(403);
    const obj = await env.HTML_BUCKET.get(`shares/${slug}.html`);
    expect(await obj?.text()).toContain('Original');
  });

  it('unknown slug returns 404', async () => {
    const res = await dashboardFetch(`/api/edit/nonexistent12`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: REPLACED, editToken: 'anything' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/share/:slug', () => {
  it('correct token deletes; share returns 404 after', async () => {
    const { slug, editToken } = await createShare('198.51.100.32');
    const del = await dashboardFetch(`/api/share/${slug}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editToken }),
    });
    expect(del.status).toBe(200);
    const view = await shareFetch(`/${slug}`);
    expect(view.status).toBe(404);
  });

  it('wrong token returns 403', async () => {
    const { slug } = await createShare('198.51.100.33');
    const del = await dashboardFetch(`/api/share/${slug}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editToken: 'wrong' }),
    });
    expect(del.status).toBe(403);
  });
});
