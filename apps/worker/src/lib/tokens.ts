import { EDIT_TOKEN_BYTES } from '@qhs/shared';

/** Generates a base64url edit token (random, ~22 chars for 16 bytes). */
export function generateEditToken(byteLength = EDIT_TOKEN_BYTES): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Constant-time string compare. Lengths must match.
 * Used when comparing user-supplied edit token hash to stored hash.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
