import { SLUG_ALPHABET, SLUG_LENGTH } from '@qhs/shared';

/**
 * Generates a cryptographically random slug.
 *
 * Uses crypto.getRandomValues + rejection sampling to avoid alphabet bias.
 * 12 chars from a 36-char alphabet → log2(36^12) ≈ 62 bits of entropy.
 */
export function generateSlug(length = SLUG_LENGTH): string {
  const alphabet = SLUG_ALPHABET;
  const alphabetSize = alphabet.length;
  const out: string[] = [];
  // Largest unbiased threshold: highest multiple of alphabetSize <= 256.
  const threshold = 256 - (256 % alphabetSize);
  // Pull more bytes than needed to amortize the loop.
  while (out.length < length) {
    const buf = new Uint8Array(length * 2);
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte >= threshold) continue; // bias-prone, reject
      out.push(alphabet[byte % alphabetSize] as string);
      if (out.length === length) break;
    }
  }
  return out.join('');
}
