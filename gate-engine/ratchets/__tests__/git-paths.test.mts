import { describe, expect, it } from 'vitest';
import { readGitPaths } from '../git-paths.mts';

const nul = (...names: string[]) => Buffer.from(names.map((n) => `${n}\0`).join(''));

describe('readGitPaths', () => {
  it.each([
    ['tab', 'a\tb.ts'],
    ['newline', 'a\nb.ts'],
    ['leading and trailing space', ' lead.ts '],
    ['non-ASCII', 'café.ts'],
    ['leading U+FEFF', '﻿bom.ts'],
    ['U+2028', 'line sep.ts'],
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
