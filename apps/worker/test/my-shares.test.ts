import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import type { ClaimResponse, MySharesResponse } from '@qhs/shared';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { sha256Hex } from '../src/lib/hash';
import { claimTokens, dashboardFetch, listShares, testSyncKey, uploadParsed } from './_helpers';

const KEY_A = testSyncKey('a');
const KEY_B = testSyncKey('b');
const HTML = '<!doctype html><html><body><h1>mine</h1></body></html>';

// ---------------------------------------------------------------------------
// sync-key middleware (required variant, via GET /api/my-shares)
// ---------------------------------------------------------------------------

describe('sync-key middleware', () => {
  it('valid key passes and scopes the registry to that key', async () => {
    const res = await listShares(KEY_A);
    expect(res.status).toBe(200);
  });

  it('missing Authorization header → 401 missing_sync_key', async () => {
    const res = await dashboardFetch('/api/my-shares');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('missing_sync_key');
  });

  it('wrong prefix → 401 invalid_sync_key', async () => {
    const res = await listShares(`qhsx_${'a'.repeat(43)}`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_sync_key');
  });

  it('wrong length → 401 invalid_sync_key', async () => {
    const res = await listShares(`qhsk_${'a'.repeat(20)}`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_sync_key');
  });
});

// ---------------------------------------------------------------------------
// GET /api/my-shares
// ---------------------------------------------------------------------------

describe('GET /api/my-shares', () => {
  it('empty registry → 200 with empty list', async () => {
    const res = await listShares(KEY_A);
    expect(res.status).toBe(200);
    expect((await res.json()) as MySharesResponse).toEqual({ shares: [], nextCursor: null });
  });

  it('returns own committed shares only — never another key’s', async () => {
    const mine = await uploadParsed(HTML, '198.51.100.110', KEY_A);
    await uploadParsed(HTML, '198.51.100.111', KEY_B);

    const body = (await (await listShares(KEY_A)).json()) as MySharesResponse;
    expect(body.shares.map((s) => s.slug)).toEqual([mine.slug]);
    expect(body.shares[0]?.shareUrl).toBe(`https://s.example.com/${mine.slug}`);
    expect(Date.parse(body.shares[0]?.createdAt ?? '')).not.toBeNaN();
  });

  it('excludes pending and deleted rows', async () => {
    const kept = await uploadParsed(HTML, '198.51.100.112', KEY_A);
    const gone = await uploadParsed(HTML, '198.51.100.113', KEY_A);
    await dashboardFetch(`/api/share/${gone.slug}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${KEY_A}` },
    });
    // Pending row owned by the same key (e.g. upload whose R2 write died).
    await env.DB.prepare(
      `INSERT INTO shares (slug, status, edit_token_hash, created_at, sender_ip_hash, content_size, client, owner_key_hash, owner_claimed_at)
       VALUES ('pendingslug1', 'pending', 'deadbeef', 1, 'iphash', 10, 'other', ?, 1)`,
    )
      .bind(await sha256Hex(KEY_A))
      .run();

    const body = (await (await listShares(KEY_A)).json()) as MySharesResponse;
    expect(body.shares.map((s) => s.slug)).toEqual([kept.slug]);
  });

  it('cursor pagination roundtrips all shares without overlap', async () => {
    const slugs = new Set<string>();
    for (let i = 0; i < 3; i++) {
      slugs.add((await uploadParsed(HTML, `198.51.100.${120 + i}`, KEY_A)).slug);
    }

    const page1 = (await (await listShares(KEY_A, '?limit=2')).json()) as MySharesResponse;
    expect(page1.shares).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = (await (
      await listShares(KEY_A, `?limit=2&cursor=${page1.nextCursor}`)
    ).json()) as MySharesResponse;
    expect(page2.shares).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const seen = [...page1.shares, ...page2.shares].map((s) => s.slug);
    expect(new Set(seen).size).toBe(3); // no overlap between pages
    expect(new Set(seen)).toEqual(slugs); // nothing dropped
  });

  it('rejects bad limit and malformed cursor with 400', async () => {
    for (const q of ['?limit=0', '?limit=101', '?limit=abc', '?limit=1.5', '?cursor=%2B%2B']) {
      const res = await listShares(KEY_A, q);
      expect(res.status, q).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/my-shares/claim
// ---------------------------------------------------------------------------

describe('POST /api/my-shares/claim', () => {
  it('four outcomes: claimed / already-yours / owned-by-other / not-found', async () => {
    const share = await uploadParsed(HTML, '198.51.100.130');

    const first = (await (await claimTokens(KEY_A, [share.editToken])).json()) as ClaimResponse;
    expect(first.results).toEqual([{ result: 'claimed', slug: share.slug }]);

    const again = (await (await claimTokens(KEY_A, [share.editToken])).json()) as ClaimResponse;
    expect(again.results).toEqual([{ result: 'already-yours', slug: share.slug }]);

    const other = (await (await claimTokens(KEY_B, [share.editToken])).json()) as ClaimResponse;
    expect(other.results).toEqual([{ result: 'owned-by-other', slug: null }]);

    const bogus = (await (await claimTokens(KEY_A, ['no-such-token'])).json()) as ClaimResponse;
    expect(bogus.results).toEqual([{ result: 'not-found', slug: null }]);
  });

  it('pending and deleted shares uniformly report not-found (no lifecycle leak)', async () => {
    await env.DB.prepare(
      `INSERT INTO shares (slug, status, edit_token_hash, created_at, sender_ip_hash, content_size, client)
       VALUES ('pendingslug2', 'pending', ?, 1, 'iphash', 10, 'other')`,
    )
      .bind(await sha256Hex('pending-token'))
      .run();
    const pending = (await (await claimTokens(KEY_A, ['pending-token'])).json()) as ClaimResponse;
    expect(pending.results).toEqual([{ result: 'not-found', slug: null }]);

    const share = await uploadParsed(HTML, '198.51.100.131');
    await dashboardFetch(`/api/share/${share.slug}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editToken: share.editToken }),
    });
    const deleted = (await (await claimTokens(KEY_A, [share.editToken])).json()) as ClaimResponse;
    expect(deleted.results).toEqual([{ result: 'not-found', slug: null }]);
  });

  it('results align to request order', async () => {
    const share = await uploadParsed(HTML, '198.51.100.132');
    const body = (await (
      await claimTokens(KEY_A, ['bogus-1', share.editToken, 'bogus-2'])
    ).json()) as ClaimResponse;
    expect(body.results.map((r) => r.result)).toEqual(['not-found', 'claimed', 'not-found']);
  });

  it('over 50 tokens → 400; empty array → 200 []; bad body shapes → 400', async () => {
    const over = await claimTokens(
      KEY_A,
      Array.from({ length: 51 }, (_, i) => `t${i}`),
    );
    expect(over.status).toBe(400);

    const empty = await claimTokens(KEY_A, []);
    expect(empty.status).toBe(200);
    expect((await empty.json()) as ClaimResponse).toEqual({ results: [] });

    for (const bad of ['not-an-array', [42], [''], null]) {
      const res = await claimTokens(KEY_A, bad);
      expect(res.status).toBe(400);
    }
  });

  it('ATOMICITY: two keys claiming the same token → exactly one owner (Issue 1A)', async () => {
    const share = await uploadParsed(HTML, '198.51.100.133');

    const [resA, resB] = await Promise.all([
      claimTokens(KEY_A, [share.editToken]),
      claimTokens(KEY_B, [share.editToken]),
    ]);
    const outcomes = [
      ((await resA.json()) as ClaimResponse).results[0]?.result,
      ((await resB.json()) as ClaimResponse).results[0]?.result,
    ];
    // The conditional UPDATE is the ownership gate: exactly one key wins. A
    // race may at worst mislabel the loser (owned-by-other vs not-found),
    // never double-own.
    expect(outcomes.filter((o) => o === 'claimed')).toHaveLength(1);

    const row = await env.DB.prepare('SELECT owner_key_hash FROM shares WHERE slug = ?')
      .bind(share.slug)
      .first<{ owner_key_hash: string }>();
    expect([await sha256Hex(KEY_A), await sha256Hex(KEY_B)]).toContain(row?.owner_key_hash);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (fake bindings injected via direct worker.fetch)
// ---------------------------------------------------------------------------

function listRequest() {
  return new Request('https://app.example.com/api/my-shares', {
    headers: { Authorization: `Bearer ${KEY_A}`, 'CF-Connecting-IP': '203.0.113.140' },
  });
}

async function fetchWithBindings(bindings: Record<string, unknown>) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    listRequest(),
    { ...env, ...bindings } as Parameters<typeof worker.fetch>[1],
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('my-shares rate limiting', () => {
  it('denying IP limiter → 429 with Retry-After', async () => {
    const res = await fetchWithBindings({
      MY_SHARES_RATE_LIMIT_IP: { limit: async () => ({ success: false }) },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  it('IP layer passes but key layer denies → 429', async () => {
    const res = await fetchWithBindings({
      MY_SHARES_RATE_LIMIT_IP: { limit: async () => ({ success: true }) },
      MY_SHARES_RATE_LIMIT_KEY: { limit: async () => ({ success: false }) },
    });
    expect(res.status).toBe(429);
  });

  it('FAIL-OPEN pinned: throwing limiter must not block the request', async () => {
    // Deliberate design (eng-review Issue 3A): the limiter is a loose filter,
    // not an auth gate. If this test starts failing, someone made it
    // fail-closed — that turns a limiter outage into a full lockout.
    const res = await fetchWithBindings({
      MY_SHARES_RATE_LIMIT_IP: {
        limit: async () => {
          throw new Error('limiter exploded');
        },
      },
    });
    expect(res.status).toBe(200);
  });

  it('FAIL-OPEN pinned: absent bindings must not block the request', async () => {
    const res = await fetchWithBindings({});
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Security invariants (T11): no sync key, key hash, or edit token hash may
// ever appear in a response payload.
// ---------------------------------------------------------------------------

describe('security invariants', () => {
  it('payloads never echo sync keys, key hashes, or edit token hashes', async () => {
    const share = await uploadParsed(HTML, '198.51.100.150', KEY_A);
    const secrets = [
      KEY_A,
      KEY_B,
      await sha256Hex(KEY_A),
      await sha256Hex(KEY_B),
      await sha256Hex(share.editToken),
    ];

    const payloads = await Promise.all(
      [
        await listShares(KEY_A),
        await claimTokens(KEY_B, [share.editToken, 'bogus']), // owned-by-other + not-found
        await dashboardFetch('/api/my-shares'), // 401 missing
        await listShares('qhsk_short'), // 401 invalid — must not echo the bad key
        await dashboardFetch(`/api/share/${share.slug}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${KEY_B}` }, // 403 not owner
        }),
      ].map((r) => r.text()),
    );

    for (const payload of payloads) {
      for (const secret of secrets) {
        expect(payload).not.toContain(secret);
      }
      expect(payload).not.toContain('qhsk_short');
    }
  });
});
