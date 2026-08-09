import { describe, expect, it } from 'vitest';
import { normalizeReferrer, referrerSource } from '../src/lib/referrer';

/**
 * These two functions are the write half and the read half of one format, and
 * production proved that testing each against its own idea of the format is not
 * enough: `normalizeReferrer` stored a bare hostname, `referrerSource` fed it
 * back to a URL parser that requires a scheme, and every real referrer was
 * reported as 'other'. So the contract pinned here is the *round trip*.
 */
describe('normalizeReferrer (write path)', () => {
  it('reduces a URL to its hostname, dropping www, path and query', () => {
    expect(normalizeReferrer('https://www.google.com/search?q=secret')).toBe('google.com');
    expect(normalizeReferrer('https://news.ycombinator.com/item?id=1')).toBe(
      'news.ycombinator.com',
    );
    expect(normalizeReferrer('http://localhost:3000/preview')).toBe('localhost');
  });

  it('stores null for a missing header and the literal other for junk', () => {
    expect(normalizeReferrer(undefined)).toBeNull();
    expect(normalizeReferrer(null)).toBeNull();
    expect(normalizeReferrer('')).toBeNull();
    expect(normalizeReferrer('not a url at all')).toBe('other');
  });

  it('clamps to the maximum hostname length', () => {
    const long = `${'a'.repeat(300)}.example`;
    expect(normalizeReferrer(`https://${long}/`)?.length).toBe(253);
  });
});

describe('referrerSource (read path)', () => {
  it('passes through what the write path stored', () => {
    // The regression. `new URL('news.ycombinator.com')` throws for want of a
    // scheme; routing this through the URL parser labelled it 'other'.
    for (const host of ['news.ycombinator.com', 'reddit.com', 'localhost', 'a.b.c.example']) {
      expect(referrerSource(host)).toBe(host);
    }
    expect(referrerSource('other')).toBe('other');
    expect(referrerSource(null)).toBe('direct');
  });

  it('still normalizes the full URLs written before the write path did', () => {
    expect(referrerSource('https://www.google.com/search?q=secret')).toBe('google.com');
    expect(referrerSource('not a url at all')).toBe('other');
  });

  it('round-trips every write-path output unchanged', () => {
    for (const raw of [
      'https://www.reddit.com/r/webdev/',
      'http://localhost:3000/preview',
      'not a url at all',
      '',
    ]) {
      const stored = normalizeReferrer(raw);
      const label = referrerSource(stored);
      // Stored NULL is the one value that changes shape, into 'direct'.
      expect(label).toBe(stored ?? 'direct');
    }
  });
});
