import { describe, expect, it } from 'vitest';
import { identityBytesByPath, packDiffIntoChunks, unquoteGitPath } from '../lens/chunk.mts';

function segment(path: string, lines: number): string {
  const head = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${lines} @@\n`;
  return (
    head + Array.from({ length: lines }, (_, i) => `+const v${i} = '${'x'.repeat(30)}';\n`).join('')
  );
}

describe('identityBytesByPath', () => {
  it('maps each file to the byte size of its normalized diff identity', () => {
    const diff = segment('src/a.ts', 10) + segment('src/b.ts', 40);
    const bytes = identityBytesByPath(diff);
    expect([...bytes.keys()].sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(bytes.get('src/b.ts')!).toBeGreaterThan(bytes.get('src/a.ts')!);
  });
});

describe('packDiffIntoChunks', () => {
  it('packs whole files next-fit in sorted path order, never splitting a file', () => {
    const files = ['src/c.ts', 'src/a.ts', 'src/b.ts'];
    const diff = segment('src/a.ts', 30) + segment('src/b.ts', 30) + segment('src/c.ts', 30);
    const per = identityBytesByPath(diff).get('src/a.ts')!;
    const { chunks } = packDiffIntoChunks(files, diff, per * 2 + 10);
    expect(chunks).toEqual([['src/a.ts', 'src/b.ts'], ['src/c.ts']]);
  });

  it('never revisits a closed chunk (next-fit, not first-fit)', () => {
    // src/a.ts (big) closes chunk 1 with leftover room; src/b.ts (bigger) doesn't fit alongside
    // it and opens chunk 2; src/c.ts is small enough that it WOULD fit chunk 1's leftover room
    // under first-fit. Next-fit never revisits chunk 1, so src/c.ts must land in chunk 2 instead.
    const diff = segment('src/a.ts', 40) + segment('src/b.ts', 80) + segment('src/c.ts', 5);
    const bytes = identityBytesByPath(diff);
    const a = bytes.get('src/a.ts')!;
    const b = bytes.get('src/b.ts')!;
    const c = bytes.get('src/c.ts')!;
    const cap = a + b - 1;
    // Sanity-check the fixture actually distinguishes the two policies before pinning the result.
    expect(cap - a).toBeGreaterThan(c);
    const { chunks } = packDiffIntoChunks(['src/a.ts', 'src/b.ts', 'src/c.ts'], diff, cap);
    expect(chunks).toEqual([['src/a.ts'], ['src/b.ts', 'src/c.ts']]);
  });

  it('gives an over-cap file its own chunk instead of splitting it', () => {
    const diff = segment('src/big.ts', 200) + segment('src/small.ts', 5);
    const { chunks } = packDiffIntoChunks(['src/big.ts', 'src/small.ts'], diff, 1_000);
    expect(chunks[0]).toEqual(['src/big.ts']);
    expect(chunks[1]).toEqual(['src/small.ts']);
  });

  it('is deterministic for the same inputs (checkpoint keys depend on it)', () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/m${String(i).padStart(2, '0')}.ts`);
    const diff = files.map((f) => segment(f, 20)).join('');
    const a = packDiffIntoChunks(files, diff, 3_000).chunks;
    const b = packDiffIntoChunks([...files].reverse(), diff, 3_000).chunks;
    expect(a).toEqual(b);
  });

  it('keeps every file exactly once across chunks', () => {
    const files = Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`);
    const diff = files.map((f, i) => segment(f, 10 + i * 7)).join('');
    const { chunks } = packDiffIntoChunks(files, diff, 2_500);
    expect(chunks.flat().sort()).toEqual([...files].sort());
  });
});

describe('identityByPath rename handling', () => {
  it('keys a renamed file under its post-image path', () => {
    const diff = [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 90%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
      'index 1111111..2222222 100644',
      '--- a/src/old-name.ts',
      '+++ b/src/new-name.ts',
      '@@ -1,2 +1,2 @@',
      '-const a = 1;',
      '+const a = 2;',
      '',
    ].join('\n');
    const bytes = identityBytesByPath(diff);
    expect(bytes.has('src/new-name.ts')).toBe(true);
    expect(bytes.has('src/old-name.ts')).toBe(false);
    expect(bytes.get('src/new-name.ts')).toBeGreaterThan(0);
    const plan = packDiffIntoChunks(['src/new-name.ts'], diff, 40_000);
    expect(plan.bytesByPath.get('src/new-name.ts')).toBeGreaterThan(0);
  });
});

describe('identityByPath quoted-path handling', () => {
  it('unquotes a C-quoted git path (tab in filename) so it lines up with the staged name', () => {
    // Real `git diff --cached` C-quotes a path containing a tab, backslash, or non-ASCII byte,
    // e.g. `+++ "b/src/new\tb.ts"` — the literal two-character `\t` escape, not a real tab.
    const diff = [
      'diff --git "a/src/new\\tb.ts" "b/src/new\\tb.ts"',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ "b/src/new\\tb.ts"',
      '@@ -0,0 +1,2 @@',
      '+const a = 1;',
      '+const b = 2;',
      '',
    ].join('\n');
    const staged = 'src/new\tb.ts'; // decoded: a real tab, as `git diff --cached --name-only -z` gives it
    const bytes = identityBytesByPath(diff);
    expect([...bytes.keys()]).toEqual([staged]);
    expect(bytes.get(staged)).toBeGreaterThan(0);

    // `git diff --cached --name-only` (no -z) quotes the same way, so packDiffIntoChunks' callers
    // supply the SAME C-quoted string as a staged name — it must still resolve to identity bytes.
    const stagedRawFromGit = '"src/new\\tb.ts"';
    const plan = packDiffIntoChunks([stagedRawFromGit], diff, 40_000);
    expect(plan.chunks).toEqual([[stagedRawFromGit]]);
    expect(plan.bytesByPath.get(staged)).toBeGreaterThan(0);
  });

  it('strips the synthetic a/ prefix (not b/) for a quoted DELETED path', () => {
    // A deletion has `+++ /dev/null`, so filePathOf falls back to the pre-image `diff --git
    // a/… b/…` header — quoting bakes the synthetic 'a/' (not 'b/') inside the captured token.
    const diff = [
      'diff --git "a/weird\\tname.ts" "b/weird\\tname.ts"',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- "a/weird\\tname.ts"',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-const a = 1;',
      '-const b = 2;',
      '',
    ].join('\n');
    const staged = 'weird\tname.ts';
    const bytes = identityBytesByPath(diff);
    expect([...bytes.keys()]).toEqual([staged]);
    expect(bytes.get(staged)).toBeGreaterThan(0);
  });
});

