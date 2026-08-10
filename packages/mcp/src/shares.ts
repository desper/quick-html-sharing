// Pure decision logic for the share-listing and delete tools.
//
// Separate module on purpose: `index.ts` connects a stdio transport at import
// time, so anything that lives there cannot be imported by a test without
// starting a server. These two functions are where the actual judgement calls
// are, which is exactly what wants tests.

import type { MyShareItem } from './client.js';
import type { StoredShare } from './storage.js';

export interface ListedShare {
  slug: string;
  shareUrl: string;
  createdAt: string;
  title?: string;
  /** This machine holds the edit token, so edit and delete work unassisted. */
  local: boolean;
  /** Enrolled under the sync key, so other machines can reach it. */
  synced: boolean;
}

/**
 * Union of what the server knows and what this machine remembers.
 *
 * Union, not replacement. A share created before the user saved a sync code has
 * `owner_key_hash = NULL` and will never come back from `/api/my-shares`, so
 * taking the remote list as the whole truth would make this tool *lose* entries
 * it used to show. It has to be additive in both directions:
 *
 *   - remote-only  → created on another machine; listable, and (since the API
 *                    takes a sync-key bearer) deletable, but not editable here
 *   - local-only   → never enrolled; only this machine can see or change it
 *   - both         → the normal case once a sync code is set
 *
 * `title` only ever comes from local storage: the API contract deliberately
 * excludes it as local-only metadata, so a share created elsewhere shows up
 * without one. That is a real gap in the output, not a bug to paper over —
 * naming it in the rendering is more honest than inventing a placeholder.
 */
export function mergeShareList(remote: MyShareItem[], local: StoredShare[]): ListedShare[] {
  const byLocal = new Map(local.map((s) => [s.slug, s]));
  const merged = new Map<string, ListedShare>();

  for (const item of remote) {
    const mine = byLocal.get(item.slug);
    merged.set(item.slug, {
      slug: item.slug,
      shareUrl: item.shareUrl,
      createdAt: item.createdAt,
      ...(mine?.title ? { title: mine.title } : {}),
      local: mine !== undefined,
      synced: true,
    });
  }

  for (const mine of local) {
    if (merged.has(mine.slug)) continue;
    merged.set(mine.slug, {
      slug: mine.slug,
      shareUrl: mine.shareUrl,
      createdAt: mine.createdAt,
      ...(mine.title ? { title: mine.title } : {}),
      local: true,
      synced: false,
    });
  }

  // Newest first, slug as the tie-break so the output is stable across calls
  // rather than reflecting Map insertion order.
  return [...merged.values()].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.slug.localeCompare(b.slug),
  );
}

export type DeleteAuth =
  | { ok: true; creds: { editToken: string } | { syncKey: string }; viaSyncKey: boolean }
  | { ok: false; reason: 'no-credential' | 'needs-confirmation' };

/**
 * Picks the credential for a delete, and gates the one that is new.
 *
 * The server has always accepted a sync-key bearer here; this client refused
 * locally before ever asking. Wiring it up removes a piece of friction that was
 * doing real work, though — "you are holding this share's edit token" used to
 * be a de facto confirmation that the caller meant *this* share. With a sync
 * key, a slug alone deletes anything the user owns, on any machine, and an
 * agent can pick a slug out of the conversation and act on it.
 *
 * So the gate is scoped to exactly the path that lost the friction: a delete
 * backed by a local edit token behaves as it always did (adding a required
 * confirmation there would break callers that work today, for no safety gain),
 * and a delete backed only by the sync key has to say so explicitly.
 */
export function resolveDeleteAuth(opts: {
  explicitToken?: string;
  storedToken?: string;
  syncKey?: string | null;
  confirm?: boolean;
}): DeleteAuth {
  const editToken = opts.explicitToken ?? opts.storedToken;
  if (editToken) return { ok: true, creds: { editToken }, viaSyncKey: false };
  if (!opts.syncKey) return { ok: false, reason: 'no-credential' };
  if (opts.confirm !== true) return { ok: false, reason: 'needs-confirmation' };
  return { ok: true, creds: { syncKey: opts.syncKey }, viaSyncKey: true };
}
