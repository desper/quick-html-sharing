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

  // CRITICAL regression (eng-review Issue 2A): the allowlist must admit every
  // dashboard origin across the free→production migration and nothing else —
  // especially never the share origin, or uploaded HTML could call /api/*.
  it('CORS allowlist admits dashboard origins only', async () => {
    const preflight = (origin: string) =>
      dashboardFetch('/api/my-shares', {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
      });

    for (const origin of [
      'https://app.example.com', // env DASHBOARD_HOST
      'https://qhs.fyi', // live free deploy
      'https://app.qhs.fyi', // production mapping
    ]) {
      const res = await preflight(origin);
      expect(res.headers.get('Access-Control-Allow-Origin'), origin).toBe(origin);
    }

    for (const origin of ['https://evil.example.com', 'https://s.example.com']) {
      const res = await preflight(origin);
      expect(res.headers.get('Access-Control-Allow-Origin'), origin).not.toBe(origin);
    }
  });

  it('CORS preflight allows the Authorization header (sync key bearer)', async () => {
    const res = await dashboardFetch('/api/my-shares', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://qhs.fyi',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(res.headers.get('Access-Control-Allow-Headers') ?? '').toMatch(/authorization/i);
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
