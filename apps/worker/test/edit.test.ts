import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { claimTokens, dashboardFetch, shareFetch, testSyncKey, uploadHtml } from './_helpers';

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

// Dual authorization with mutually exclusive priority (eng-review Issue 6A):
// an Authorization header commits to the owner-key path — no editToken
// fallback. The two tests above are the CRITICAL regression for the
// header-less path.
describe('DELETE /api/share/:slug — owner-key path', () => {
  const KEY_A = testSyncKey('e');
  const KEY_B = testSyncKey('f');

  async function createOwnedShare(ip: string) {
    const share = await createShare(ip);
    const res = await claimTokens(KEY_A, [share.editToken]);
    expect(res.status).toBe(200);
    return share;
  }

  it('owning key deletes without an editToken', async () => {
    const { slug } = await createOwnedShare('198.51.100.34');
    const del = await dashboardFetch(`/api/share/${slug}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${KEY_A}` },
    });
    expect(del.status).toBe(200);
    const view = await shareFetch(`/${slug}`);
    expect(view.status).toBe(404);
  });

  it('non-owning key gets 403 — correct editToken in body is NOT a fallback', async () => {
    const { slug, editToken } = await createOwnedShare('198.51.100.35');
    const del = await dashboardFetch(`/api/share/${slug}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY_B}` },
      body: JSON.stringify({ editToken }),
    });
    expect(del.status).toBe(403);
    const view = await shareFetch(`/${slug}`);
    expect(view.status).toBe(200); // share survives
  });

  it('unclaimed share 403s on the key path', async () => {
    const { slug } = await createShare('198.51.100.36');
    const del = await dashboardFetch(`/api/share/${slug}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${KEY_A}` },
    });
    expect(del.status).toBe(403);
  });

  it('neither credential → 400; malformed bearer → 401', async () => {
    const { slug } = await createShare('198.51.100.37');
    const none = await dashboardFetch(`/api/share/${slug}`, { method: 'DELETE' });
    expect(none.status).toBe(400);
    const malformed = await dashboardFetch(`/api/share/${slug}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer not-a-sync-key' },
    });
    expect(malformed.status).toBe(401);
  });
});
