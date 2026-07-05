import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cachePath, clearCache, loadCache, savePasses } from '../cache.mts';

const dirs = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'guard-review-cache-'));
  dirs.push(d);
  return d;
};
const gitRepo = () => {
  const d = tempDir();
  execSync('git init -q', { cwd: d });
  return d;
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('cachePath', () => {
  it('anchors to the repo root .devkit even from a subdirectory', () => {
    const repo = gitRepo();
    const sub = join(repo, 'deep', 'inside');
    mkdirSync(sub, { recursive: true });
    expect(cachePath(sub)).toBe(join(repo, '.devkit', 'review-cache.json'));
  });
  it('a linked worktree shares the MAIN checkout cache (a ship worktree sees main-tree verdicts)', () => {
    const repo = gitRepo();
    writeFileSync(join(repo, 'f.txt'), 'x');
    execSync('git add . && git -c user.email=t@t -c user.name=t commit -qm i', { cwd: repo });
    const wt = join(repo, '.worktrees', 'ship-x');
    execSync(`git worktree add -q ${JSON.stringify(wt)} -b tmp-branch`, { cwd: repo });
    // The path STRING may differ in symlink form (macOS /var → /private/var) — the contract is
    // that both endpoints hit the same file. Save from the worktree, read from the main tree.
    savePasses(wt, { 'commit-guard:shared': { at: '2026-01-01T00:00:00Z', model: 'sonnet' } });
    expect(loadCache(repo)['commit-guard:shared']).toMatchObject({ model: 'sonnet' });
    expect(realpathSync(cachePath(wt))).toBe(realpathSync(cachePath(repo)));
  });
  it('non-repo cwd falls back to the cwd itself', () => {
    const d = tempDir();
    expect(cachePath(d)).toBe(join(d, '.devkit', 'review-cache.json'));
  });
});

describe('loadCache / savePasses / clearCache', () => {
  it('round-trips a PASS entry', () => {
    const repo = gitRepo();
    savePasses(repo, { 'commit-guard:abc': { at: '2026-01-01T00:00:00Z', model: 'sonnet' } });
    expect(loadCache(repo)['commit-guard:abc']).toMatchObject({ model: 'sonnet' });
  });
  it('absent file → empty (re-review, never skip)', () => {
    expect(loadCache(gitRepo())).toEqual({});
  });
  it('corrupt JSON → empty', () => {
    const repo = gitRepo();
    mkdirSync(join(repo, '.devkit'), { recursive: true });
    writeFileSync(join(repo, '.devkit', 'review-cache.json'), '{nope');
    expect(loadCache(repo)).toEqual({});
  });
  it('foreign version → empty (a future format never half-parses)', () => {
    const repo = gitRepo();
    mkdirSync(join(repo, '.devkit'), { recursive: true });
    writeFileSync(
      join(repo, '.devkit', 'review-cache.json'),
      JSON.stringify({ version: 2, entries: { k: {} } }),
    );
    expect(loadCache(repo)).toEqual({});
  });
  it('prunes to the newest 100 entries', () => {
    const repo = gitRepo();
    const many = {};
    for (let i = 0; i < 130; i++) {
      many[`r:${i}`] = {
        at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.${i}Z`,
        model: 's',
      };
    }
    savePasses(repo, many);
    expect(Object.keys(loadCache(repo)).length).toBe(100);
  });
  it('clearCache empties without deleting the file', () => {
    const repo = gitRepo();
    savePasses(repo, { k: { at: '2026-01-01T00:00:00Z', model: 's' } });
    clearCache(repo);
    expect(loadCache(repo)).toEqual({});
    expect(readFileSync(cachePath(repo), 'utf8')).toContain('"version":1');
  });
});
