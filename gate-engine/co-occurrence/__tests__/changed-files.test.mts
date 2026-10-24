import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadChangedSet } from '../changed-files.mts';

// loadChangedSet decides WHICH files the scoped (`--changed`) dup + clone gates judge, so its
// contract is a gate-correctness contract: too wide and a commit is blocked over code it does not
// contain; too narrow and a real dup slips through. Exercised against a real git repo — the
// staged/unstaged distinction it turns on only exists in git.

let repo: string;

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const write = (name: string, body: string) => writeFileSync(join(repo, name), body);

// Stages `<bytes>.ts` straight into the index: APFS refuses a non-UTF-8 name on disk.
function indexNonUtf8(g: (args: string[], input?: Buffer) => Buffer, bytes: number[]): void {
  const blob = g(['hash-object', '-w', '--stdin'], Buffer.from('x\n')).toString().trim();
  const name = Buffer.from([...bytes, 0x2e, 0x74, 0x73]);
  g(
    ['update-index', '-z', '--index-info'],
    Buffer.concat([Buffer.from(`100644 ${blob}\t`), name, Buffer.from([0])]),
  );
}

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

  it('keeps non-ASCII and space-edged staged names verbatim even with core.quotePath on', () => {
    git('config', 'core.quotePath', 'true');
    write('naïve.ts', 'export const n = 1;\n');
    write(' edge.ts', 'export const e = 1;\n');
    git('add', 'naïve.ts', ' edge.ts');
    const changed = loadChangedSet(repo);
    expect(changed.has('naïve.ts')).toBe(true);
    expect(changed.has(' edge.ts')).toBe(true);
  });

  // A committed non-UTF-8 name can never be on disk under APFS, so it stays in the UNSTAGED list
  // for good. It must not empty the scope, and the partially-staged exclusion must still hold.
  it('drops a committed non-UTF-8 name on its own, silently, keeping the scope exact', () => {
    const root = mkdtempSync(join(tmpdir(), 'changed-files-nonutf8-'));
    const g = (args: string[], input?: Buffer) =>
      execFileSync('git', args, { cwd: root, input, stdio: ['pipe', 'pipe', 'ignore'] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      g(['init', '-q']);
      indexNonUtf8(g, [0xff]);
      writeFileSync(join(root, 'partial.ts'), 'export const p = 1;\n');
      g(['add', 'partial.ts']);
      g(['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'base']);
      writeFileSync(join(root, 'staged.ts'), 'export const s = 1;\n');
      writeFileSync(join(root, 'partial.ts'), 'export const p = 2;\n');
      g(['add', 'staged.ts', 'partial.ts']);
      writeFileSync(join(root, 'partial.ts'), 'export const p = 3;\n');
      expect(loadChangedSet(root)).toEqual(new Set(['staged.ts']));
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops a staged non-UTF-8 name, keeps the rest, and says so once', () => {
    const root = mkdtempSync(join(tmpdir(), 'changed-files-nonutf8-staged-'));
    const g = (args: string[], input?: Buffer) =>
      execFileSync('git', args, { cwd: root, input, stdio: ['pipe', 'pipe', 'ignore'] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      g(['init', '-q']);
      writeFileSync(join(root, 'ok.ts'), 'export const ok = 1;\n');
      g(['add', 'ok.ts']);
      indexNonUtf8(g, [0xfe]);
      expect(loadChangedSet(root)).toEqual(new Set(['ok.ts']));
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]?.[0])).toContain('1 staged path(s) not valid UTF-8');
    } finally {
      error.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
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
