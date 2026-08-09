import { describe, expect, it } from 'vitest';
import { htmlObjectKey, versionFromKey, versionPrefix } from '../src/lib/objectKey';

/**
 * These three functions decide where a share's bytes live and — through the
 * retention sweep — which objects get deleted. A parser that guesses wrong here
 * does not throw; it quietly removes someone's content. That makes the reject
 * cases the important half of this file.
 */

describe('htmlObjectKey', () => {
  it('keeps v1 at the pre-versioning flat key so nothing needs migrating', () => {
    expect(htmlObjectKey('abc123', 1)).toBe('shares/abc123.html');
  });

  it('puts v2+ under the share prefix', () => {
    expect(htmlObjectKey('abc123', 2)).toBe('shares/abc123/v2.html');
    expect(htmlObjectKey('abc123', 47)).toBe('shares/abc123/v47.html');
  });

  it('treats a non-positive version as the flat key rather than inventing one', () => {
    // Unreachable through the API, but a v0/-1 key would be an object no
    // enumerator looks for — an orphan by construction.
    expect(htmlObjectKey('abc123', 0)).toBe('shares/abc123.html');
    expect(htmlObjectKey('abc123', -3)).toBe('shares/abc123.html');
  });
});

describe('versionPrefix', () => {
  it('does not cover v1 — the one thing every caller has to remember', () => {
    const prefix = versionPrefix('abc123');
    expect(prefix).toBe('shares/abc123/');
    expect(htmlObjectKey('abc123', 1).startsWith(prefix)).toBe(false);
    expect(htmlObjectKey('abc123', 2).startsWith(prefix)).toBe(true);
  });

  it('does not match a share whose slug merely starts the same', () => {
    // list({prefix}) is a string match, so a missing separator here would let
    // one share's sweep delete another share's objects.
    expect(htmlObjectKey('abc1234', 2).startsWith(versionPrefix('abc123'))).toBe(false);
  });
});

describe('versionFromKey', () => {
  it('round-trips every key htmlObjectKey produces for v2+', () => {
    for (const version of [2, 3, 10, 999]) {
      expect(versionFromKey(htmlObjectKey('abc123', version))).toBe(version);
    }
  });

  it('rejects the flat v1 key — it is not under the prefix and is never swept by number', () => {
    expect(versionFromKey('shares/abc123.html')).toBeNull();
  });

  it('rejects v0 and v1 inside the prefix', () => {
    expect(versionFromKey('shares/abc123/v0.html')).toBeNull();
    expect(versionFromKey('shares/abc123/v1.html')).toBeNull();
  });

  it('rejects leading zeros instead of aliasing them onto a real version', () => {
    // v007.html is a key this module never writes. Reading it as 7 would let
    // the sweep delete it as if it were the real v7.
    expect(versionFromKey('shares/abc123/v007.html')).toBeNull();
    expect(versionFromKey('shares/abc123/v02.html')).toBeNull();
  });

  it('rejects a number too large to be exact', () => {
    // parseInt happily returns 1e20 here. Comparing that against
    // latest_version would misclassify the object in either direction.
    expect(versionFromKey('shares/abc123/v99999999999999999999.html')).toBeNull();
  });

  it('rejects anything that is not v{n}.html', () => {
    for (const key of [
      'shares/abc123/notes.txt',
      'shares/abc123/v.html',
      'shares/abc123/vX.html',
      'shares/abc123/v2.htm',
      'shares/abc123/v2.html.bak',
      'shares/abc123/v2',
      'shares/abc123/sub/v2.html.old',
      '',
    ]) {
      expect(versionFromKey(key)).toBeNull();
    }
  });
});
