// Unit tests for the shared diff-evidence primitives (split + hunk focus) used by the sentry, detect,
// and reviewer judge gates.

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffCacheIdentity, filePathOf, focusHunks, splitDiffByFile } from '../diff-focus.mts';

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

describe('diffCacheIdentity', () => {
  // Real-git harness: the geometry claims (hunk extension, new hunks, merges, header shifts) are
  // asserted against diffs GIT actually produces, not hand-authored approximations.
  const gitDiffOf = (base: string, staged: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'dci-'));
    try {
      execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir });
      writeFileSync(join(dir, 'app.ts'), base);
      execSync('git add . && git commit -qm base', { cwd: dir });
      writeFileSync(join(dir, 'app.ts'), staged);
      execSync('git add .', { cwd: dir });
      return execSync('git -c diff.noprefix=false diff --cached', { cwd: dir, encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const BASE = Array.from({ length: 40 }, (_, i) => `line${i}();`).join('\n');
  const edit = (at: number, insert: string[], from = BASE) => {
    const lines = from.split('\n');
    lines.splice(at, 0, ...insert);
    return lines.join('\n');
  };

  it.each([
    ['inside the touched hunk', 11],
    ['far away (its own new hunk + fresh context)', 30],
    ['adjacent (hunks merge)', 14],
  ])('stable when a capture lands %s', (_label, at) => {
    const fixed = edit(10, ['handle();']); // the "real" change, committed intent
    const d1 = gitDiffOf(BASE, fixed);
    const d2 = gitDiffOf(BASE, edit(at, ['Sentry.captureException(e);'], fixed));
    expect(d2).not.toBe(d1); // git really did reshape the diff…
    expect(diffCacheIdentity(d2)).toBe(diffCacheIdentity(d1)); // …but the identity held
  });

  it('strips a wrapper-name import when the path itself names sentry', () => {
    const fixed = edit(10, ['handle();']);
    const d1 = gitDiffOf(BASE, fixed);
    const d2 = gitDiffOf(
      BASE,
      edit(0, ["import { captureMainMessage } from './lib/sentry';"], fixed),
    );
    expect(diffCacheIdentity(d2)).toBe(diffCacheIdentity(d1));
  });

  it('stable across awaited captures, imports, and several at once', () => {
    const fixed = edit(10, ['handle();']);
    const d1 = gitDiffOf(BASE, fixed);
    const d2 = gitDiffOf(
      BASE,
      edit(
        30,
        ['await Sentry.captureException(err);', 'Sentry.captureMessage("x");'],
        edit(0, ["import * as Sentry from '@sentry/electron';"], fixed),
      ),
    );
    expect(diffCacheIdentity(d2)).toBe(diffCacheIdentity(d1));
  });

  it('drops a whole file segment that only gained sentry lines', () => {
    const twoFile = (extra: string | null): string => {
      const dir = mkdtempSync(join(tmpdir(), 'dci-'));
      try {
        execSync('git init -q && git config user.email t@t && git config user.name t', {
          cwd: dir,
        });
        writeFileSync(join(dir, 'app.ts'), BASE);
        writeFileSync(join(dir, 'other.ts'), BASE);
        execSync('git add . && git commit -qm base', { cwd: dir });
        writeFileSync(join(dir, 'app.ts'), edit(10, ['handle();']));
        if (extra !== null) writeFileSync(join(dir, 'other.ts'), edit(20, [extra]));
        execSync('git add .', { cwd: dir });
        return execSync('git -c diff.noprefix=false diff --cached', { cwd: dir, encoding: 'utf8' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(diffCacheIdentity(twoFile('Sentry.captureMessage("degraded");'))).toBe(
      diffCacheIdentity(twoFile(null)),
    );
  });

  it.each([
    ['a real line rides along', ['Sentry.captureException(e);', 'refund(user);']],
    ['multi-line payload capture (opening line only)', ['Sentry.captureException(e, {']],
  ])('invalidates when %s', (_label, insert) => {
    const fixed = edit(10, ['handle();']);
    const d1 = gitDiffOf(BASE, fixed);
    const d2 = gitDiffOf(BASE, edit(30, insert, fixed));
    expect(diffCacheIdentity(d2)).not.toBe(diffCacheIdentity(d1));
  });

  it('two unrelated capture-ONLY commits never collide on an empty identity', () => {
    const a = gitDiffOf(BASE, edit(10, ['Sentry.captureException(err);']));
    const b = gitDiffOf(BASE, edit(25, ['Sentry.captureMessage("degraded");']));
    expect(diffCacheIdentity(a)).not.toBe('');
    expect(diffCacheIdentity(a)).not.toBe(diffCacheIdentity(b)); // exact-bytes degradation
  });

  it('invalidates when a capture is REMOVED (deletions are never stripped)', () => {
    const withCapture = edit(10, ['Sentry.captureException(e);']);
    const d = gitDiffOf(withCapture, BASE);
    expect(diffCacheIdentity(d)).not.toBe('');
    expect(diffCacheIdentity(d)).toContain('-Sentry.captureException(e);');
  });

  it('distinguishes two genuinely different diffs and ignores blob-sha churn', () => {
    const a = gitDiffOf(BASE, edit(10, ['alpha();']));
    const b = gitDiffOf(BASE, edit(10, ['beta();']));
    expect(diffCacheIdentity(a)).not.toBe(diffCacheIdentity(b));
    expect(diffCacheIdentity(a)).not.toContain('index '); // sha lines out of the identity
  });

  it('fixpoint: hunk-less input passes through VERBATIM instead of vanishing', () => {
    expect(diffCacheIdentity('not a diff at all')).toBe('not a diff at all');
    const modeOnly = 'diff --git a/x.sh b/x.sh\nold mode 100644\nnew mode 100755';
    expect(diffCacheIdentity(modeOnly)).toBe(modeOnly);
  });

  it('binary segments keep their index shas — different blobs must not collide', () => {
    const bin = (shas: string) =>
      `diff --git a/blob.bin b/blob.bin\nindex ${shas} 100644\nBinary files a/blob.bin and b/blob.bin differ`;
    expect(diffCacheIdentity(bin('1111111..2222222'))).not.toBe(
      diffCacheIdentity(bin('1111111..3333333')),
    );
  });
});

// The three holes the correctness reviewer proved in the first shipped draft (opus-confirmed):
// bare foreign capture names, nested-call arguments, and position-blind relocation.
describe('diffCacheIdentity — conservative matching + function anchors', () => {
  const gitDiffOf = (base: string, staged: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'dci2-'));
    try {
      execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir });
      writeFileSync(join(dir, 'app.ts'), base);
      execSync('git add . && git commit -qm base', { cwd: dir });
      writeFileSync(join(dir, 'app.ts'), staged);
      execSync('git add .', { cwd: dir });
      return execSync('git -c diff.noprefix=false diff --cached', { cwd: dir, encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const BASE = Array.from({ length: 40 }, (_, i) => `line${i}();`).join('\n');
  const edit = (at: number, insert: string[], from = BASE) => {
    const lines = from.split('\n');
    lines.splice(at, 0, ...insert);
    return lines.join('\n');
  };

  it.each([
    ['a BARE capture from an arbitrary module', 'captureException(userInput);'],
    ['a BARE wrapper call (no origin check possible)', 'captureMainMessage(chatId, text);'],
    [
      'a capture-name import from a path merely CONTAINING "sentry"',
      "import { captureException } from '../utils/presentry-shim';",
    ],
    ['a nested call smuggled as the argument', 'Sentry.captureException(mutateGlobalState(err));'],
    ['a template-literal argument', 'Sentry.captureMessage(`${sideEffect()}`);'],
  ])('does NOT strip %s — the restage re-reviews', (_label, line) => {
    const fixed = edit(10, ['handle();']);
    const d1 = gitDiffOf(BASE, fixed);
    const d2 = gitDiffOf(BASE, edit(30, [line], fixed));
    expect(diffCacheIdentity(d2)).not.toBe(diffCacheIdentity(d1));
  });

  it('relocating the same added line into a DIFFERENT function voids the key (anchors)', () => {
    const fn = (name: string) =>
      [
        `function ${name}() {`,
        ...Array.from({ length: 10 }, (_, i) => `  ${name}${i}();`),
        '}',
      ].join('\n');
    const twoFns = `${fn('alpha')}\n${fn('beta')}`;
    const insertAt = (line: number) => {
      const lines = twoFns.split('\n');
      lines.splice(line, 0, '  probe();');
      return lines.join('\n');
    };
    const inAlpha = gitDiffOf(twoFns, insertAt(6));
    const inBeta = gitDiffOf(twoFns, insertAt(18));
    expect(diffCacheIdentity(inAlpha)).not.toBe(diffCacheIdentity(inBeta));
    expect(diffCacheIdentity(inAlpha)).toContain('@ function alpha');
    expect(diffCacheIdentity(inBeta)).toContain('@ function beta');
  });

  it('two same-function hunks merging via a capture insertion still hit (anchor dedupe)', () => {
    const fixed = edit(14, ['later();'], edit(10, ['handle();']));
    const d1 = gitDiffOf(BASE, fixed);
    const merged = gitDiffOf(BASE, edit(12, ['Sentry.captureException(e);'], fixed));
    expect(diffCacheIdentity(merged)).toBe(diffCacheIdentity(d1));
  });
});

// Anchorless file types (git emits no function context for JSON): the completeness gate proved a
// whole-file relocation collision — the old-side start-line fallback anchor closes it.
describe('diffCacheIdentity — anchorless files fall back to old-side position anchors', () => {
  const gitDiffOf = (name: string, base: string, staged: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'dci3-'));
    try {
      execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir });
      writeFileSync(join(dir, name), base);
      execSync('git add . && git commit -qm base', { cwd: dir });
      writeFileSync(join(dir, name), staged);
      execSync('git add .', { cwd: dir });
      return execSync('git -c diff.noprefix=false diff --cached', { cwd: dir, encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const arr = (name: string, items: string[]) =>
    `  "${name}": [\n${items.map((i) => `    "${i}",`).join('\n')}\n  ]`;
  const json = (trusted: string[], pub: string[]) =>
    `{\n${arr('trustedOrigins', trusted)},\n${arr('publicOrigins', pub)}\n}\n`;
  const BASE = json(
    ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com', 'e.example.com'],
    ['f.example.com', 'g.example.com', 'h.example.com', 'i.example.com', 'j.example.com'],
  );

  it('the same added line in two different JSON blocks yields two different identities', () => {
    const inTrusted = gitDiffOf(
      'origins.json',
      BASE,
      json(
        [
          'a.example.com',
          'b.example.com',
          'evil.example.com',
          'c.example.com',
          'd.example.com',
          'e.example.com',
        ],
        ['f.example.com', 'g.example.com', 'h.example.com', 'i.example.com', 'j.example.com'],
      ),
    );
    const inPublic = gitDiffOf(
      'origins.json',
      BASE,
      json(
        ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com', 'e.example.com'],
        [
          'f.example.com',
          'g.example.com',
          'evil.example.com',
          'h.example.com',
          'i.example.com',
          'j.example.com',
        ],
      ),
    );
    expect(diffCacheIdentity(inTrusted)).not.toBe(diffCacheIdentity(inPublic));
    expect(diffCacheIdentity(inTrusted)).toMatch(/@ :\d+/); // positional fallback anchor in play
  });
});
