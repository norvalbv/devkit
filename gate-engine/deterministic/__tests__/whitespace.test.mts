import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { withoutGitEnv } from '../../judge/judge-isolation.mts';
import { COMMIT_GIT_DIR_VAR, COMMIT_INDEX_FILE_VAR } from '../../ratchets/commit-index.mts';
import { DETERMINISTIC } from '../registry.mts';
import { GATE_REASON_ENV } from '../reason.mts';
import { remedyFor } from '../whitespace.mts';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'whitespace.mts');
const RUN = join(dirname(SCRIPT), 'run.mts');

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

function git(root: string, args: string[], env: NodeJS.ProcessEnv = withoutGitEnv()) {
  return execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
}

/** A repository whose HEAD holds `files`; the test then writes and stages its change. */
function repo(files: Record<string, string> = { 'a.ts': 'export {};\n' }): string {
  const root = mkdtempSync(join(tmpdir(), 'whitespace-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 't@t.t']);
  git(root, ['config', 'user.name', 't']);
  for (const [name, body] of Object.entries(files)) write(root, name, body);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base', '--no-verify']);
  return root;
}

function write(root: string, name: string, body: string) {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), body);
}

function stage(root: string, files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) write(root, name, body);
  git(root, ['add', '-A']);
}

function gate(root: string, extraEnv: NodeJS.ProcessEnv = {}, cwd = root) {
  const reasonFile = join(root, '.git', 'reason.txt');
  rmSync(reasonFile, { force: true });
  const r = spawnSync('node', [SCRIPT, 'gate'], {
    cwd,
    encoding: 'utf8',
    env: { ...withoutGitEnv(), [GATE_REASON_ENV]: reasonFile, ...extraEnv },
  });
  let reason = '';
  try {
    reason = readFileSync(reasonFile, 'utf8');
  } catch {
    // A passing gate records no reason.
  }
  return { status: r.status, stderr: r.stderr, reason };
}

