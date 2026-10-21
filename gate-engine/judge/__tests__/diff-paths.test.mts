import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitCached } from '../../review/evidence/staged-git.mts';
import { chunkDiffText, identityByPath } from '../../review/lens/chunk.mts';
import { diffPathsOf, filePathOf, selectHunks, splitDiffByFile } from '../diff-focus.mts';

// Every header below is REAL `git diff --cached -M -C` output: hand-authored fixtures hid git's
// trailing TAB after a spaced name, which is how a spaced file once packed as an empty chunk.
let root = '';
const git = (args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const body = (tag: string) =>
  Array.from({ length: 12 }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';
const write = (name: string, text: string) => {
  mkdirSync(join(root, name, '..'), { recursive: true });
  writeFileSync(join(root, name), text);
};
const NEW_NAMES = [
  'new file.ts',
  'quo"te.ts',
  'back\\slash.ts',
  'tab\tname.ts',
  'new\nline.ts',
  'über.ts',
];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'diff-paths-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'devkit@example.test']);
  git(['config', 'user.name', 'Devkit Test']);
  for (const [name, tag] of [
    ['my notes/f.md', 'notes'],
    ['ren src.ts', 'ren'],
    ['big.ts', 'big'],
    ['gone.ts', 'gone'],
    ['mode.sh', 'mode'],
    ['q b/z.sh', 'qb'],
  ])
    write(name, body(tag));
  write('img.bin', '\0\x01\x02old');
  git(['add', '-A']);
  git(['commit', '-qm', 'baseline']);

  write('my notes/f.md', `${body('notes')}export const added = 1;\n`);
  git(['mv', 'ren src.ts', 'ren dst.ts']);
  write('copy of big.ts', body('big'));
  write('big.ts', `${body('big')}export const more = 1;\n`);
  unlinkSync(join(root, 'gone.ts'));
  write('empty.ts', '');
  for (const name of NEW_NAMES) write(name, body('fresh'));
  write('img.bin', '\0\x01\x02new');
  chmodSync(join(root, 'mode.sh'), 0o755);
  chmodSync(join(root, 'q b/z.sh'), 0o755);
  git(['add', '-A']);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The oracle: git's own NUL-terminated (never quoted) post-image names. */
const stagedNames = () =>
  git(['diff', '--cached', '-M', '-C', '--name-only', '-z']).split('\0').filter(Boolean).sort();
const resolvedNames = (diff: string) => splitDiffByFile(diff).map(filePathOf).sort();

describe('filePathOf over real git diff output', () => {
  it.each([[[]], [['-c', 'core.quotePath=false']]])('matches the -z name list (%j)', (config) => {
    const diff = git([...config, 'diff', '--cached', '-M', '-C']);
    expect(resolvedNames(diff)).toEqual(stagedNames());
  });

  it('resolves both sides of renames, copies, creations and deletions', () => {
    const segments = splitDiffByFile(git(['diff', '--cached', '-M', '-C']));
    const sides = new Map(segments.map((seg) => [filePathOf(seg), diffPathsOf(seg)]));
    expect(sides.get('ren dst.ts')).toEqual({ oldPath: 'ren src.ts', newPath: 'ren dst.ts' });
    expect(sides.get('copy of big.ts')).toEqual({ oldPath: 'big.ts', newPath: 'copy of big.ts' });
    expect(sides.get('new file.ts')).toEqual({ oldPath: null, newPath: 'new file.ts' });
    expect(sides.get('empty.ts')).toEqual({ oldPath: null, newPath: 'empty.ts' });
    expect(sides.get('gone.ts')).toEqual({ oldPath: 'gone.ts', newPath: null });
    expect(sides.get('q b/z.sh')).toEqual({ oldPath: 'q b/z.sh', newPath: 'q b/z.sh' });
  });

  it('keys chunk packing and chunk sub-diffs on the same full names', () => {
    const diff = git(['diff', '--cached', '-M', '-C']);
    expect([...identityByPath(diff).keys()].sort()).toEqual(stagedNames());
    for (const name of ['my notes/f.md', ...NEW_NAMES]) {
      const sub = chunkDiffText(diff, [name]);
      expect(resolvedNames(sub)).toEqual([name]);
    }
  });

  it.each([
    ['diff.noprefix', 'true'],
    ['diff.mnemonicPrefix', 'true'],
    ['diff.srcPrefix', 'SRC/'],
  ])('gitCached resolves every name under a consumer %s=%s', (key, value) => {
    git(['config', key, value]);
    try {
      expect(resolvedNames(gitCached(root, ['-M', '-C'], []))).toEqual(stagedNames());
    } finally {
      git(['config', '--unset', key]);
    }
  });
});

describe('diffPathsOf on malformed input', () => {
  it('ignores hunk bodies whose counts do not add up', () => {
    const seg = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,9 +1,9 @@\n-a\n';
    expect(filePathOf(seg)).toBe('x.ts');
  });

  it('returns null for a segment that is not a diff', () => {
    expect(diffPathsOf('echo done\n')).toEqual({ oldPath: null, newPath: null });
  });

  // A header-less diff splits on `--- `, so a removed SQL/Lua `-- comment` line opens a fake
  // segment with no `+++`: jsdiff throws on that, and the whole selection must not.
  it('survives a removed `-- comment` line in a header-less diff', () => {
    const diff = '--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,1 @@\n--- removed note\n+select 1;\n';
    expect(splitDiffByFile(diff).map(filePathOf)).toEqual(['q.sql', null]);
    expect(selectHunks(diff, () => true).files).toEqual(['q.sql']);
  });
});
