import { describe, expect, it } from 'vitest';
import { readGitPaths, splitGitPaths } from '../git-paths.mts';

const nul = (...names: string[]) => Buffer.from(names.map((n) => `${n}\0`).join(''));

describe('readGitPaths', () => {
  it.each([
    ['tab', 'a\tb.ts'],
    ['newline', 'a\nb.ts'],
    ['leading and trailing space', ' lead.ts '],
    ['non-ASCII', 'café.ts'],
    ['leading U+FEFF', '﻿bom.ts'],
    ['U+2028', 'line sep.ts'],
    // A valid name may legitimately hold U+FFFD; only undecodable BYTES are counted.
    ['literal U+FFFD', '\uFFFDreplaced.ts'],
  ])('returns a %s name verbatim', (_label, name) => {
    expect(readGitPaths(nul('first.ts', name))).toEqual(['first.ts', name]);
  });

  it('returns null for a name that is not valid UTF-8', () => {
    expect(
      readGitPaths(Buffer.concat([nul('ok.ts'), Buffer.from([0xff, 0x2e, 0x74, 0x73, 0])])),
    ).toBeNull();
  });

  it('returns an empty list for empty output', () => {
    expect(readGitPaths(Buffer.alloc(0))).toEqual([]);
  });
});

describe('splitGitPaths', () => {
  it('keeps every valid name verbatim and counts the invalid ones', () => {
    const bad = Buffer.from([0xff, 0x2e, 0x74, 0x73, 0]);
    expect(splitGitPaths(Buffer.concat([nul('ok.ts'), bad, nul('\uFEFFbom.ts')]))).toEqual({
      paths: ['ok.ts', '\uFEFFbom.ts'],
      undecodable: 1,
    });
  });

  it('reads only its own view of a pooled buffer', () => {
    const pooled = nul('before.ts', 'mine.ts', 'after.ts');
    const view = pooled.subarray('before.ts\0'.length, pooled.length - 'after.ts\0'.length);
    expect(splitGitPaths(view)).toEqual({ paths: ['mine.ts'], undecodable: 0 });
  });

  it('returns nothing for empty output', () => {
    expect(splitGitPaths(Buffer.alloc(0))).toEqual({ paths: [], undecodable: 0 });
  });
});
