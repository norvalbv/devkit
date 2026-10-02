import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSteps,
  CACHE_ROOT,
  collectFiles,
  hashSourceTree,
  out,
  REPO_ROOT,
  shouldRebuildFresh,
  whichAbs,
} from '../harness.mts';

// Fast, build-free unit tests for the harness's pure logic. The slow build+pack+install lives in the
// *.e2e.test.mts suites; these pin the cache-key correctness (B1 silent-pass guard), the fresh-rebuild
// gating (the worker-race guard), and the small helpers.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-unit-'));
  dirs.push(root);
  return root;
}
function write(root: string, rel: string, body = 'x'): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), body);
}

describe('hashSourceTree — cache key', () => {
  it('is deterministic for an identical tree', () => {
    const a = tree();
    write(a, 'cli/index.mts', 'a');
    write(a, 'gate-engine/config.mts', 'b');
    expect(hashSourceTree(a)).toBe(hashSourceTree(a));
  });

  it('changes when a source byte changes (a broken/amended source must re-key)', () => {
    const a = tree();
    write(a, 'cli/index.mts', 'v1');
    const before = hashSourceTree(a);
    write(a, 'cli/index.mts', 'v2');
    expect(hashSourceTree(a)).not.toBe(before);
  });

  it('is unaffected by node_modules / dist / .git / __tests__ churn (else the cache never hits)', () => {
    const a = tree();
    write(a, 'cli/index.mts', 'a');
    const base = hashSourceTree(a);
    write(a, 'cli/node_modules/junk.ts', 'noise');
    write(a, 'cli/__tests__/x.test.mts', 'noise');
    write(a, 'dist/cli/index.mjs', 'noise');
    write(a, '.git/HEAD', 'noise');
    expect(hashSourceTree(a)).toBe(base);
  });

  it('renaming a file changes the key (path is folded into the hash, not just bytes)', () => {
    const a = tree();
    write(a, 'cli/a.mts', 'same');
    const first = hashSourceTree(a);
    rmSync(join(a, 'cli/a.mts'));
    write(a, 'cli/b.mts', 'same');
    expect(hashSourceTree(a)).not.toBe(first);
  });

  it('an empty tree (no source roots present) hashes without throwing', () => {
    expect(() => hashSourceTree(tree())).not.toThrow();
  });
});

describe('collectFiles', () => {
  it('returns nothing for a missing directory (absent optional root)', () => {
    const acc: string[] = [];
    collectFiles(join(tree(), 'does-not-exist'), 'x', acc);
    expect(acc).toEqual([]);
  });

  it('skips SKIP_DIRS but keeps .gitignore and real files', () => {
    const a = tree();
    write(a, 'cli/real.mts', 'x');
    write(a, 'cli/.gitignore', 'node_modules');
    write(a, 'cli/node_modules/dep.ts', 'x');
    write(a, 'cli/secret.env', 'x'); // dotfile-prefixed name? no — a normal file, kept
    const acc: string[] = [];
    collectFiles(join(a, 'cli'), 'cli', acc);
    expect(acc).toContain('cli/real.mts');
    expect(acc).toContain('cli/.gitignore');
    expect(acc.some((f) => f.includes('node_modules'))).toBe(false);
  });
});

describe('shouldRebuildFresh — worker-race guard', () => {
  it('true only when FRESH set AND not in a vitest worker', () => {
    expect(shouldRebuildFresh({ DEVKIT_E2E_FRESH: '1' })).toBe(true);
  });
  it('false in a worker even with FRESH set (prevents the concurrent-rm tarball race)', () => {
    expect(shouldRebuildFresh({ DEVKIT_E2E_FRESH: '1', VITEST_WORKER_ID: '2' })).toBe(false);
  });
  it('false when FRESH unset', () => {
    expect(shouldRebuildFresh({})).toBe(false);
  });
});

describe('out — combined stream helper', () => {
  it('concatenates stdout + stderr', () => {
    expect(out({ stdout: 'a', stderr: 'b' } as never)).toBe('ab');
  });
  it('tolerates undefined streams (spawn ENOENT / null result fields)', () => {
    expect(out({ stdout: undefined, stderr: undefined } as never)).toBe('');
  });
});

describe('whichAbs', () => {
  it('resolves a real binary to an absolute path', () => {
    expect(whichAbs('sh')).toMatch(/\/sh$/);
  });
  it('throws a clear precondition error for a missing binary', () => {
    expect(() => whichAbs('definitely-not-a-real-bin-xyz-123')).toThrow(/not found on PATH/);
  });
});

describe('buildSteps — sc-3220: the build never writes the repo dist/', () => {
  const stage = join(tmpdir(), 'devkit-e2e-stage-x');
  const prefix = join(CACHE_ROOT, 'abc');
  const [compile, copyAssets, pack] = buildSteps(stage, prefix);
  const insideRepo = (p: string) => {
    const rel = relative(REPO_ROOT, p);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1] ?? '';

  it('compiles and mirrors assets into the SAME stage dist, outside the repo', () => {
    const outDir = after(compile.args, '--outDir');
    expect(outDir).toBe(join(stage, 'dist'));
    expect(after(copyAssets.args, '--out')).toBe(outDir);
    expect(insideRepo(outDir)).toBe(false);
  });

  it('packs from the stage into the prefix with lifecycle scripts off', () => {
    expect(pack.cwd).toBe(stage);
    expect(pack.args).toContain('--ignore-scripts');
    expect(after(pack.args, '--destination')).toBe(prefix);
    expect(insideRepo(pack.cwd)).toBe(false);
  });

  it('never runs the in-tree `bun run build` script', () => {
    for (const s of [compile, copyAssets, pack]) expect(s.args).not.toContain('build');
  });

  it('every path argument is absolute, so a step is independent of the caller cwd', () => {
    for (const s of [compile, copyAssets]) {
      for (const a of s.args.filter((x) => !x.startsWith('-'))) expect(isAbsolute(a), a).toBe(true);
    }
  });
});
