import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'size-disable.mts');
const BASELINE = '.devkit/baselines/size-lines.json';

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
const gate = (root: string) =>
  spawnSync(process.execPath, [SCRIPT, 'gate'], { cwd: root, encoding: 'utf8' });
const lines = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => `const x${i + from} = 1;`).join('\n') + '\n';
const write = (root: string, rel: string, body: string) => {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const stagedEntries = (root: string) => JSON.parse(git(root, 'show', `:${BASELINE}`)).files;

/** A repo whose base commit grandfathers each named file at 120 lines (cap 50). */
function repo(...files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'line-heal-'));
  roots.push(root);
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  write(
    root,
    'guard.config.json',
    JSON.stringify({ scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 }),
  );
  for (const f of files) write(root, `src/${f}.ts`, lines(120));
  expect(spawnSync(process.execPath, [SCRIPT, 'freeze'], { cwd: root }).status).toBe(0);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  return root;
}

/** Commit a shrink of src/<file>.ts to `keep` lines on a new branch, through the gate. */
function shrinkOn(root: string, branch: string, file: string, keep: number, from = 1) {
  git(root, 'switch', '-q', 'main');
  git(root, 'switch', '-qc', branch);
  write(root, `src/${file}.ts`, lines(keep, from));
  git(root, 'add', '-A');
  expect(gate(root).status).toBe(0);
  git(root, 'commit', '-qm', branch);
}

/** Merge `other` into `branch`, resolve the baseline conflict by taking ours, stage everything. */
function mergeTakingOurs(root: string, branch: string, other: string) {
  git(root, 'switch', '-q', branch);
  spawnSync('git', ['merge', '--no-ff', other], { cwd: root });
  git(root, 'checkout', '--ours', BASELINE);
  git(root, 'add', '-A');
}

describe('guard-size heals ceilings a picked-side resolution raised', () => {
  it('lowers the other side’s entry when sibling branches shrank adjacent files', () => {
    const root = repo('f1', 'f2');
    shrinkOn(root, 'a', 'f1', 100);
    shrinkOn(root, 'b', 'f2', 90);
    mergeTakingOurs(root, 'b', 'a');
    expect(stagedEntries(root)['src/f1.ts']).toBe(120);

    expect(gate(root).status).toBe(0);
    expect(stagedEntries(root)).toEqual({ 'src/f1.ts': 100, 'src/f2.ts': 90 });
  });

  it('recomputes a file both siblings shrank to the merged count neither side recorded', () => {
    const root = repo('f1');
    shrinkOn(root, 'a', 'f1', 100);
    shrinkOn(root, 'b', 'f1', 110, 11);
    mergeTakingOurs(root, 'b', 'a');

    expect(gate(root).status).toBe(0);
    expect(stagedEntries(root)).toEqual({ 'src/f1.ts': 90 });
  });

  it('lowers an entry a non-merge commit raises for a file it does not touch', () => {
    const root = repo('f1', 'f2');
    shrinkOn(root, 'main-shrink', 'f1', 100);
    const head = JSON.parse(git(root, 'show', `HEAD:${BASELINE}`));
    write(root, BASELINE, JSON.stringify({ ...head, files: { ...head.files, 'src/f1.ts': 120 } }));
    write(root, 'src/f2.ts', lines(110));
    git(root, 'add', '-A');

    expect(gate(root).status).toBe(0);
    expect(stagedEntries(root)).toEqual({ 'src/f1.ts': 100, 'src/f2.ts': 110 });
  });

  it('judges the index, never an unstaged shrink of a file outside the commit', () => {
    const root = repo('f1', 'f2', 'f3');
    shrinkOn(root, 'a', 'f1', 100);
    shrinkOn(root, 'b', 'f2', 90);
    mergeTakingOurs(root, 'b', 'a');
    write(root, 'src/f3.ts', lines(60));

    expect(gate(root).status).toBe(0);
    expect(stagedEntries(root)['src/f3.ts']).toBe(120);
  });

  it('drops a raised entry whose file is now within the cap', () => {
    const root = repo('f1', 'f2');
    shrinkOn(root, 'a', 'f1', 40);
    shrinkOn(root, 'b', 'f2', 90);
    mergeTakingOurs(root, 'b', 'a');

    expect(gate(root).status).toBe(0);
    expect(stagedEntries(root)).toEqual({ 'src/f2.ts': 90 });
  });
});
