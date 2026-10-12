import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRedCommit, classifyChange, prBase, treeOf } from './red-ref.mts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'evidence-red-'));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  write({
    'guard.config.json': '{"sourceExtensions":["ts"]}',
    'src/value.ts': 'broken\n',
    'src/old.test.ts': 'old\n',
    'README.md': 'v1\n',
  });
  return { root, git, write, commit, base: commit('base') };
}

describe('red ref', () => {
  it('overlays added and modified tests plus support files on the base, and nothing else', () => {
    const { root, git, write, commit, base } = repo();
    write({
      'src/value.ts': 'fixed\n',
      'src/value.test.ts': 'new test\n',
      'src/__tests__/fixture.ts': 'support\n',
      'README.md': 'v2\n',
    });
    git('rm', '-q', 'src/old.test.ts');
    const head = commit('fix');
    const refsBefore = git('for-each-ref');

    const change = classifyChange(root, base, head, ['src/__tests__/**']);
    const red = buildRedCommit(root, base, change.overlay);

    expect(change.tests).toEqual(['src/value.test.ts']);
    expect(change.docsOnly).toBe(false);
    expect(git('show', `${red}:src/value.ts`)).toBe('broken');
    expect(git('show', `${red}:src/value.test.ts`)).toBe('new test');
    expect(git('show', `${red}:src/__tests__/fixture.ts`)).toBe('support');
    expect(git('show', `${red}:README.md`)).toBe('v1');
    expect(git('show', `${red}:src/old.test.ts`)).toBe('old');
    expect(git('rev-parse', `${red}^`)).toBe(base);
    expect(buildRedCommit(root, base, change.overlay)).toBe(red);
    expect(git('for-each-ref')).toBe(refsBefore);
  });

  it('marks a Markdown-only change and finds no test in it', () => {
    const { root, write, commit, base } = repo();
    write({ 'README.md': 'v2\n', 'docs/guide.mdx': 'new\n' });
    const head = commit('docs');

    expect(classifyChange(root, base, head, [])).toMatchObject({ docsOnly: true, tests: [] });
  });

  it('builds a red tree equal to head when the PR changes only tests', () => {
    const { root, write, commit, base } = repo();
    write({ 'src/value.test.ts': 'only a test\n' });
    const head = commit('test only');

    const red = buildRedCommit(root, base, classifyChange(root, base, head, []).overlay);
    expect(treeOf(root, red)).toBe(treeOf(root, head));
  });

  it('measures the PR from where it forked, not from the moved base tip', () => {
    const { root, git, write, commit, base } = repo();
    git('checkout', '-q', '-b', 'feature');
    write({ 'src/value.ts': 'fixed\n' });
    const head = commit('fix');
    git('checkout', '-q', 'main');
    write({ 'README.md': 'moved\n' });
    const tip = commit('main moved');

    expect(prBase(root, tip, head)).toBe(base);
  });
});
