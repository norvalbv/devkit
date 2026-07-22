import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadChangedSet } from '../changed-files.mts';

// loadChangedSet decides WHICH files the scoped (`--changed`) dup + clone gates judge, so its
// contract is a gate-correctness contract: too wide and a commit is blocked over code it does not
// contain; too narrow and a real dup slips through. Exercised against a real git repo — the
// staged/unstaged distinction it turns on only exists in git.

let repo: string;

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const write = (name: string, body: string) => writeFileSync(join(repo, name), body);

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'changed-files-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  write('base.ts', 'export const base = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.MATCHER_CHANGED_FILES;
});

describe('loadChangedSet', () => {
  it('takes MATCHER_CHANGED_FILES verbatim, splitting on commas and newlines', () => {
    process.env.MATCHER_CHANGED_FILES = 'a.ts,b.ts\nc.ts';
    expect([...loadChangedSet(repo)].sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('an explicitly empty MATCHER_CHANGED_FILES means empty, not "fall back to git"', () => {
    process.env.MATCHER_CHANGED_FILES = '';
    expect(loadChangedSet(repo).size).toBe(0);
  });

  it('derives the staged set from git when unset', () => {
    write('staged.ts', 'export const s = 1;\n');
    git('add', 'staged.ts');
    expect(loadChangedSet(repo).has('staged.ts')).toBe(true);
  });

  it('drops a file whose working tree has edits ON TOP of what is staged', () => {
    // Both detectors read the WORKING TREE (jscpd opens files on disk; the matcher reads index
    // rows built from disk), so for a partially-staged file the content they judge is not the
    // content being committed. Gating on it blocks a commit over code that is not in it.
    write('partial.ts', 'export const p = 1;\n');
    git('add', 'partial.ts');
    write('partial.ts', 'export const p = 1;\nexport const later = 2;\n');
    expect(loadChangedSet(repo).has('partial.ts')).toBe(false);
  });

  it('returns an empty set outside a git repo rather than throwing', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    try {
      expect(loadChangedSet(notARepo).size).toBe(0);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