describe('whitespace gate', () => {
  it('blocks a staged new blank line at EOF and names file:line in its reason', () => {
    const root = repo();
    stage(root, { 'a.ts': 'export {};\n\n' });
    const r = gate(root);
    expect(r.status).toBe(1);
    expect(r.reason).toContain('a.ts:2: new blank line at EOF.');
    expect(r.reason).toContain('-whitespace');
    // A brand-new file: ship copies untracked files, so git apply's warning never sees them.
    stage(root, { 'a.ts': 'export {};\n', 'new.ts': 'export {};\n\n' });
    expect(gate(root).reason).toContain('new.ts:2: new blank line at EOF.');
  });

  it('blocks the first commit of an unborn branch (no HEAD to diff against)', () => {
    const root = mkdtempSync(join(tmpdir(), 'whitespace-unborn-'));
    roots.push(root);
    git(root, ['init', '-q']);
    stage(root, { 'a.ts': 'export {}; \n' });
    expect(gate(root).status).toBe(1);
  });

  it('counts only git finding lines, never offending content that looks like one', () => {
    const root = repo();
    stage(root, { 'a.ts': "log('x.ts:3: bad') \n" });
    const r = gate(root);
    expect(r.status).toBe(1);
    expect(r.reason).toContain('a.ts:1: trailing whitespace.');
    expect(r.reason).not.toContain("log('x.ts:3: bad')");
  });

  it('does not re-judge whitespace a file carried before it was renamed, even with diff.renames=false', () => {
    const root = repo({ 'a.ts': 'const a = 1;  \nconst b = 2;\nconst c = 3;\n' });
    git(root, ['config', 'diff.renames', 'false']);
    git(root, ['mv', 'a.ts', 'b.ts']);
    expect(gate(root).status).toBe(0);
  });

  it('judges only the package it runs in when installed in a monorepo subdirectory', () => {
    const root = repo({ 'pkg/p.ts': 'export {};\n' });
    stage(root, { 'other.ts': 'sibling package line \n' });
    expect(gate(root, {}, join(root, 'pkg')).status).toBe(0);
    stage(root, { 'pkg/p.ts': 'export {}; \n' });
    const r = gate(root, {}, join(root, 'pkg'));
    expect(r.status).toBe(1);
    expect(r.reason).toContain('p.ts:1: trailing whitespace.');
  });

  it('blocks a merge only on lines its resolution added, not on lines inherited from MERGE_HEAD', () => {
    const root = repo();
    const base = git(root, ['branch', '--show-current']).trim();
    git(root, ['checkout', '-qb', 'feat']);
    stage(root, { 'f.ts': 'export {};\n' });
    git(root, ['commit', '-qm', 'feat', '--no-verify']);
    git(root, ['checkout', '-q', base]);
    stage(root, { 'm.md': 'from main \n' });
    git(root, ['commit', '-qm', 'main', '--no-verify']);
    git(root, ['checkout', '-q', 'feat']);
    git(root, ['merge', '--no-commit', '--no-ff', '-q', base]);
    expect(gate(root).status).toBe(0);
    stage(root, { 'f.ts': 'export {}; \n' });
    expect(gate(root).status).toBe(1);
  });

  it('keeps a finding in a file whose name starts with `+`, in and outside a merge', () => {
    const root = repo();
    stage(root, { '+p.ts': 'export {}; \n' });
    expect(gate(root).reason).toContain('+p.ts:1: trailing whitespace.');
    git(root, ['commit', '-qm', 'plus file', '--no-verify']);
    stage(root, { '+p.ts': 'export {};\n' });
    git(root, ['commit', '-qm', 'clean', '--no-verify']);
    const base = git(root, ['branch', '--show-current']).trim();
    git(root, ['checkout', '-qb', 'side']);
    stage(root, { 's.ts': 'export {};\n' });
    git(root, ['commit', '-qm', 'side', '--no-verify']);
    git(root, ['checkout', '-q', base]);
    git(root, ['merge', '--no-commit', '--no-ff', '-q', 'side']);
    stage(root, { '+p.ts': 'export {}; \n' });
    expect(gate(root).status).toBe(1);
  });

  it('keeps every finding outside a merge, even beside a file named MERGE_HEAD', () => {
    const root = repo();
    stage(root, { MERGE_HEAD: 'not a ref \n', 'a.ts': 'export {}; \n' });
    expect(gate(root).reason).toContain('a.ts:1: trailing whitespace.');
  });

  it('still blocks when git prints more findings than one spawn buffer holds', () => {
    const root = repo();
    stage(root, { 'big.ts': 'x \n'.repeat(60_000) });
    expect(gate(root).status).toBe(1);
  });

  it('runs through guard-deterministic with the commit-index carrier the hook exports', () => {
    const root = repo();
    const gitDir = git(root, ['rev-parse', '--absolute-git-dir']).trim();
    const commitIndex = join(gitDir, 'index.lock');
    writeFileSync(join(root, 'a.ts'), 'export {}; \n');
    git(root, ['add', 'a.ts'], { ...withoutGitEnv(), GIT_INDEX_FILE: commitIndex });
    const r = spawnSync('node', [RUN, '--only', 'whitespace'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...withoutGitEnv(),
        [COMMIT_INDEX_FILE_VAR]: commitIndex,
        [COMMIT_GIT_DIR_VAR]: gitDir,
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('deterministic gates failed: guard-whitespace');
    expect(r.stderr).toContain('a.ts:1: trailing whitespace.');
  });

  it('blocks added trailing whitespace and passes a clean change', () => {
    const root = repo();
    stage(root, { 'a.ts': 'export const x = 1; \n' });
    expect(gate(root).status).toBe(1);
    stage(root, { 'a.ts': 'export const x = 1;\n' });
    expect(gate(root)).toMatchObject({ status: 0, reason: '' });
  });

  it('judges only added lines: whitespace already in HEAD does not block', () => {
    const root = repo({ 'a.ts': 'const a = 1;  \n' });
    stage(root, { 'a.ts': 'const a = 1;  \nconst b = 2;\n' });
    expect(gate(root).status).toBe(0);
  });

  it('honours a .gitattributes -whitespace exemption', () => {
    const root = repo({ '.gitattributes': '*.patch -whitespace\n' });
    stage(root, { 'fix.patch': '@@ -1,3 +1,3 @@\n a\n \n-b\n+c\n' });
    expect(gate(root).status).toBe(0);
  });

  it('names conflict-marker-size, not -whitespace, for a leftover conflict marker', () => {
    const root = repo();
    stage(root, { 'README.md': 'Title\n=======\n' });
    const r = gate(root);
    expect(r.status).toBe(1);
    expect(r.reason).toContain('leftover conflict marker');
    expect(r.reason).toContain('conflict-marker-size');
    expect(r.reason).not.toContain('`<glob> -whitespace`');
  });

  it('classifies a conflict-marker finding with or without a trailing period', () => {
    for (const finding of [
      'a.md:2: leftover conflict marker',
      'a.md:2: leftover conflict marker.',
    ]) {
      const [remedy, ...rest] = remedyFor([finding]);
      expect(remedy).toContain('conflict-marker-size');
      expect(rest).toEqual([]);
    }
  });

  it('judges the commit index the hook carries (commit -a / partial), not the default index', () => {
    const root = repo();
    const gitDir = git(root, ['rev-parse', '--absolute-git-dir']).trim();
    const commitIndex = join(gitDir, 'index.lock');
    writeFileSync(join(root, 'a.ts'), 'export {}; \n');
    git(root, ['add', 'a.ts'], { ...withoutGitEnv(), GIT_INDEX_FILE: commitIndex });
    const carrier = { [COMMIT_INDEX_FILE_VAR]: commitIndex, [COMMIT_GIT_DIR_VAR]: gitDir };
    expect(gate(root).status).toBe(0);
    expect(gate(root, carrier).status).toBe(1);
  });

  it('exits 2 (could not run) outside a git repository and on a usage error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whitespace-nogit-'));
    roots.push(dir);
    const r = gate(dir, { GIT_CEILING_DIRECTORIES: dirname(dir) });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('could not run git diff --check');
    expect(spawnSync('node', [SCRIPT], { encoding: 'utf8' }).status).toBe(2);
  });

  it('runs first among the deterministic gates and is on by default', () => {
    expect(DETERMINISTIC[0]).toMatchObject({ id: 'whitespace', args: ['gate'] });
    expect('optIn' in DETERMINISTIC[0]).toBe(false);
  });
});
