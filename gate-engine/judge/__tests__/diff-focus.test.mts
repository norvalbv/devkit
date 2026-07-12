// Unit tests for the shared diff-evidence primitives (split + hunk focus) used by the sentry, detect,
// and reviewer judge gates.

import { describe, expect, it } from 'vitest';
import { filePathOf, focusHunks, splitDiffByFile } from '../diff-focus.mts';

const git = (path: string, hunk: string) =>
  `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,3 @@\n${hunk}`;

describe('splitDiffByFile', () => {
  it('splits a real `git diff` into one segment per file (preamble stays with its own file)', () => {
    const diff = `${git('src/a.ts', '+  a();')}\n${git('src/b.ts', '+  b();')}`;
    const segs = splitDiffByFile(diff);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toContain('a/src/a.ts');
    expect(segs[0]).not.toContain('src/b.ts'); // the 2nd file's preamble did NOT leak into the 1st
    expect(segs[1]).toContain('a/src/b.ts');
  });

  it('splits a preamble-free (fixture) diff on the old-file `--- ` boundary', () => {
    const diff = '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n+x\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n+y';
    const segs = splitDiffByFile(diff);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toContain('x.ts');
    expect(segs[1]).toContain('y.ts');
  });

  it('empty → []', () => {
    expect(splitDiffByFile('')).toEqual([]);
    expect(splitDiffByFile('   \n ')).toEqual([]);
  });
});

describe('filePathOf', () => {
  it.each([
    [git('src/a.ts', '+x'), 'src/a.ts'], // via +++ b/
    ['diff --git a/only.ts b/only.ts\nnew file mode 100644', 'only.ts'], // via diff --git (no +++)
    ['--- a/z.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone', null], // deletion → /dev/null → null
  ])('path of a segment', (seg, expected) => {
    expect(filePathOf(seg)).toBe(expected);
  });
});

describe('focusHunks', () => {
  const rel = (h: string) => /\bcatch\b|capture/.test(h);

  it('keeps a relevant hunk, drops an irrelevant one to header + omission', () => {
    const kept = focusHunks(git('src/a.ts', '+  catch (e) {}'), rel);
    expect(kept).toContain('catch');
    const dropped = focusHunks(git('src/ui.tsx', '+  <span className="x" />'), rel);
    expect(dropped).not.toContain('className');
    expect(dropped).toContain('CHANGED FILES: src/ui.tsx');
    expect(dropped).toContain('omitted');
  });

  it('never leaks a next-file preamble into a prior hunk (the diff --git split)', () => {
    // file 1 is a plain UI change; file 2 is `catch-utils.ts`. The 2nd file's `diff --git` preamble
    // must not attach to file 1's hunk and match the predicate via the "catch" in the path.
    const diff = `${git('src/ui.tsx', '+  <span className="x" />')}\n${git('src/lib/catch-utils.ts', '+  const n = 1;')}`;
    const out = focusHunks(diff, rel);
    expect(out).not.toContain('className');
    expect(out).not.toContain('const n = 1');
    expect(out).toContain('src/lib/catch-utils.ts'); // listed in the header, hunk not kept
  });

  it('omitNoun labels the omission line', () => {
    expect(focusHunks(git('src/a.ts', '+  noop();'), rel, 'non-error')).toContain(
      'non-error hunk(s) omitted',
    );
  });
});
