import { describe, expect, it } from 'vitest';
import { dashboardFetch, shareFetch, uploadHtml } from './_helpers';

describe('security boundaries', () => {
  it('dashboard responses include strict headers', async () => {
    const res = await dashboardFetch('/api/health');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('share host does not get strict CSP that would block user JS', async () => {
    const html =
      '<!doctype html><html><body><script>window.x=1</script><div>ok</div></body></html>';
    const r = await uploadHtml(html, '198.51.100.70');
    const slug = ((await r.json()) as { slug: string }).slug;
    const view = await shareFetch(`/${slug}`);
    const csp = view.headers.get('Content-Security-Policy') ?? '';
    // CSP must NOT contain "script-src" — we want to allow user JS to run.
    expect(csp).not.toContain('script-src');
    // But MUST contain frame-ancestors 'none' (no embedding into other sites).
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('CORS rejects fetches from non-dashboard origin', async () => {
    const res = await dashboardFetch('/api/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example.com',
        'Access-Control-Request-Method': 'POST',
      },
    });
    // No matching CORS Allow-Origin header for the disallowed origin.
    expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.example.com');
  });

  it('edit token only validates against its own slug', async () => {
    const a = await uploadHtml('<html>A</html>', '198.51.100.71');
    const b = await uploadHtml('<html>B</html>', '198.51.100.72');
    const ja = (await a.json()) as { slug: string; editToken: string };
    const jb = (await b.json()) as { slug: string };

    // Try to edit B with A's token.
    const res = await dashboardFetch(`/api/edit/${jb.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<html>hijacked</html>', editToken: ja.editToken }),
    });
    expect(res.status).toBe(403);
  });
});
