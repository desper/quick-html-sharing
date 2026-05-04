import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { dashboardFetch, uploadHtml } from './_helpers';
import { MAX_HTML_BYTES } from '@qhs/shared';

const SAMPLE_HTML = '<!doctype html><html><body><h1>Hello</h1></body></html>';

describe('POST /api/upload', () => {
  it('happy path — returns slug, share URL, and edit token', async () => {
    const res = await uploadHtml(SAMPLE_HTML);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, string>;
    expect(body.slug).toMatch(/^[a-z0-9]{12}$/);
    expect(body.shareUrl).toBe(`https://s.example.com/${body.slug}`);
    expect(body.editToken.length).toBeGreaterThan(20);
    expect(body.editUrl).toBe(`${body.shareUrl}#edit=${body.editToken}`);

    const row = await env.DB.prepare('SELECT status, content_size FROM shares WHERE slug = ?')
      .bind(body.slug)
      .first<{ status: string; content_size: number }>();
    expect(row?.status).toBe('committed');
    expect(row?.content_size).toBe(new TextEncoder().encode(SAMPLE_HTML).byteLength);

    const obj = await env.HTML_BUCKET.get(`shares/${body.slug}.html`);
    expect(obj).not.toBeNull();
    expect(await obj?.text()).toBe(SAMPLE_HTML);
  });

  it('rejects empty body', async () => {
    const res = await dashboardFetch('/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '198.51.100.2',
      },
      body: JSON.stringify({ html: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects payload over 1 MB', async () => {
    const big = `<html>${'a'.repeat(MAX_HTML_BYTES + 1)}</html>`;
    const res = await uploadHtml(big, '198.51.100.3');
    expect(res.status).toBe(413);
  });

  it('enforces upload rate limit (1 per 30s per IP)', async () => {
    const ip = '198.51.100.4';
    const first = await uploadHtml(SAMPLE_HTML, ip);
    expect(first.status).toBe(201);
    const second = await uploadHtml(SAMPLE_HTML, ip);
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBe('30');
  });

  it('rejects non-HTML body via mime sniff', async () => {
    const res = await dashboardFetch('/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '198.51.100.5',
      },
      // Plain text, no tags — doesn't look like HTML.
      body: JSON.stringify({ html: 'just some text without any tags at all' }),
    });
    expect(res.status).toBe(415);
  });

  it('rejects unsupported Content-Type', async () => {
    const res = await dashboardFetch('/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'CF-Connecting-IP': '198.51.100.6',
      },
      body: SAMPLE_HTML,
    });
    expect(res.status).toBe(415);
  });

  it('accepts text/html Content-Type with raw body', async () => {
    const res = await dashboardFetch('/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/html',
        'CF-Connecting-IP': '198.51.100.7',
      },
      body: SAMPLE_HTML,
    });
    expect(res.status).toBe(201);
  });

  it('two uploads from different IPs both succeed (rate-limit is per-IP)', async () => {
    const a = await uploadHtml(SAMPLE_HTML, '198.51.100.10');
    const b = await uploadHtml(SAMPLE_HTML, '198.51.100.11');
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const ja = (await a.json()) as { slug: string };
    const jb = (await b.json()) as { slug: string };
    expect(ja.slug).not.toBe(jb.slug);
  });
});
