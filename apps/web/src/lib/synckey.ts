/**
 * Sync key ("sync code") storage + minting, kept in LocalStorage.
 *
 * The sync key is the ONLY credential for the My Shares registry. It is minted
 * client-side (the server keeps no registry — it stores sha256(key) the first
 * time a share is claimed) and is transported ONLY via `Authorization: Bearer`,
 * never in a URL (see lib/api.ts). Losing it means losing the ability to
 * re-attach the server-side list on a new device — but a share's edit token
 * (in qhs.recent.v1) is a separate, independent credential.
 *
 * Storage contract (design D10): the key is written to localStorage the moment
 * the user presses Create — "show once" is a false promise (refresh would drop
 * an unsaved key and every subsequent request needs it to sign). Re-reveal is
 * the safety net, not single-display.
 */

import { SYNC_KEY_BYTES, SYNC_KEY_PREFIX, SYNC_KEY_REGEX } from '@qhs/shared';

const KEY = 'qhs.synckey.v1';

/** base64url (no padding) of raw bytes — matches the worker's key alphabet. */
function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * Mint a fresh sync key: `qhsk_` + base64url(32 random bytes) = 43 code chars,
 * matching SYNC_KEY_REGEX. Uses the platform CSPRNG.
 */
export function generateSyncKey(): string {
  const bytes = new Uint8Array(SYNC_KEY_BYTES);
  crypto.getRandomValues(bytes);
  return SYNC_KEY_PREFIX + toBase64Url(bytes);
}

/** Client-side format gate (D7): stop typo'd codes before they hit the server. */
export function isValidSyncKey(s: string): boolean {
  return SYNC_KEY_REGEX.test(s.trim());
}

export function loadSyncKey(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const v = localStorage.getItem(KEY);
  return v && isValidSyncKey(v) ? v : null;
}

export function saveSyncKey(key: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(KEY, key);
}

export function clearSyncKey(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(KEY);
}