describe('unquoteGitPath escape table', () => {
  it('decodes every git C-quote single-char escape (quote.c cq_lookup), not just the common ones', () => {
    expect(unquoteGitPath('"a\\ab\\bc\\fd\\ve\\tf\\ng\\rh\\"i\\\\j"')).toBe(
      'a\x07b\x08c\x0cd\x0be\tf\ng\rh"i\\j',
    );
  });
});

describe('paths containing literal spaces', () => {
  it('an unquoted spaced path (git never quotes plain spaces) keys its full identity', () => {
    const diff = [
      'diff --git a/src/has space.ts b/src/has space.ts',
      'index 1111111..2222222 100644',
      '--- a/src/has space.ts',
      '+++ b/src/has space.ts',
      '@@ -1,1 +1,1 @@',
      '-const a = 1;',
      '+const a = 2;',
      '',
    ].join('\n');
    const bytes = identityBytesByPath(diff);
    expect(bytes.get('src/has space.ts')).toBeGreaterThan(0);
  });

  it('a binary/mode-only segment whose name contains literal " b/" keys the true path', () => {
    // No '+++' line, so resolution falls back to the `diff --git a/<p> b/<p>` header. A first-
    // `indexOf(' b/')` split lands INSIDE the a-path for this name; the matching-halves rule
    // must recover the real post-image path instead of a wrong (0-byte-packing) key.
    const spaced = 'assets/a b/x.png';
    const diff = [
      `diff --git a/${spaced} b/${spaced}`,
      'old mode 100644',
      'new mode 100755',
      '',
    ].join('\n');
    const bytes = identityBytesByPath(diff);
    expect([...bytes.keys()]).toEqual([spaced]);
  });

  it('a QUOTED path with a space and an escape decodes to the staged name', () => {
    const diff = [
      'diff --git "a/src/sp ace\\ttab.ts" "b/src/sp ace\\ttab.ts"',
      'index 1111111..2222222 100644',
      '--- "a/src/sp ace\\ttab.ts"',
      '+++ "b/src/sp ace\\ttab.ts"',
      '@@ -1,1 +1,1 @@',
      '-const a = 1;',
      '+const a = 2;',
      '',
    ].join('\n');
    const bytes = identityBytesByPath(diff);
    expect(bytes.get('src/sp ace\ttab.ts')).toBeGreaterThan(0);
  });
});
