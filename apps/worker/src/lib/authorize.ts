import type { ShareRow } from '@qhs/shared';
import { sha256Hex } from './hash';
import { timingSafeEqual } from './tokens';

/**
 * Ownership check for the operations that act on a share as a whole: delete,
 * list versions, read an old version, restore.
 *
 * Two credentials, MUTUALLY EXCLUSIVE, no cross fallback (eng-review Issue
 * 6A). Every 403 points at exactly one credential:
 *
 *   Authorization: Bearer qhsk_...  → owner-key path. The key must own the
 *                                     share or it is a 403; an editToken in
 *                                     the body is deliberately ignored, so a
 *                                     wrong key can never be rescued by a
 *                                     right token.
 *   no header + body { editToken }  → edit-token path.
 *   neither                         → 400.
 *
 * Lives here rather than inline because four call sites need the identical
 * decision. Three copies of an authorization rule is three places to forget a
 * fix; `security.test.ts` covers this matrix and is the regression net.
 *
 * Note this is ownership, NOT the right to supply new content. Editing still
 * requires the edit token (design-review D19): restoring points at bytes the
 * server already holds, which is a different risk model from uploading new
 * bytes from a device that never had the token.
 */
export type AuthorizationResult =
  | { ok: true }
  | { ok: false; status: 400 | 403; error: string; message: string };

export async function authorizeShareOwnership(
  ownerKeyHash: string | undefined,
  editToken: unknown,
  row: Pick<ShareRow, 'edit_token_hash' | 'owner_key_hash'>,
): Promise<AuthorizationResult> {
  if (!ownerKeyHash && typeof editToken !== 'string') {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message: 'Provide a sync key bearer or an editToken.',
    };
  }

  if (ownerKeyHash) {
    // An unclaimed share also 403s on this path: claim it first, or use its
    // edit token with no bearer header.
    if (!row.owner_key_hash || !timingSafeEqual(ownerKeyHash, row.owner_key_hash)) {
      return {
        ok: false,
        status: 403,
        error: 'forbidden',
        message: 'Sync key does not own this share.',
      };
    }
    return { ok: true };
  }

  const incomingHash = await sha256Hex(editToken as string);
  if (!timingSafeEqual(incomingHash, row.edit_token_hash)) {
    return { ok: false, status: 403, error: 'forbidden', message: 'Bad edit token.' };
  }
  return { ok: true };
}
