import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectChangedComments } from '../detect.mts';
import { parseStagedDiff, stagedDiff } from '../staged-diff.mts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function write(root: string, file: string, content: string | Buffer): void {
  mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
}

function repo(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'staged-diff-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'diff@example.test']);
  git(root, ['config', 'user.name', 'Diff Test']);
  write(root, 'guard.config.json', `${JSON.stringify({ scanRoots: ['src'] })}\n`);
  for (const [file, content] of Object.entries(files)) write(root, file, content);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

const BODY = Array.from({ length: 8 }, (_, index) => `const v${index} = ${index};`);
const DOC = ['// one', '// two', '// three'];

/** One staged entry of every kind the gate meets: edit, add, renames, mode, binary, gitlink. */
function mixedStage(): string {
  const root = repo({
    'src/x y.ts': `${BODY.join('\n')}\n`,
    'src/é.ts': 'export const e = 1;\n',
    'src/mode.ts': 'export const m = 1;\n',
    'src/old.ts': `${BODY.join('\n')}\n`,
    'src/p.ts': `${BODY.join('\n')}\n`,
    'bin.dat': Buffer.from([0, 1, 2, 3]),
  });
  write(root, 'src/x y.ts', `${[...DOC, ...BODY].join('\n')}\n`);
  write(root, 'src/é.ts', 'export const e = 2;\n');
  chmodSync(path.join(root, 'src/mode.ts'), 0o755);
  write(root, 'src/empty.ts', '');
  git(root, ['mv', 'src/old.ts', 'src/new.ts']);
  git(root, ['mv', 'src/p.ts', 'src/q.ts']);
  write(root, 'src/q.ts', `${[...BODY, 'const tail = 1;'].join('\n')}\n`);
  write(root, 'bin.dat', Buffer.from([0, 9, 9, 9]));
  git(root, ['add', '-A']);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['update-index', '--add', '--cacheinfo', `160000,${head},sub`]);
  return root;
}

describe('stagedDiff', () => {
  it('pairs every raw entry with its own hunks', () => {
    const entries = Object.fromEntries(
      [...stagedDiff(mixedStage())].map(([file, entry]) => [
        file,
        { ...entry, added: entry.hunks.flatMap((hunk) => [...hunk.addedLines]) },
      ]),
    );
    expect(Object.keys(entries).sort()).toEqual(
      [
        'bin.dat',
        'src/empty.ts',
        'src/mode.ts',
        'src/new.ts',
        'src/q.ts',
        'src/x y.ts',
        'src/é.ts',
        'sub',
      ].sort(),
    );
    expect(entries['src/x y.ts']).toMatchObject({ status: 'M', added: [1, 2, 3] });
    expect(entries['src/new.ts']).toMatchObject({ status: 'R100', from: 'src/old.ts', hunks: [] });
    expect(entries['src/q.ts']).toMatchObject({ from: 'src/p.ts', added: [9] });
    expect(entries['src/é.ts']).toMatchObject({ added: [1] });
    expect(entries['bin.dat']).toMatchObject({ hunks: [] });
    expect(entries['src/mode.ts']).toMatchObject({ hunks: [] });
    expect(entries['src/empty.ts']).toMatchObject({
      status: 'A',
      srcOid: '0'.repeat(40),
      hunks: [],
    });
  });

  it.each([
    ['diff.mnemonicPrefix', 'true'],
    ['diff.noprefix', 'true'],
    ['diff.submodule', 'log'],
    ['diff.submodule', 'diff'],
    ['core.quotePath', 'false'],
  ])('reads the same entries under %s=%s', (key, value) => {
    const root = mixedStage();
    const plain = stagedDiff(root);
    git(root, ['config', key, value]);
    expect(stagedDiff(root)).toEqual(plain);
  });

  it('pairs entries to patches by position under a diff.orderFile that reorders both', () => {
    const root = mixedStage();
    const plain = stagedDiff(root);
    const order = path.join(root, '.git', 'devkit-order');
    writeFileSync(order, 'sub\nsrc/q.ts\nbin.dat\nsrc/*\n');
    git(root, ['config', 'diff.orderFile', order]);
    const ordered = stagedDiff(root);
    expect([...ordered.keys()]).not.toEqual([...plain.keys()]);
    expect(ordered).toEqual(plain);
  });

  it('refuses output whose patches do not line up with its entries', () => {
    const oid = 'a'.repeat(40);
    const raw = `:100644 100644 ${oid} ${oid} M\0a.ts\0:100644 100644 ${oid} ${oid} M\0b.ts\0\0`;
    expect(() => parseStagedDiff(`${raw}diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n`)).toThrow(
      /2 entries with 1 patches/,
    );
  });

  it('reads nothing from an empty staged set', () => {
    expect(stagedDiff(repo({ 'src/a.ts': 'export {};\n' })).size).toBe(0);
  });
});

describe('detectChangedComments over the batched diff', () => {
  it('finds the same comment under prefix config as under the default', () => {
    const root = mixedStage();
    const plain = detectChangedComments(root).findings;
    git(root, ['config', 'diff.mnemonicPrefix', 'true']);
    expect(plain.map((finding) => finding.path)).toEqual(['src/x y.ts']);
    expect(detectChangedComments(root).findings).toEqual(plain);
  });

  it('is not stopped by a broken textconv driver on an out-of-scope file', () => {
    const root = repo({
      '.gitattributes': '*.pdf diff=pdf\n',
      'doc.pdf': 'first\n',
      'src/a.ts': `${BODY.join('\n')}\n`,
    });
    git(root, ['config', 'diff.pdf.textconv', 'devkit-no-such-textconv']);
    write(root, 'doc.pdf', 'second\n');
    write(root, 'src/a.ts', `${[...DOC, ...BODY].join('\n')}\n`);
    git(root, ['add', '-A']);
    expect(detectChangedComments(root).findings.map((finding) => finding.path)).toEqual([
      'src/a.ts',
    ]);
  });

  it('keeps a copied file new, with its comment, when the consumer sets diff.renames=copies', () => {
    const root = repo({ 'src/a.ts': `${[...DOC, ...BODY].join('\n')}\n` });
    write(root, 'src/a.ts', `${[...DOC, ...BODY, 'const tail = 1;'].join('\n')}\n`);
    write(root, 'src/b.ts', `${[...DOC, ...BODY].join('\n')}\n`);
    git(root, ['add', '-A']);
    git(root, ['config', 'diff.renames', 'copies']);
    expect(detectChangedComments(root).findings.map((finding) => finding.path)).toEqual([
      'src/b.ts',
    ]);
  });
});
