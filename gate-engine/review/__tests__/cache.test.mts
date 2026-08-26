import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

const TELEMETRY_ENV = ['DEVKIT_GATE_EVENTS', 'DEVKIT_SHIP_ID'];
const savedEnv = {};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  for (const k of TELEMETRY_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
// Route this file's emits at a temp sink instead of the developer's live telemetry.
const captureEvents = (repo) => {
  for (const k of TELEMETRY_ENV) savedEnv[k] = process.env[k];
  const sink = join(repo, 'events.jsonl');
  process.env.DEVKIT_GATE_EVENTS = sink;
  process.env.DEVKIT_SHIP_ID = 'ship-cache-test';
  return () =>
    existsSync(sink)
      ? readFileSync(sink, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
};

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
      JSON.stringify({ version: 999, entries: { k: {} } }),
    );
    expect(loadCache(repo)).toEqual({});
  });
  it('prunes to the newest 400 entries (sc-1907: a chunked attempt writes up to 13 keys)', () => {
    const repo = gitRepo();
    const many = {};
    for (let i = 0; i < 430; i++) {
      many[`r:${i}`] = {
        at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.${i}Z`,
        model: 's',
      };
    }
    savePasses(repo, many);
    expect(Object.keys(loadCache(repo)).length).toBe(400);
  });
  it('reports a durable write', () => {
    const repo = gitRepo();
    expect(savePasses(repo, { 'commit-guard:abc': { at: '2026-01-01T00:00:00Z' } })).toBe(true);
  });

  it('a LOST write is named and emitted — the PASS was earned but will be silently re-judged', () => {
    const repo = gitRepo();
    const events = captureEvents(repo);
    // `.devkit` as a FILE: the store can neither create its lock dir nor publish, so the write
    // fails. Previously savePasses discarded that boolean, making lock contention on a shared
    // main-checkout `.devkit/` indistinguishable from an ordinary cache miss (sc-1239).
    writeFileSync(join(repo, '.devkit'), 'not a directory');
    expect(savePasses(repo, { 'correctness-reviewer:abc': { at: '2026-01-01T00:00:00Z' } })).toBe(
      false,
    );
    // Labelled like judge_exec/cache_hit: the key prefix IS the reviewer name (see cacheKey).
    expect(events()).toContainEqual(
      expect.objectContaining({ type: 'cache_write_failed', judge: 'review:correctness-reviewer' }),
    );
  });

  it('clearCache empties without deleting the file', () => {
    const repo = gitRepo();
    savePasses(repo, { k: { at: '2026-01-01T00:00:00Z', model: 's' } });
    clearCache(repo);
    expect(loadCache(repo)).toEqual({});
    const persisted = JSON.parse(readFileSync(cachePath(repo), 'utf8')) as {
      version: number;
      generation: string;
      entries: Record<string, unknown>;
    };
    expect(persisted).toEqual({ version: 2, generation: persisted.generation, entries: {} });
    expect(readFileSync(`${cachePath(repo)}.generation`, 'utf8')).toBe(`${persisted.generation}\n`);
  });
});
