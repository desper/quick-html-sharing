import { describe, expect, it } from 'vitest';
import { mergeShareList, resolveDeleteAuth } from '../src/shares.js';
import type { StoredShare } from '../src/storage.js';

const local = (slug: string, createdAt: string, title?: string): StoredShare => ({
  slug,
  editToken: `tok-${slug}`,
  shareUrl: `https://s.qhs.fyi/${slug}`,
  editUrl: `https://s.qhs.fyi/${slug}#edit=tok-${slug}`,
  createdAt,
  ...(title ? { title } : {}),
});

const remote = (slug: string, createdAt: string) => ({
  slug,
  createdAt,
  shareUrl: `https://s.qhs.fyi/${slug}`,
});

describe('mergeShareList', () => {
  it('keeps local-only shares that the server will never return', () => {
    // The case that makes this a union rather than a replacement: a share
    // created before the user saved a sync code has owner_key_hash = NULL, so
    // /api/my-shares cannot know about it. Taking the remote list as the whole
    // truth would silently drop entries qhs_list used to show.
    const merged = mergeShareList([], [local('aaaaaaaa', '2026-08-01T00:00:00.000Z')]);
    expect(merged).toEqual([
      expect.objectContaining({ slug: 'aaaaaaaa', local: true, synced: false }),
    ]);
  });

  it('surfaces shares created on another machine', () => {
    const merged = mergeShareList([remote('bbbbbbbb', '2026-08-02T00:00:00.000Z')], []);
    expect(merged).toEqual([
      expect.objectContaining({ slug: 'bbbbbbbb', local: false, synced: true }),
    ]);
  });

  it('does not list a share twice when both sides know it', () => {
    const merged = mergeShareList(
      [remote('cccccccc', '2026-08-03T00:00:00.000Z')],
      [local('cccccccc', '2026-08-03T00:00:00.000Z', 'My demo')],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ slug: 'cccccccc', local: true, synced: true });
  });

  it('takes the title from local storage, which is the only place it exists', () => {
    // The API contract excludes titles as local-only metadata, so a share made
    // elsewhere has none. Reporting that honestly beats inventing a placeholder.
    const merged = mergeShareList(
      [remote('dddddddd', '2026-08-04T00:00:00.000Z'), remote('eeeeeeee', '2026-08-05T00:00:00Z')],
      [local('dddddddd', '2026-08-04T00:00:00.000Z', 'Titled here')],
    );
    expect(merged.find((s) => s.slug === 'dddddddd')?.title).toBe('Titled here');
    expect(merged.find((s) => s.slug === 'eeeeeeee')?.title).toBeUndefined();
  });

  it('orders newest first with a stable tie-break', () => {
    const merged = mergeShareList(
      [remote('bbbbbbbb', '2026-08-02T00:00:00.000Z'), remote('aaaaaaaa', '2026-08-02T00:00:00.000Z')],
      [local('cccccccc', '2026-08-09T00:00:00.000Z')],
    );
    // Same timestamp must not order by Map insertion, or repeated calls shuffle.
    expect(merged.map((s) => s.slug)).toEqual(['cccccccc', 'aaaaaaaa', 'bbbbbbbb']);
  });
});

describe('resolveDeleteAuth', () => {
  it('uses a local edit token without asking for confirmation', () => {
    // Callers that work today must keep working: requiring confirmation here
    // would be a breaking change buying no safety, since holding the token is
    // itself evidence the caller meant this share.
    expect(resolveDeleteAuth({ storedToken: 'tok', syncKey: 'qhsk_x' })).toEqual({
      ok: true,
      creds: { editToken: 'tok' },
      viaSyncKey: false,
    });
  });

  it('prefers an explicitly passed token over the stored one', () => {
    const auth = resolveDeleteAuth({ explicitToken: 'from-user', storedToken: 'stale' });
    expect(auth).toMatchObject({ ok: true, creds: { editToken: 'from-user' } });
  });

  it('refuses a sync-key delete until it is confirmed', () => {
    expect(resolveDeleteAuth({ syncKey: 'qhsk_x' })).toEqual({
      ok: false,
      reason: 'needs-confirmation',
    });
    // Only an explicit true opens the gate — a truthy string from a sloppy
    // caller must not count as consent.
    expect(resolveDeleteAuth({ syncKey: 'qhsk_x', confirm: 'yes' as unknown as boolean })).toEqual({
      ok: false,
      reason: 'needs-confirmation',
    });
  });

  it('allows a sync-key delete once confirmed', () => {
    expect(resolveDeleteAuth({ syncKey: 'qhsk_x', confirm: true })).toEqual({
      ok: true,
      creds: { syncKey: 'qhsk_x' },
      viaSyncKey: true,
    });
  });

  it('reports no credential rather than confirming nothing', () => {
    expect(resolveDeleteAuth({ confirm: true })).toEqual({ ok: false, reason: 'no-credential' });
    expect(resolveDeleteAuth({ syncKey: null })).toEqual({ ok: false, reason: 'no-credential' });
  });
});
