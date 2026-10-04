/**
 * `devkit move` end to end in throwaway git repos: every specifier style must survive a move or rename.
 * The rewrite rules live in docs/decisions/move-rewrites-via-ts-file-rename.md.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI, rootRegistry, testSpawnSync } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });

const DEFAULT_TSCONFIG = JSON.stringify({
  compilerOptions: { paths: { '@/*': ['./src/renderer/*'] } },
  include: ['src'],
});

const writePath = (root, rel, content) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
};

function fixture(tsconfigText = DEFAULT_TSCONFIG) {
  const root = mkTmp('move-');
  writePath(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0', type: 'module' }));
  writePath(root, 'tsconfig.json', tsconfigText);
  // the file to move + a non-moved dependency it imports relatively (tests re-anchor)
  writePath(
    root,
    'src/renderer/features/a/util.ts',
    "import { helper } from './helper';\nexport const x = helper;\n",
  );
  writePath(root, 'src/renderer/features/a/helper.ts', 'export const helper = 1;\n');
  // colocated test sibling — moves WITH util
  writePath(
    root,
    'src/renderer/features/a/util.test.ts',
    "import { x } from './util';\nexport const t = x;\n",
  );
  // relative importer (same dir) + alias importer (other feature)
  writePath(
    root,
    'src/renderer/features/a/sibling.ts',
    "import { x } from './util';\nexport const y = x;\n",
  );
  writePath(
    root,
    'src/renderer/features/b/use.ts',
    "import { x } from '@/features/a/util';\nexport const z = x;\n",
  );
  // vi.mock + dynamic import string args
  writePath(
    root,
    'src/renderer/features/c/c.test.ts',
    "import { vi } from 'vitest';\nvi.mock('@/features/a/util');\nexport const load = () => import('@/features/a/util');\n",
  );
  writePath(
    root,
    '.devkit/baselines/structure/renderer.mjs',
    'export const rendererStructureBaseline = [\n  "features/a/util.ts",\n  "features/a/util.test.ts",\n  "keep/other.ts"\n];\n',
  );
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  return root;
}

const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
const runMoveArgs = (cwd, ...args) =>
  testSpawnSync(process.execPath, [CLI, 'move', ...args], { cwd, encoding: 'utf8' });
// A readiness wait, not a speed assertion: tsconfig is now read and walked before the first git call.
const waitForPath = async (path) => {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
};

describe('devkit move', () => {
  it('relocates a file and rewrites all references in their own style + prunes baseline', () => {
    const root = fixture();
    execFileSync(
      process.execPath,
      [CLI, 'move', 'src/renderer/features/a/util.ts', 'src/renderer/lib/utils'],
      {
        cwd: root,
        stdio: 'pipe',
      },
    );

    // file moved (+ colocated test moved with it)
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.test.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/features/a/util.ts'))).toBe(false);

    // alias importer rewritten
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
    expect(read(root, 'src/renderer/features/b/use.ts')).not.toContain('@/features/a/util');

    // relative importer stays relative, re-pointed at the new home
    expect(read(root, 'src/renderer/features/a/sibling.ts')).toContain("'../../lib/utils/util'");
    expect(read(root, 'src/renderer/features/a/sibling.ts')).not.toContain("'./util'");

    // moved file's OWN relative import re-anchored, still relative (helper stayed put)
    expect(read(root, 'src/renderer/lib/utils/util.ts')).toContain("'../../features/a/helper'");
    // the test sibling moved WITH util, so its './util' is still right and must not churn
    expect(read(root, 'src/renderer/lib/utils/util.test.ts')).toContain("from './util'");

    // vi.mock + dynamic import() string args rewritten
    const cTest = read(root, 'src/renderer/features/c/c.test.ts');
    expect(cTest).toContain("vi.mock('@/lib/utils/util')");
    expect(cTest).toContain("import('@/lib/utils/util')");
    expect(cTest).not.toContain('@/features/a/util');

    // baseline pruned (moved entries gone, unrelated kept)
    const baseline = read(root, '.devkit/baselines/structure/renderer.mjs');
    expect(baseline).not.toContain('features/a/util.ts');
    expect(baseline).not.toContain('features/a/util.test.ts');
    expect(baseline).toContain('keep/other.ts');
  });

  it('prunes a non-electron (config-driven) baseline using guard.config.json roots', () => {
    // Layout-agnostic: a consumer whose structure.trees declare an `app/` root must still
    // get its baseline pruned — the prune now follows guard.config.json, not the electron literal.
    const root = mkTmp('move-app-');
    writePath(
      root,
      'package.json',
      JSON.stringify({ name: 'fx', version: '0.0.0', type: 'module' }),
    );
    writePath(
      root,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./app/*'] } }, include: ['app'] }),
    );
    writePath(
      root,
      'guard.config.json',
      JSON.stringify({ scanRoots: ['app'], structure: { trees: [{ name: 'app', root: 'app' }] } }),
    );
    writePath(root, 'app/foo.ts', 'export const x = 1;\n');
    writePath(root, 'app/use.ts', "import { x } from '@/foo';\nexport const z = x;\n");
    writePath(
      root,
      '.devkit/baselines/structure/app.mjs',
      'export const appStructureBaseline = [\n  "foo.ts",\n  "keep/other.ts"\n];\n',
    );
    git(root, 'init', '-q');
    git(root, 'add', '-A');

    execFileSync(process.execPath, [CLI, 'move', 'app/foo.ts', 'app/sub'], {
      cwd: root,
      stdio: 'pipe',
    });

    expect(existsSync(join(root, 'app/sub/foo.ts'))).toBe(true);
    const baseline = read(root, '.devkit/baselines/structure/app.mjs');
    expect(baseline).not.toContain('"foo.ts"'); // moved entry pruned
    expect(baseline).toContain('keep/other.ts'); // unrelated entry kept
  });

  it('--dry-run previews without touching files', () => {
    const root = fixture();
    execFileSync(
      process.execPath,
      [CLI, 'move', 'src/renderer/features/a/util.ts', 'src/renderer/lib/utils', '--dry-run'],
      {
        cwd: root,
        stdio: 'pipe',
      },
    );
    expect(existsSync(join(root, 'src/renderer/features/a/util.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.ts'))).toBe(false);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain('@/features/a/util');
  });
});

describe('devkit move — directory and untracked sources', () => {
  it('moves a wholly untracked directory and rewrites its internal and external imports', () => {
    const root = fixture();
    writePath(
      root,
      'src/renderer/features/new-rules/rule.ts',
      "import { shared } from './shared';\nexport const rule = shared;\n",
    );
    writePath(root, 'src/renderer/features/new-rules/shared.ts', 'export const shared = 1;\n');
    writePath(
      root,
      'src/renderer/features/b/use.ts',
      "import { rule } from '@/features/new-rules/rule';\nexport const z = rule;\n",
    );
    const indexBefore = git(root, 'ls-files', '-s').toString();

    const r = runMoveArgs(root, 'src/renderer/features/new-rules', 'src/renderer/lib');

    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'src/renderer/features/new-rules'))).toBe(false);
    expect(existsSync(join(root, 'src/renderer/lib/new-rules/rule.ts'))).toBe(true);
    expect(read(root, 'src/renderer/lib/new-rules/rule.ts')).toContain("'./shared'");
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/new-rules/rule'");
    expect(git(root, 'ls-files', '--', 'src/renderer/lib/new-rules').toString()).toBe('');
    expect(git(root, 'ls-files', '-s').toString()).toBe(indexBefore);
  });

  it('leaves a leaf added while Git starts moving its directory resolving in place', () => {
    const root = fixture();
    const source = join(root, 'src/renderer/features/new-rules');
    writePath(root, 'src/renderer/features/new-rules/rule.ts', 'export const rule = 1;\n');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writePath(
      root,
      'bin/git',
      '#!/bin/sh\nif [ "$1" = "mv" ]; then\n  printf "%s\\n" "import { rule } from \'./rule\';" "export const late = rule;" > "$DEVKIT_MOVE_RACE_SOURCE/late.ts"\nfi\nexec "$DEVKIT_MOVE_REAL_GIT" "$@"\n',
    );
    chmodSync(join(root, 'bin/git'), 0o755);

    const r = testSpawnSync(
      process.execPath,
      [CLI, 'move', 'src/renderer/features/new-rules', 'src/renderer/lib'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEVKIT_MOVE_RACE_SOURCE: source,
          DEVKIT_MOVE_REAL_GIT: realGit,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        },
      },
    );

    expect(r.status, r.stderr).toBe(0);
    // never planned (it did not exist yet), but its sibling-relative import still resolves
    expect(read(root, 'src/renderer/lib/new-rules/late.ts')).toContain("'./rule'");
  });

  it('rejects an index-only destination without changing the source or index', () => {
    const root = fixture();
    writePath(root, 'src/renderer/lib/new-rules/claimed.ts', 'export const claimed = 1;\n');
    git(root, 'add', 'src/renderer/lib/new-rules/claimed.ts');
    rmSync(join(root, 'src/renderer/lib/new-rules'), { recursive: true });
    writePath(root, 'src/renderer/features/new-rules/rule.ts', 'export const rule = 1;\n');
    const indexBefore = git(root, 'ls-files', '-s').toString();

    const r = runMoveArgs(root, 'src/renderer/features/new-rules', 'src/renderer/lib');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/destination exists in the Git index/);
    expect(existsSync(join(root, 'src/renderer/features/new-rules/rule.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib/new-rules'))).toBe(false);
    expect(git(root, 'ls-files', '-s').toString()).toBe(indexBefore);
  });

  it('checks the real index when the caller supplies a custom Git index', () => {
    const root = fixture();
    writePath(root, 'src/renderer/lib/new-rules/claimed.ts', 'export const claimed = 1;\n');
    git(root, 'add', 'src/renderer/lib/new-rules/claimed.ts');
    rmSync(join(root, 'src/renderer/lib/new-rules'), { recursive: true });
    writePath(root, 'src/renderer/features/new-rules/rule.ts', 'export const rule = 1;\n');
    const customIndex = join(root, 'custom-index');
    execFileSync('git', ['read-tree', '--empty'], {
      cwd: root,
      env: { ...process.env, GIT_INDEX_FILE: customIndex },
    });

    const r = testSpawnSync(
      process.execPath,
      [CLI, 'move', 'src/renderer/features/new-rules', 'src/renderer/lib'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GIT_INDEX_FILE: customIndex },
      },
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/destination exists in the Git index/);
    expect(existsSync(join(root, 'src/renderer/features/new-rules/rule.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib/new-rules'))).toBe(false);
    expect(git(root, 'ls-files', '-s').toString()).toContain('claimed.ts');
  });

  it('moves a tracked source through the real index when the caller supplies a custom one', () => {
    const root = fixture();
    const customIndex = join(root, 'custom-index');
    const customEnv = { ...process.env, GIT_INDEX_FILE: customIndex };
    execFileSync('git', ['read-tree', '--empty'], { cwd: root, env: customEnv });

    const r = testSpawnSync(
      process.execPath,
      [CLI, 'move', 'src/renderer/features/a', 'src/renderer/lib'],
      {
        cwd: root,
        encoding: 'utf8',
        env: customEnv,
      },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(git(root, 'ls-files', '--', 'src/renderer/features/a').toString()).toBe('');
    expect(git(root, 'ls-files', '--', 'src/renderer/lib/a').toString()).toContain('util.ts');
    expect(execFileSync('git', ['ls-files'], { cwd: root, env: customEnv, encoding: 'utf8' })).toBe(
      '',
    );
  });

  it('rejects a destination beneath an index-only file ancestor', () => {
    const root = fixture();
    writePath(root, 'src/renderer/lib', 'tracked file blocks the destination directory\n');
    git(root, 'add', 'src/renderer/lib');
    rmSync(join(root, 'src/renderer/lib'));
    writePath(root, 'src/renderer/features/new-rules/rule.ts', 'export const rule = 1;\n');
    const indexBefore = git(root, 'ls-files', '-s').toString();

    const r = runMoveArgs(root, 'src/renderer/features/new-rules', 'src/renderer/lib');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/destination exists in the Git index/);
    expect(existsSync(join(root, 'src/renderer/features/new-rules/rule.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib'))).toBe(false);
    expect(git(root, 'ls-files', '-s').toString()).toBe(indexBefore);
  });

  it('moves an untracked source in a repository that has no index yet', () => {
    const root = mkTmp('move-unborn-');
    writePath(root, 'package.json', JSON.stringify({ name: 'unborn', type: 'module' }));
    writePath(root, 'tsconfig.json', DEFAULT_TSCONFIG);
    writePath(root, 'src/renderer/new/value.ts', 'export const value = 1;\n');
    git(root, 'init', '-q');

    const r = runMoveArgs(root, 'src/renderer/new', 'src/renderer/lib');

    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'src/renderer/new'))).toBe(false);
    expect(read(root, 'src/renderer/lib/new/value.ts')).toBe('export const value = 1;\n');
    expect(git(root, 'ls-files').toString()).toBe('');
  });

  it('leaves the source untouched when the real Git index is busy', () => {
    const root = fixture();
    writePath(root, 'src/renderer/features/new-rules/rule.ts', 'export const rule = 1;\n');
    writeFileSync(join(root, '.git/index.lock'), 'busy');

    const r = runMoveArgs(root, 'src/renderer/features/new-rules', 'src/renderer/lib');

    expect(r.status).toBe(1);
    expect(existsSync(join(root, 'src/renderer/features/new-rules/rule.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib/new-rules'))).toBe(false);
    expect(read(root, '.git/index.lock')).toBe('busy');
  });

  it('rejects a source-parent replacement during locked identity validation', () => {
    const root = fixture();
    const outside = mkTmp('move-source-race-');
    const sourceParent = join(root, 'src/renderer/features');
    const originalParent = join(root, 'src/renderer/features-original');
    writePath(root, 'src/renderer/features/new-rules/rule.ts', 'export const rule = 1;\n');
    writePath(outside, 'new-rules/external.ts', 'export const external = 1;\n');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writePath(
      root,
      'bin/git',
      '#!/bin/sh\nif [ "$1" = "ls-files" ]; then\n  count=0\n  [ -f "$DEVKIT_MOVE_RACE_COUNT" ] && count=$(cat "$DEVKIT_MOVE_RACE_COUNT")\n  count=$((count + 1))\n  printf "%s" "$count" > "$DEVKIT_MOVE_RACE_COUNT"\n  if [ "$count" = "2" ]; then\n    "$DEVKIT_MOVE_REAL_GIT" "$@"\n    result=$?\n    mv "$DEVKIT_MOVE_RACE_PARENT" "$DEVKIT_MOVE_RACE_ORIGINAL"\n    ln -s "$DEVKIT_MOVE_RACE_OUTSIDE" "$DEVKIT_MOVE_RACE_PARENT"\n    exit "$result"\n  fi\nfi\nexec "$DEVKIT_MOVE_REAL_GIT" "$@"\n',
    );
    chmodSync(join(root, 'bin/git'), 0o755);

    const r = testSpawnSync(
      process.execPath,
      [CLI, 'move', 'src/renderer/features/new-rules', 'src/renderer/lib'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEVKIT_MOVE_RACE_COUNT: join(root, 'git-ls-files-count'),
          DEVKIT_MOVE_RACE_ORIGINAL: originalParent,
          DEVKIT_MOVE_RACE_OUTSIDE: outside,
          DEVKIT_MOVE_RACE_PARENT: sourceParent,
          DEVKIT_MOVE_REAL_GIT: realGit,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        },
      },
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/source changed during move; retry/);
    expect(lstatSync(sourceParent).isSymbolicLink()).toBe(true);
    expect(read(outside, 'new-rules/external.ts')).toBe('export const external = 1;\n');
    expect(readdirSync(join(outside, 'new-rules'))).toEqual(['external.ts']);
    expect(read(originalParent, 'new-rules/rule.ts')).toBe('export const rule = 1;\n');
    expect(existsSync(join(root, 'src/renderer/lib/new-rules'))).toBe(false);
    expect(existsSync(join(root, '.git/index.lock'))).toBe(false);
  });

  it('rejects a source-parent replacement that occurs during temporary-index staging', () => {
    const root = fixture();
    const outside = mkTmp('move-source-add-race-');
    const sourceParent = join(root, 'src/renderer/features');
    const originalParent = join(root, 'src/renderer/features-original');
    writePath(root, 'src/renderer/features/new-rules/rule.ts', 'export const rule = 1;\n');
    writePath(outside, 'new-rules/external.ts', 'export const external = 1;\n');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writePath(
      root,
      'bin/git',
      '#!/bin/sh\nif [ "$1" = "add" ]; then\n  "$DEVKIT_MOVE_REAL_GIT" "$@"\n  result=$?\n  mv "$DEVKIT_MOVE_RACE_PARENT" "$DEVKIT_MOVE_RACE_ORIGINAL"\n  ln -s "$DEVKIT_MOVE_RACE_OUTSIDE" "$DEVKIT_MOVE_RACE_PARENT"\n  exit "$result"\nfi\nexec "$DEVKIT_MOVE_REAL_GIT" "$@"\n',
    );
    chmodSync(join(root, 'bin/git'), 0o755);

    const r = testSpawnSync(
      process.execPath,
      [CLI, 'move', 'src/renderer/features/new-rules', 'src/renderer/lib'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEVKIT_MOVE_RACE_ORIGINAL: originalParent,
          DEVKIT_MOVE_RACE_OUTSIDE: outside,
          DEVKIT_MOVE_RACE_PARENT: sourceParent,
          DEVKIT_MOVE_REAL_GIT: realGit,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        },
      },
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/source changed during move; retry/);
    expect(lstatSync(sourceParent).isSymbolicLink()).toBe(true);
    expect(readdirSync(join(outside, 'new-rules'))).toEqual(['external.ts']);
    expect(readdirSync(join(originalParent, 'new-rules'))).toEqual(['rule.ts']);
    expect(existsSync(join(root, 'src/renderer/lib/new-rules'))).toBe(false);
    expect(existsSync(join(root, '.git/index.lock'))).toBe(false);
    expect(
      readdirSync(join(root, '.git')).some((name) => name.startsWith('devkit-move-index-')),
    ).toBe(false);
  });

  it('aborts rewrites when the source parent is replaced as Git starts the move', () => {
    const root = fixture();
    const outside = mkTmp('move-source-mv-race-');
    const sourceParent = join(root, 'src/renderer/features');
    const originalParent = join(root, 'src/renderer/features-original');
    writePath(root, 'src/renderer/features/new-rules/rule.ts', 'export const original = 1;\n');
    writePath(outside, 'new-rules/rule.ts', 'export const external = 1;\n');
    writePath(
      root,
      'src/renderer/features/b/use.ts',
      "import { original } from '@/features/new-rules/rule';\nexport const z = original;\n",
    );
    const importerBefore = read(root, 'src/renderer/features/b/use.ts');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writePath(
      root,
      'bin/git',
      '#!/bin/sh\nif [ "$1" = "mv" ]; then\n  mv "$DEVKIT_MOVE_RACE_PARENT" "$DEVKIT_MOVE_RACE_ORIGINAL"\n  ln -s "$DEVKIT_MOVE_RACE_OUTSIDE" "$DEVKIT_MOVE_RACE_PARENT"\nfi\nexec "$DEVKIT_MOVE_REAL_GIT" "$@"\n',
    );
    chmodSync(join(root, 'bin/git'), 0o755);

    const r = testSpawnSync(
      process.execPath,
      [CLI, 'move', 'src/renderer/features/new-rules', 'src/renderer/lib'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEVKIT_MOVE_RACE_ORIGINAL: originalParent,
          DEVKIT_MOVE_RACE_OUTSIDE: outside,
          DEVKIT_MOVE_RACE_PARENT: sourceParent,
          DEVKIT_MOVE_REAL_GIT: realGit,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        },
      },
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/source changed during move; imports were not rewritten/);
    expect(read(originalParent, 'new-rules/rule.ts')).toBe('export const original = 1;\n');
    expect(read(root, 'src/renderer/lib/new-rules/rule.ts')).toBe('export const external = 1;\n');
    expect(read(originalParent, 'b/use.ts')).toBe(importerBefore);
    expect(existsSync(join(outside, 'new-rules'))).toBe(false);
    expect(existsSync(join(root, '.git/index.lock'))).toBe(false);
  });

  it('cleans the index lock and temporary index when interrupted', async () => {
    const root = fixture();
    writePath(root, 'src/renderer/features/new-rules/rule.ts', 'export const rule = 1;\n');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const ready = join(root, 'git-add-ready');
    writePath(
      root,
      'bin/git',
      '#!/bin/sh\nif [ "$1" = "add" ]; then touch "$DEVKIT_MOVE_SIGNAL_READY"; sleep 30; fi\nexec "$DEVKIT_MOVE_REAL_GIT" "$@"\n',
    );
    chmodSync(join(root, 'bin/git'), 0o755);
    const child = spawn(
      process.execPath,
      [CLI, 'move', 'src/renderer/features/new-rules', 'src/renderer/lib'],
      {
        cwd: root,
        detached: true,
        env: {
          ...process.env,
          DEVKIT_MOVE_REAL_GIT: realGit,
          DEVKIT_MOVE_SIGNAL_READY: ready,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        },
        stdio: 'ignore',
      },
    );

    await waitForPath(ready);
    if (!child.pid) throw new Error('move child did not start');
    const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
    process.kill(-child.pid, 'SIGTERM');
    await exited;

    expect(existsSync(join(root, '.git/index.lock'))).toBe(false);
    expect(
      readdirSync(join(root, '.git')).some((name) => name.startsWith('devkit-move-index-')),
    ).toBe(false);
    expect(
      readdirSync(join(root, 'src/renderer/features/new-rules')).some((name) =>
        name.startsWith('.devkit-move-'),
      ),
    ).toBe(false);
  });

  it('rejects an empty untracked directory without creating temporary filesystem state', () => {
    const root = fixture();
    mkdirSync(join(root, 'src/renderer/features/empty-rules'));

    const r = runMoveArgs(root, 'src/renderer/features/empty-rules', 'src/renderer/lib');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/cannot move an empty untracked directory safely/);
    expect(existsSync(join(root, 'src/renderer/features/empty-rules'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib/empty-rules'))).toBe(false);
    expect(existsSync(join(root, '.git/index.lock'))).toBe(false);
  });

  it('reports the exact source location if the destination becomes a directory during the move', () => {
    const root = fixture();
    writePath(root, 'src/renderer/features/new-rules/rule.ts', 'export const rule = 1;\n');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const target = join(root, 'src/renderer/lib/new-rules');
    writePath(
      root,
      'bin/git',
      '#!/bin/sh\nif [ "$1" = "mv" ]; then mkdir -p "$DEVKIT_MOVE_RACE_TARGET"; fi\nexec "$DEVKIT_MOVE_REAL_GIT" "$@"\n',
    );
    chmodSync(join(root, 'bin/git'), 0o755);

    const r = testSpawnSync(
      process.execPath,
      [CLI, 'move', 'src/renderer/features/new-rules', 'src/renderer/lib'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEVKIT_MOVE_RACE_TARGET: target,
          DEVKIT_MOVE_REAL_GIT: realGit,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        },
      },
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /destination changed during move; source is at .*new-rules\/new-rules; imports were not rewritten/,
    );
    expect(existsSync(join(root, 'src/renderer/features/new-rules'))).toBe(false);
    expect(existsSync(join(target, 'new-rules/rule.ts'))).toBe(true);
    expect(git(root, 'status', '--short').toString()).not.toContain('.devkit-move-');
  });

  it('aborts rewrites if a tracked move is nested into a raced destination directory', () => {
    const root = fixture();
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const target = join(root, 'src/renderer/lib/a');
    const importerBefore = read(root, 'src/renderer/features/b/use.ts');
    writePath(
      root,
      'bin/git',
      '#!/bin/sh\nif [ "$1" = "mv" ]; then mkdir -p "$DEVKIT_MOVE_RACE_TARGET"; fi\nexec "$DEVKIT_MOVE_REAL_GIT" "$@"\n',
    );
    chmodSync(join(root, 'bin/git'), 0o755);

    const r = testSpawnSync(
      process.execPath,
      [CLI, 'move', 'src/renderer/features/a', 'src/renderer/lib'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEVKIT_MOVE_RACE_TARGET: target,
          DEVKIT_MOVE_REAL_GIT: realGit,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        },
      },
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /destination changed during move; source is at .*lib\/a\/a; imports were not rewritten/,
    );
    expect(existsSync(join(root, 'src/renderer/features/a'))).toBe(false);
    expect(existsSync(join(root, 'src/renderer/lib/a/a/util.ts'))).toBe(true);
    expect(read(root, 'src/renderer/features/b/use.ts')).toBe(importerBefore);
  });

  it('aborts rewrites if the destination parent becomes an external symlink during the move', () => {
    const root = fixture();
    const outside = mkTmp('move-parent-race-');
    writePath(root, 'src/renderer/features/new-rules/rule.ts', 'export const rule = 1;\n');
    writePath(
      root,
      'src/renderer/features/b/use.ts',
      "import { rule } from '@/features/new-rules/rule';\nexport const z = rule;\n",
    );
    const importerBefore = read(root, 'src/renderer/features/b/use.ts');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const parent = join(root, 'src/renderer/lib');
    writePath(
      root,
      'bin/git',
      '#!/bin/sh\nif [ "$1" = "mv" ]; then rmdir "$DEVKIT_MOVE_RACE_PARENT" && ln -s "$DEVKIT_MOVE_RACE_OUTSIDE" "$DEVKIT_MOVE_RACE_PARENT"; fi\nexec "$DEVKIT_MOVE_REAL_GIT" "$@"\n',
    );
    chmodSync(join(root, 'bin/git'), 0o755);

    const r = testSpawnSync(
      process.execPath,
      [CLI, 'move', 'src/renderer/features/new-rules', 'src/renderer/lib'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEVKIT_MOVE_RACE_OUTSIDE: outside,
          DEVKIT_MOVE_RACE_PARENT: parent,
          DEVKIT_MOVE_REAL_GIT: realGit,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        },
      },
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /destination changed during move; source is at .*imports were not rewritten/,
    );
    expect(lstatSync(parent).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, 'new-rules/rule.ts'))).toBe(true);
    expect(read(root, 'src/renderer/features/b/use.ts')).toBe(importerBefore);
  });

  it('keeps a tracked directory Git-aware while rewriting descendant module paths', () => {
    const root = fixture();
    writePath(root, '.gitignore', 'src/renderer/features/a/ignored.txt\n');
    writePath(root, 'src/renderer/features/a/draft.txt', 'untracked\n');
    writePath(root, 'src/renderer/features/a/ignored.txt', 'ignored\n');
    mkdirSync(join(root, 'src/renderer/features/a/empty'));
    const r = runMoveArgs(root, 'src/renderer/features/a', 'src/renderer/lib');

    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'src/renderer/features/a'))).toBe(false);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/a/util'");
    expect(read(root, 'src/renderer/lib/a/util.ts')).toContain("'./helper'");
    const tracked = git(root, 'ls-files', '--', 'src/renderer/lib/a').toString();
    expect(tracked).toContain('src/renderer/lib/a/util.ts');
    expect(tracked).toContain('src/renderer/lib/a/util.test.ts');
    expect(read(root, 'src/renderer/lib/a/draft.txt')).toBe('untracked\n');
    expect(read(root, 'src/renderer/lib/a/ignored.txt')).toBe('ignored\n');
    expect(existsSync(join(root, 'src/renderer/lib/a/empty'))).toBe(true);
  });

  it('preflights every collision before moving an earlier source', () => {
    const root = fixture();
    mkdirSync(join(root, 'src/renderer/lib/utils'), { recursive: true });
    symlinkSync('missing.ts', join(root, 'src/renderer/lib/utils/util.ts'));
    const importerBefore = read(root, 'src/renderer/features/b/use.ts');
    const baselineBefore = read(root, '.devkit/baselines/structure/renderer.mjs');

    const r = runMoveArgs(
      root,
      'src/renderer/features/a/helper.ts',
      'src/renderer/features/a/util.ts',
      'src/renderer/lib/utils',
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/destination already exists.*util\.ts/);
    expect(r.stdout).not.toContain('mv ');
    expect(existsSync(join(root, 'src/renderer/features/a/helper.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib/utils/helper.ts'))).toBe(false);
    expect(lstatSync(join(root, 'src/renderer/lib/utils/util.ts')).isSymbolicLink()).toBe(true);
    expect(read(root, 'src/renderer/features/b/use.ts')).toBe(importerBefore);
    expect(read(root, '.devkit/baselines/structure/renderer.mjs')).toBe(baselineBefore);
  });

  it('rejects a destination nested inside its source before creating it', () => {
    const root = fixture();
    const r = runMoveArgs(root, 'src/renderer/features/a', 'src/renderer/features/a/generated');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/destination cannot be inside source/);
    expect(r.stdout).not.toContain('mv ');
    expect(existsSync(join(root, 'src/renderer/features/a/generated'))).toBe(false);
    expect(existsSync(join(root, 'src/renderer/features/a/util.ts'))).toBe(true);
  });

  it('rejects overlapping sources before moving their shared tree', () => {
    const root = fixture();
    const importerBefore = read(root, 'src/renderer/features/b/use.ts');

    const r = runMoveArgs(
      root,
      'src/renderer/features/a',
      'src/renderer/features/a/util.ts',
      'src/renderer/lib',
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/sources overlap/);
    expect(r.stdout).not.toContain('mv ');
    expect(existsSync(join(root, 'src/renderer/features/a/util.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib/a'))).toBe(false);
    expect(existsSync(join(root, 'src/renderer/lib/util.ts'))).toBe(false);
    expect(read(root, 'src/renderer/features/b/use.ts')).toBe(importerBefore);
  });

  it('rejects a source whose canonical parent escapes the worktree', () => {
    const root = fixture();
    const outside = mkTmp('move-outside-');
    writePath(outside, 'source.ts', 'export const outside = 1;\n');
    symlinkSync(outside, join(root, 'src/renderer/linked'));

    const r = runMoveArgs(root, 'src/renderer/linked/source.ts', 'src/renderer/lib');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/source resolves outside the Git worktree/);
    expect(r.stdout).not.toContain('mv ');
    expect(read(outside, 'source.ts')).toBe('export const outside = 1;\n');
  });

  it('rejects a tracked source reached through a symlinked parent', () => {
    const root = fixture();
    symlinkSync('a', join(root, 'src/renderer/features/alias-a'));

    const r = runMoveArgs(root, 'src/renderer/features/alias-a/util.ts', 'src/renderer/lib/utils');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/source traverses a symlinked directory/);
    expect(r.stdout).not.toContain('mv ');
    expect(existsSync(join(root, 'src/renderer/features/a/util.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.ts'))).toBe(false);
    expect(git(root, 'ls-files', '--', 'src/renderer/features/a/util.ts').toString()).toContain(
      'src/renderer/features/a/util.ts',
    );
  });

  it('rejects a destination whose symlinked parent resolves inside the source', () => {
    const root = fixture();
    symlinkSync('a', join(root, 'src/renderer/features/alias-a'));

    const r = runMoveArgs(
      root,
      'src/renderer/features/a',
      'src/renderer/features/alias-a/generated',
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/destination traverses a symlinked directory/);
    expect(r.stdout).not.toContain('mv ');
    expect(existsSync(join(root, 'src/renderer/features/a/generated'))).toBe(false);
    expect(existsSync(join(root, 'src/renderer/features/a/util.ts'))).toBe(true);
  });

  it('keeps a nested repository opaque to the outer AST rewrite', () => {
    const root = fixture();
    writePath(root, 'src/renderer/features/package/outer.ts', 'export const outer = 1;\n');
    writePath(
      root,
      'src/renderer/features/package/nested/inner.ts',
      "import { outer } from '@/features/package/outer';\nexport const inner = outer;\n",
    );
    writePath(root, 'src/renderer/features/package/nested/.git/HEAD', 'ref: refs/heads/main\n');
    const nestedBefore = read(root, 'src/renderer/features/package/nested/inner.ts');

    const r = runMoveArgs(root, 'src/renderer/features/package', 'src/renderer/lib');

    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/lib/package/nested/inner.ts')).toBe(nestedBefore);
    expect(existsSync(join(root, 'src/renderer/lib/package/nested/.git/HEAD'))).toBe(true);
  });

  it('keeps an unrelated nested repository opaque to the outer AST rewrite', () => {
    const root = fixture();
    writePath(
      root,
      'src/renderer/vendor/nested.ts',
      "import { x } from '@/features/a/util';\nexport const nested = x;\n",
    );
    writePath(root, 'src/renderer/vendor/.git/HEAD', 'ref: refs/heads/main\n');
    const nestedBefore = read(root, 'src/renderer/vendor/nested.ts');

    const r = runMoveArgs(root, 'src/renderer/features/a/util.ts', 'src/renderer/lib/utils');

    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/vendor/nested.ts')).toBe(nestedBefore);
  });

  it('moves a TypeScript symlink without writing through to its external referent', () => {
    const root = fixture();
    const outside = mkTmp('move-symlink-target-');
    const referent = "import { dep } from './dep';\nexport const linked = dep;\n";
    writePath(outside, 'target.ts', referent);
    writePath(outside, 'dep.ts', 'export const dep = 1;\n');
    symlinkSync(join(outside, 'target.ts'), join(root, 'src/renderer/features/a/link.ts'));

    const r = runMoveArgs(root, 'src/renderer/features/a/link.ts', 'src/renderer/lib/utils');

    expect(r.status, r.stderr).toBe(0);
    expect(lstatSync(join(root, 'src/renderer/lib/utils/link.ts')).isSymbolicLink()).toBe(true);
    expect(read(outside, 'target.ts')).toBe(referent);
  });

  it('rejects the worktree root before previewing or creating a destination', () => {
    const root = fixture();
    const r = runMoveArgs(root, '.', 'generated');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Git worktree/);
    expect(r.stdout).not.toContain('mv ');
    expect(existsSync(join(root, 'generated'))).toBe(false);
    expect(existsSync(join(root, 'src/renderer/features/a/util.ts'))).toBe(true);
  });

  it('does not turn a non-repository cwd into a filesystem-only mover', () => {
    const root = mkTmp('move-no-git-');
    writePath(root, 'package.json', JSON.stringify({ name: 'no-git', type: 'module' }));
    writePath(root, 'tsconfig.json', DEFAULT_TSCONFIG);
    writePath(root, 'src/renderer/new/value.ts', 'export const value = 1;\n');

    const r = runMoveArgs(root, 'src/renderer/new', 'src/renderer/lib');

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not a git repository/);
    expect(r.stdout).not.toContain('mv ');
    expect(existsSync(join(root, 'src/renderer/new/value.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib/new'))).toBe(false);
  });

  it('normalizes tracked membership when invoked below the Git top-level', () => {
    const root = mkTmp('move-monorepo-');
    writePath(root, 'package.json', JSON.stringify({ name: 'root', private: true }));
    writePath(
      root,
      'packages/app/tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } }, include: ['src'] }),
    );
    writePath(root, 'packages/app/src/old/value.ts', 'export const value = 1;\n');
    git(root, 'init', '-q');
    git(root, 'add', '-A');

    const app = join(root, 'packages/app');
    const r = runMoveArgs(app, 'src/old/value.ts', 'src/new');

    expect(r.status, r.stderr).toBe(0);
    expect(git(root, 'ls-files', '--', 'packages/app/src/new/value.ts').toString()).toContain(
      'packages/app/src/new/value.ts',
    );
  });
});

// tsconfig is JSONC, not JSON. These fixtures are raw text because JSON.stringify can never
// emit the comment forms that broke the old regex stripper (sc-1713).
const JSONC_TSCONFIG = `{
  // devkit reads this through TypeScript's own config reader
  "//": "notes at https://example.dev/tsconfig — the // in this value must survive",
  "compilerOptions": {
    /* block comment */
    "paths": { "@/*": ["./src/renderer/*"] }, // trailing comment
  },
  "include": ["src"],
}
`;

const NO_ALIAS_TSCONFIG = `{
  "//": "devkit's own shape: a comment key holding https://, and no paths at all",
  "compilerOptions": { "strict": true },
  "include": ["src"]
}
`;

const MOVE_ARGS = ['move', 'src/renderer/features/a/util.ts', 'src/renderer/lib/utils'];
const runMove = (root, ...extra) =>
  testSpawnSync(process.execPath, [CLI, ...MOVE_ARGS, ...extra], { cwd: root, encoding: 'utf8' });

describe('devkit move — tsconfig reading', () => {
  it('reads a JSONC tsconfig with "//" comment keys, block comments and trailing commas', () => {
    const root = fixture(JSONC_TSCONFIG);
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/Bad control character|Unexpected token/);
    // the alias root came FROM the JSONC — not merely "nothing threw"
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
  });

  it('resolves paths declared by an extended base config in a subdirectory', () => {
    const root = fixture(JSON.stringify({ extends: './config/base.json', include: ['src'] }));
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(
      join(root, 'config/base.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['../src/renderer/*'] } } }),
    );
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    // '../src/renderer/*' is relative to config/, not to cwd
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
  });

  it('--dry-run previews a repo whose tsconfig declares no alias, counting the rewrites', () => {
    const root = fixture(NO_ALIAS_TSCONFIG);
    const r = runMove(root, '--dry-run');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('[dry] mv src/renderer/features/a/util.ts');
    // sibling + util's own helper import; the alias importers cannot resolve without paths
    expect(r.stdout).toMatch(/\[dry\] would rewrite 2 specifier\(s\)/);
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.ts'))).toBe(false);
  });

  it('moves a repo with no alias, keeping relative importers relative', () => {
    const root = fixture(NO_ALIAS_TSCONFIG);
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.ts'))).toBe(true);
    expect(read(root, 'src/renderer/features/a/sibling.ts')).toContain("'../../lib/utils/util'");
    expect(r.stderr).not.toMatch(/path alias found/);
  });

  it('a broken extends chain is diagnosed by name, not reported as a missing alias', () => {
    const root = fixture(JSON.stringify({ extends: './config/missing.json', include: ['src'] }));
    const r = runMove(root, '--dry-run');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing\.json/);
    expect(r.stderr).not.toMatch(/pass --alias/);
  });

  it('names the offending file when an extends target exists but is malformed', () => {
    const root = fixture(JSON.stringify({ extends: './config/broken.json', include: ['src'] }));
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config/broken.json'), '{ "compilerOptions": { oops }');
    const r = runMove(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/broken\.json/);
    expect(r.stderr).not.toMatch(/pass --alias/);
  });

  it('rejects --alias without a directory instead of failing inside path.resolve', () => {
    const r = runMove(fixture(), '--alias=@/');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--alias needs PREFIX=DIR/);
    expect(r.stderr).not.toMatch(/must be of type string/);
  });
});

const writeCfg = (root, rel, value) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), JSON.stringify(value));
};

describe('devkit move — tsconfig edge cases', () => {
  // --alias is the remedy the no-alias error names, so it has to work on the repos that hit it.
  it('--alias moves and rewrites in a repo whose tsconfig declares no paths', () => {
    const root = fixture(NO_ALIAS_TSCONFIG);
    const r = runMove(root, '--alias=@/=src/renderer');
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.ts'))).toBe(true);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
  });

  it('--alias makes --dry-run report a viable run in a repo with no paths', () => {
    const root = fixture(NO_ALIAS_TSCONFIG);
    const r = runMove(root, '--dry-run', '--alias=@/=src/renderer');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('[dry] mv src/renderer/features/a/util.ts');
    expect(r.stderr).not.toMatch(/path alias found/);
  });

  it('reports a missing tsconfig by name rather than leaking a raw ENOENT', () => {
    const root = fixture();
    rmSync(join(root, 'tsconfig.json'));
    const r = runMove(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/could not read tsconfig\.json/);
    expect(r.stderr).not.toMatch(/ENOENT/);
  });

  it('reports a syntactically broken tsconfig without leaking a JSON.parse error', () => {
    const root = fixture('{ "compilerOptions": { oops }');
    const r = runMove(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/could not read tsconfig\.json/);
    expect(r.stderr).not.toMatch(/Unexpected token|Bad control character/);
  });

  it('treats a paths key with an empty target list as no alias, not a crash', () => {
    const root = fixture(JSON.stringify({ compilerOptions: { paths: { '@/*': [] } } }));
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/Cannot read properties of undefined/);
    expect(read(root, 'src/renderer/features/a/sibling.ts')).toContain("'../../lib/utils/util'");
  });

  it('ignores exact-match paths keys, which name no directory to re-anchor under', () => {
    const root = fixture(
      JSON.stringify({ compilerOptions: { paths: { '@app': ['./src/renderer/app.ts'] } } }),
    );
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/a/sibling.ts')).toContain("'../../lib/utils/util'");
  });

  // --alias short-circuits tsconfig reading, but ts-morph still needs tsconfig to enumerate
  // sources. That check has to happen BEFORE git mv, or the tree is left half-moved.
  it('does not half-move the tree when --alias is given but tsconfig is missing', () => {
    const root = fixture();
    rmSync(join(root, 'tsconfig.json'));
    const r = runMove(root, '--alias=@/=src/renderer');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/could not read tsconfig\.json/);
    // nothing may be relocated when the run cannot finish rewriting importers
    expect(existsSync(join(root, 'src/renderer/features/a/util.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.ts'))).toBe(false);
    expect(r.stdout).not.toContain('mv ');
  });

  it('skips an empty target list and uses the next usable paths key', () => {
    const root = fixture(
      JSON.stringify({
        compilerOptions: { paths: { '@/*': [], '~/*': ['./src/renderer/*'] } },
        include: ['src'],
      }),
    );
    writePath(
      root,
      'src/renderer/features/d/tilde.ts',
      "import { x } from '~/features/a/util';\nexport const t = x;\n",
    );
    git(root, 'add', '-A');
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    // '~/' is the usable alias: an importer written with it stays '~/', relatives stay relative
    expect(read(root, 'src/renderer/features/a/sibling.ts')).toContain("'../../lib/utils/util'");
    expect(read(root, 'src/renderer/features/d/tilde.ts')).toContain("'~/lib/utils/util'");
  });

  it('resolves paths against baseUrl when baseUrl is declared', () => {
    const root = fixture(
      JSON.stringify({
        compilerOptions: { baseUrl: './src', paths: { '@/*': ['./renderer/*'] } },
        include: ['src'],
      }),
    );
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
  });

  it('follows an extends chain more than one hop deep', () => {
    const root = fixture(JSON.stringify({ extends: './config/mid.json', include: ['src'] }));
    writeCfg(root, 'config/mid.json', { extends: './deep/base.json' });
    writeCfg(root, 'config/deep/base.json', {
      compilerOptions: { paths: { '@/*': ['../../src/renderer/*'] } },
    });
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
  });

  it('accepts an extends array, where the last entry wins', () => {
    const root = fixture(
      JSON.stringify({ extends: ['./config/a.json', './config/b.json'], include: ['src'] }),
    );
    writeCfg(root, 'config/a.json', { compilerOptions: { strict: true } });
    writeCfg(root, 'config/b.json', {
      compilerOptions: { paths: { '@/*': ['../src/renderer/*'] } },
    });
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
  });

  // Editors on Windows routinely write a BOM; JSON.parse rejects one, ts.sys.readFile strips it.
  it('parses a tsconfig written with a UTF-8 BOM', () => {
    const root = fixture(
      `﻿${JSON.stringify({
        compilerOptions: { paths: { '@/*': ['./src/renderer/*'] } },
        include: ['src'],
      })}`,
    );
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
  });
});

describe('devkit move — outside the alias root', () => {
  // frink shape (sc-3016): `@/` → src/renderer, main-process code imports relatively. A move
  // inside src/main must never emit `@/../…` — that breaches the main/renderer import wall.
  function mainFixture() {
    const root = mkTmp('move-main-');
    writePath(
      root,
      'package.json',
      JSON.stringify({ name: 'fx', version: '0.0.0', type: 'module' }),
    );
    writePath(root, 'tsconfig.json', DEFAULT_TSCONFIG);
    writePath(root, 'src/shared/y.ts', 'export const y = 1;\n');
    writePath(
      root,
      'src/main/lib/a/x.ts',
      "import { y } from '../../../shared/y';\nexport const x = y;\n",
    );
    writePath(
      root,
      'src/main/lib/a/x.test.ts',
      "import { vi } from 'vitest';\nimport { x } from './x';\nvi.mock('./x');\nexport const load = () => import('./x');\nexport const t = x;\n",
    );
    writePath(
      root,
      'src/main/lib/b/importer.ts',
      "import { vi } from 'vitest';\nimport { x } from '../a/x';\nvi.mock('../a/x');\nexport const z = x;\n",
    );
    writePath(
      root,
      'src/renderer/features/r.ts',
      "import { x } from '../../main/lib/a/x';\nexport const r = x;\n",
    );
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    return root;
  }

  const aliasEscapes = (root) =>
    readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((rel) => rel.endsWith('.ts'))
      .filter((rel) => read(root, join('src', rel)).includes('@/../'));

  it('rewrites a main-process move with relative specifiers, never `@/../`', () => {
    const root = mainFixture();

    const r = runMoveArgs(root, 'src/main/lib/a/x.ts', 'src/main/lib/c');

    expect(r.status, r.stderr).toBe(0);
    const importer = read(root, 'src/main/lib/b/importer.ts');
    expect(importer).toContain("from '../c/x'");
    expect(importer).toContain("vi.mock('../c/x')");
    expect(read(root, 'src/main/lib/c/x.ts')).toContain("from '../../../shared/y'");
    const sibling = read(root, 'src/main/lib/c/x.test.ts');
    expect(sibling).toContain("from './x'");
    expect(sibling).toContain("vi.mock('./x')");
    expect(sibling).toContain("import('./x')");
    // renderer importer reaching a main-side target: the target is outside the root → relative
    expect(read(root, 'src/renderer/features/r.ts')).toContain("from '../../main/lib/c/x'");
    expect(aliasEscapes(root)).toEqual([]);
    // only changed specifiers count: importer ×2 + r.ts. x.ts → shared/y and the co-moved
    // sibling's './x' keep their text, so they are neither rewritten nor counted
    expect(r.stdout).toContain('rewrote 3 specifier(s)');
  });

  it('points co-moved main files at each other from their new directory', () => {
    const root = mainFixture();

    const r = runMoveArgs(
      root,
      'src/main/lib/a/x.ts',
      'src/main/lib/b/importer.ts',
      'src/main/lib/c',
    );

    expect(r.status, r.stderr).toBe(0);
    const importer = read(root, 'src/main/lib/c/importer.ts');
    expect(importer).toContain("from './x'");
    expect(importer).toContain("vi.mock('./x')");
    expect(aliasEscapes(root)).toEqual([]);
  });

  it('treats a sibling directory sharing the alias root name prefix as outside the root', () => {
    const root = mainFixture();
    writePath(root, 'src/renderer-legacy/old.ts', 'export const old = 1;\n');
    writePath(
      root,
      'src/renderer-legacy/use.ts',
      "import { old } from './old';\nexport const u = old;\n",
    );
    git(root, 'add', '-A');

    const r = runMoveArgs(root, 'src/renderer-legacy/old.ts', 'src/renderer-legacy/lib');

    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer-legacy/use.ts')).toContain("from './lib/old'");
    expect(aliasEscapes(root)).toEqual([]);
  });

  it('switches each specifier style when a file crosses into the alias root', () => {
    const root = mainFixture();

    const r = runMoveArgs(root, 'src/main/lib/a/x.ts', 'src/renderer/lib');

    expect(r.status, r.stderr).toBe(0);
    // renderer importer + target both under the root now → alias
    expect(read(root, 'src/renderer/features/r.ts')).toContain("from '@/lib/x'");
    // main importer is outside the root → relative to the new renderer home
    expect(read(root, 'src/main/lib/b/importer.ts')).toContain("from '../../../renderer/lib/x'");
    // the moved file's own import of src/shared is outside the root → relative from its new dir
    expect(read(root, 'src/renderer/lib/x.ts')).toContain("from '../../shared/y'");
    expect(aliasEscapes(root)).toEqual([]);
  });

  it('rewrites a main-side `@/` importer of a moved renderer file to a relative specifier', () => {
    const root = mainFixture();
    writePath(
      root,
      'src/main/lib/uses-r.ts',
      "import { r } from '@/features/r';\nexport const u = r;\n",
    );
    git(root, 'add', '-A');

    const r = runMoveArgs(root, 'src/renderer/features/r.ts', 'src/renderer/lib');

    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/main/lib/uses-r.ts')).toContain("from '../../renderer/lib/r'");
    // the moved renderer file's own main-side import is outside the root → relative, not `@/../`
    expect(read(root, 'src/renderer/lib/r.ts')).toContain("from '../../main/lib/a/x'");
    expect(aliasEscapes(root)).toEqual([]);
  });

  it('re-anchors a moved file’s own alias imports when it leaves the alias root', () => {
    const root = mainFixture();
    writePath(root, 'src/renderer/lib/y.ts', 'export const y = 1;\n');
    writePath(root, 'src/renderer/lib/z.ts', 'export const z = 1;\n');
    writePath(
      root,
      'src/renderer/a.ts',
      "import { y } from '@/lib/y';\nexport { z } from '@/lib/z';\nexport const a = y;\n",
    );
    git(root, 'add', '-A');

    const r = runMoveArgs(root, 'src/renderer/a.ts', 'src/main');

    expect(r.status, r.stderr).toBe(0);
    const moved = read(root, 'src/main/a.ts');
    expect(moved).toContain("from '../renderer/lib/y'");
    expect(moved).toContain("from '../renderer/lib/z'");
    expect(moved).not.toContain('@/');
  });

  it('leaves a moved file’s alias imports untouched while it stays inside the alias root', () => {
    const root = fixture();
    writePath(
      root,
      'src/renderer/features/a/util.ts',
      "import { helper } from '@/features/a/helper';\nexport const x = helper;\n",
    );
    git(root, 'add', '-A');

    const r = runMoveArgs(root, 'src/renderer/features/a/util.ts', 'src/renderer/lib/utils');

    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/lib/utils/util.ts')).toContain("from '@/features/a/helper'");
  });

  it('keeps an importer’s explicit /index when a same-named sibling module exists', () => {
    const root = mainFixture();
    writePath(root, 'src/main/lib/foo.mts', 'export const sibling = 1;\n');
    writePath(root, 'src/main/lib/foo/index.ts', 'export const idx = 1;\n');
    writePath(
      root,
      'src/main/lib/user.ts',
      "import { idx } from './foo/index';\nexport const u = idx;\n",
    );
    git(root, 'add', '-A');

    const r = runMoveArgs(root, 'src/main/lib/user.ts', 'src/main/app');

    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/main/app/user.ts')).toContain("from '../lib/foo/index'");
  });

  it('keeps an explicit /index segment rather than collapsing a relative specifier to `..`', () => {
    const root = mainFixture();
    writePath(root, 'src/main/lib/sub/index.ts', 'export const idx = 1;\n');
    writePath(
      root,
      'src/main/lib/sub/leaf.ts',
      "import { idx } from './index';\nexport const l = idx;\n",
    );
    git(root, 'add', '-A');

    const r = runMoveArgs(root, 'src/main/lib/sub/leaf.ts', 'src/main/lib/sub/deeper');

    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/main/lib/sub/deeper/leaf.ts')).toContain("from '../index'");
  });
});

// sc-1133: the frink layout that exposed the nesting + dangling-barrel bugs, reproduced as-is.
const STORY_DIR = 'src/renderer/features/agents/main/active-chat/components';
function storyFixture() {
  const root = mkTmp('move-story-');
  writePath(root, 'tsconfig.json', DEFAULT_TSCONFIG);
  writePath(root, 'src/renderer/lib/trpc.ts', 'export const trpc = 1;\n');
  writePath(
    root,
    'src/renderer/features/agents/AgentUserQuestion.ts',
    'export type AgentUserQuestion = string;\n',
  );
  writePath(
    root,
    `${STORY_DIR}/ParkedQuestionsBar/index.tsx`,
    "import { trpc } from '../../../../../../lib/trpc';\nimport type { AgentUserQuestion } from '../../../../AgentUserQuestion';\nexport const Bar = (q: AgentUserQuestion) => trpc + q.length;\n",
  );
  writePath(
    root,
    `${STORY_DIR}/ParkedQuestionsBar/index.test.tsx`,
    "import { vi } from 'vitest';\nvi.mock('../../../../../../lib/trpc', () => ({}));\nimport { Bar } from './index';\nexport const b = Bar;\n",
  );
  writePath(root, `${STORY_DIR}/index.ts`, "export * from './ParkedQuestionsBar';\n");
  writePath(
    root,
    'src/renderer/features/agents/use.ts',
    "import { Bar } from '@/features/agents/main/active-chat/components/ParkedQuestionsBar';\nexport const u = Bar;\n",
  );
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  return root;
}

describe('devkit move — renames (sc-1133)', () => {
  it('--rename renames a directory in place instead of nesting it, keeping every import resolving', () => {
    const root = storyFixture();
    const r = runMoveArgs(
      root,
      `${STORY_DIR}/ParkedQuestionsBar`,
      `${STORY_DIR}/ParkAnswerSurface`,
      '--rename',
    );

    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, `${STORY_DIR}/ParkAnswerSurface/index.tsx`))).toBe(true);
    expect(existsSync(join(root, `${STORY_DIR}/ParkAnswerSurface/ParkedQuestionsBar`))).toBe(false);
    expect(existsSync(join(root, `${STORY_DIR}/ParkedQuestionsBar`))).toBe(false);
    // the barrel keeps its sibling-relative style instead of a full alias path
    expect(read(root, `${STORY_DIR}/index.ts`)).toBe("export * from './ParkAnswerSurface';\n");
    expect(read(root, 'src/renderer/features/agents/use.ts')).toContain(
      "'@/features/agents/main/active-chat/components/ParkAnswerSurface'",
    );
    // same depth, so the moved files' own deep relatives are already right and must not churn
    const moved = read(root, `${STORY_DIR}/ParkAnswerSurface/index.tsx`);
    expect(moved).toContain("'../../../../../../lib/trpc'");
    expect(moved).toContain("'../../../../AgentUserQuestion'");
    expect(moved).not.toContain('@/features/lib');
    const movedTest = read(root, `${STORY_DIR}/ParkAnswerSurface/index.test.tsx`);
    expect(movedTest).toContain("vi.mock('../../../../../../lib/trpc'");
    expect(movedTest).toContain("from './index'");
  });

  it('moving a directory INTO a new parent rewrites implicit-index importers and deep relatives', () => {
    const root = storyFixture();
    const r = runMoveArgs(
      root,
      `${STORY_DIR}/ParkedQuestionsBar`,
      `${STORY_DIR}/ParkAnswerSurface`,
    );

    expect(r.status, r.stderr).toBe(0);
    expect(read(root, `${STORY_DIR}/index.ts`)).toBe(
      "export * from './ParkAnswerSurface/ParkedQuestionsBar';\n",
    );
    const moved = read(root, `${STORY_DIR}/ParkAnswerSurface/ParkedQuestionsBar/index.tsx`);
    // one level deeper now: each relative gains exactly one '../' and still names the same file
    expect(moved).toContain("'../../../../../../../lib/trpc'");
    expect(moved).toContain("'../../../../../AgentUserQuestion'");
    const movedTest = read(
      root,
      `${STORY_DIR}/ParkAnswerSurface/ParkedQuestionsBar/index.test.tsx`,
    );
    expect(movedTest).toContain("vi.mock('../../../../../../../lib/trpc'");
  });

  it('renames a file onto a destination that names a file, instead of nesting it', () => {
    const root = fixture();
    writePath(root, 'src/renderer/features/w/index.tsx', 'export const w = 1;\n');
    writePath(
      root,
      'src/renderer/features/w/index.test.tsx',
      "import { w } from './index';\nexport const t = w;\n",
    );
    writePath(
      root,
      'src/renderer/features/uses-w.ts',
      "import { w } from './w';\nexport const u = w;\n",
    );
    git(root, 'add', '-A');

    const r = runMoveArgs(
      root,
      'src/renderer/features/w/index.tsx',
      'src/renderer/features/v/index.tsx',
    );

    expect(r.status, r.stderr).toBe(0);
    expect(lstatSync(join(root, 'src/renderer/features/v/index.tsx')).isFile()).toBe(true);
    // the colocated test follows the renamed file, not the old basename
    expect(existsSync(join(root, 'src/renderer/features/v/index.test.tsx'))).toBe(true);
    expect(read(root, 'src/renderer/features/uses-w.ts')).toContain("from './v'");
  });

  it('renames a file to a new basename and carries its test sibling to the matching name', () => {
    const root = fixture();
    const r = runMoveArgs(root, 'src/renderer/features/a/util.ts', 'src/renderer/lib/strings.ts');

    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'src/renderer/lib/strings.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib/strings.test.ts'))).toBe(true);
    expect(read(root, 'src/renderer/lib/strings.test.ts')).toContain("from './strings'");
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/strings'");
    expect(read(root, 'src/renderer/features/c/c.test.ts')).toContain("vi.mock('@/lib/strings')");
  });

  it('rejects --rename with more than one source before moving anything', () => {
    const root = fixture();
    const r = runMoveArgs(
      root,
      'src/renderer/features/a/util.ts',
      'src/renderer/features/a/helper.ts',
      'src/renderer/lib',
      '--rename',
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/a rename takes exactly one source/);
    expect(existsSync(join(root, 'src/renderer/features/a/util.ts'))).toBe(true);
  });

  it('moves several sources INTO a destination whose name has an extension', () => {
    const root = fixture();
    const r = runMoveArgs(
      root,
      'src/renderer/features/a/util.ts',
      'src/renderer/features/a/helper.ts',
      'src/renderer/lib/archive.ts',
    );
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'src/renderer/lib/archive.ts/util.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib/archive.ts/helper.ts'))).toBe(true);
  });

  it('rejects --rename on a file, which is renamed by naming the new file instead', () => {
    const root = fixture();
    const r = runMoveArgs(root, 'src/renderer/features/a/util.ts', 'src/renderer/lib', '--rename');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--rename renames a directory/);
    expect(existsSync(join(root, 'src/renderer/lib'))).toBe(false);
  });

  it('refuses a rename onto an existing file without touching either side', () => {
    const root = fixture();
    const helperBefore = read(root, 'src/renderer/features/a/helper.ts');
    const r = runMoveArgs(
      root,
      'src/renderer/features/a/util.ts',
      'src/renderer/features/a/helper.ts',
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/destination already exists/);
    expect(read(root, 'src/renderer/features/a/helper.ts')).toBe(helperBefore);
    expect(existsSync(join(root, 'src/renderer/features/a/util.ts'))).toBe(true);
  });

  it('carries .mts / .cts / .js test siblings, not just .ts / .tsx', () => {
    const root = fixture();
    writePath(root, 'src/renderer/features/m/lib.mts', 'export const m = 1;\n');
    writePath(
      root,
      'src/renderer/features/m/lib.test.mts',
      "import { m } from './lib.mts';\nexport const t = m;\n",
    );
    writePath(root, 'src/renderer/features/m/cjs.cts', 'export const c = 1;\n');
    writePath(root, 'src/renderer/features/m/cjs.spec.cts', "import { c } from './cjs.cts';\n");
    git(root, 'add', '-A');

    const r = runMoveArgs(
      root,
      'src/renderer/features/m/lib.mts',
      'src/renderer/features/m/cjs.cts',
      'src/renderer/lib',
    );
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/lib/lib.test.mts')).toContain("'./lib.mts'");
    expect(existsSync(join(root, 'src/renderer/lib/cjs.spec.cts'))).toBe(true);
  });

  it('moves INTO a destination whose suffix only resembles a source extension', () => {
    const root = fixture();
    const r = runMoveArgs(root, 'src/renderer/features/a/util.ts', 'src/renderer/lib/archive.mtsx');
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'src/renderer/lib/archive.mtsx/util.ts'))).toBe(true);
  });

  it('moves INTO an existing directory even when its name looks like a file', () => {
    const root = fixture();
    mkdirSync(join(root, 'src/renderer/lib/odd.ts'), { recursive: true });
    const r = runMoveArgs(root, 'src/renderer/features/a/util.ts', 'src/renderer/lib/odd.ts');
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'src/renderer/lib/odd.ts/util.ts'))).toBe(true);
  });
});

describe('devkit move — specifier style and shapes', () => {
  it('keeps an explicit ".js" extension and an explicit "/index" as written', () => {
    const root = fixture();
    writePath(root, 'src/renderer/features/k/index.ts', 'export const k = 1;\n');
    writePath(
      root,
      'src/renderer/features/uses-k.ts',
      "import { k } from './k/index';\nimport { x } from './a/util.js';\nexport const u = k + x;\n",
    );
    git(root, 'add', '-A');

    const r = runMoveArgs(root, 'src/renderer/features/k', 'src/renderer/lib');
    expect(r.status, r.stderr).toBe(0);
    const uses = read(root, 'src/renderer/features/uses-k.ts');
    expect(uses).toContain("'../lib/k/index'");
    expect(uses).toContain("'./a/util.js'"); // untouched: util did not move

    const r2 = runMoveArgs(root, 'src/renderer/features/a/util.ts', 'src/renderer/lib/utils');
    expect(r2.status, r2.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/uses-k.ts')).toContain("'../lib/utils/util.js'");
  });

  it('rewrites .js-suffixed imports in a nodenext consumer, keeping the suffix', () => {
    const root = fixture(
      JSON.stringify({
        compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext' },
        include: ['src'],
      }),
    );
    writePath(
      root,
      'src/renderer/features/a/sibling.ts',
      "import { x } from './util.js';\nexport const y = x;\n",
    );
    writePath(
      root,
      'src/renderer/features/a/util.ts',
      "import { helper } from './helper.js';\nexport const x = helper;\n",
    );
    git(root, 'add', '-A');

    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/a/sibling.ts')).toContain("'../../lib/utils/util.js'");
    expect(read(root, 'src/renderer/lib/utils/util.ts')).toContain("'../../features/a/helper.js'");
  });

  it('rewrites a relative vi.mock and a require() in a .ts file, which TypeScript leaves alone', () => {
    const root = fixture();
    writePath(
      root,
      'src/renderer/features/a/mocks.test.ts',
      "import { vi } from 'vitest';\nvi.mock('./util');\nconst u = require('./util');\nexport const m = u;\n",
    );
    git(root, 'add', '-A');

    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    const mocks = read(root, 'src/renderer/features/a/mocks.test.ts');
    expect(mocks).toContain("vi.mock('../../lib/utils/util')");
    expect(mocks).toContain("require('../../lib/utils/util')");
  });

  it('follows an import of a file tsconfig does not include when the importer moves', () => {
    const root = fixture(
      JSON.stringify({
        compilerOptions: { paths: { '@/*': ['./src/renderer/*'] } },
        include: ['src'],
        exclude: ['src/renderer/features/a/helper.ts'],
      }),
    );
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/lib/utils/util.ts')).toContain("'../../features/a/helper'");
  });

  it('rewrites a static template-literal vi.mock argument', () => {
    const root = fixture();
    writePath(
      root,
      'src/renderer/features/a/tpl.test.ts',
      "import { vi } from 'vitest';\nvi.mock(`./util`);\n",
    );
    git(root, 'add', '-A');

    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/a/tpl.test.ts')).toContain(
      'vi.mock(`../../lib/utils/util`)',
    );
  });

  it('keeps a UTF-8 BOM on an importer it rewrites', () => {
    const root = fixture();
    writeFileSync(
      join(root, 'src/renderer/features/b/use.ts'),
      "﻿import { x } from '@/features/a/util';\nexport const z = x;\n",
    );
    git(root, 'add', '-A');

    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    const bytes = readFileSync(join(root, 'src/renderer/features/b/use.ts'));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString('utf8')).toContain("'@/lib/utils/util'");
  });

  it('keeps CRLF line endings on an importer it rewrites', () => {
    const root = fixture();
    writeFileSync(
      join(root, 'src/renderer/features/b/use.ts'),
      "import { x } from '@/features/a/util';\r\nexport const z = x;\r\n",
    );
    git(root, 'add', '-A');

    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/b/use.ts')).toBe(
      "import { x } from '@/lib/utils/util';\r\nexport const z = x;\r\n",
    );
  });

  it('warns about relative specifiers in a moved file that never resolved, and leaves them', () => {
    const root = fixture();
    writeFileSync(
      join(root, 'src/renderer/features/a/util.ts'),
      "import { gone } from './does-not-exist';\nexport const x = gone;\n",
    );
    git(root, 'add', '-A');

    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/1 relative specifier\(s\) in moved files did not resolve/);
    expect(read(root, 'src/renderer/lib/utils/util.ts')).toContain("'./does-not-exist'");
  });
});

const fakeGit = (root: string, onMv: string) => {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writePath(
    root,
    'bin/git',
    `#!/bin/sh\nif [ "$1" = "mv" ]; then\n${onMv}\nfi\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(join(root, 'bin/git'), 0o755);
  return { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` };
};

describe('devkit move — concurrent edits and the post-move self-check', () => {
  it('keeps an edit made to an importer during git mv, and still rewrites its import', () => {
    const root = fixture();
    const use = join(root, 'src/renderer/features/b/use.ts');
    // git mv runs once per physical move (util + its test), so the edit must be idempotent
    const env = fakeGit(
      root,
      `  printf "import { x } from '@/features/a/util';\\nexport const z = x + 1;\\n" > "${use}"`,
    );

    const r = testSpawnSync(process.execPath, [CLI, ...MOVE_ARGS], {
      cwd: root,
      encoding: 'utf8',
      env,
    });

    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/b/use.ts')).toBe(
      "import { x } from '@/lib/utils/util';\nexport const z = x + 1;\n",
    );
  });

  it('rewrites a file added to a moved directory mid-move, mocks included', () => {
    const root = fixture();
    const source = join(root, 'src/renderer/features/new-rules');
    writePath(root, 'src/renderer/features/new-rules/rule.ts', 'export const rule = 1;\n');
    const env = fakeGit(
      root,
      `  printf '%s\\n' "import { helper } from '../a/helper';" "vi.mock('../a/helper');" > "${source}/late.test.ts"`,
    );

    const r = testSpawnSync(
      process.execPath,
      [CLI, 'move', 'src/renderer/features/new-rules', 'src/renderer/lib'],
      { cwd: root, encoding: 'utf8', env },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/lib/new-rules/late.test.ts')).toBe(
      "import { helper } from '../../features/a/helper';\nvi.mock('../../features/a/helper');\n",
    );
  });

  it('rewrites an importer added outside the moved files while git mv ran', () => {
    const root = fixture();
    const late = join(root, 'src/renderer/features/d/late.ts');
    const env = fakeGit(
      root,
      `  mkdir -p "$(dirname "${late}")"; printf "import { x } from '../a/util';\\n" > "${late}"`,
    );

    const r = testSpawnSync(process.execPath, [CLI, ...MOVE_ARGS], {
      cwd: root,
      encoding: 'utf8',
      env,
    });

    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/d/late.ts')).toBe(
      "import { x } from '../../lib/utils/util';\n",
    );
  });

  it('fails loudly, naming the import, when a target disappears mid-move', () => {
    const root = fixture();
    const helper = join(root, 'src/renderer/features/a/helper.ts');
    const env = fakeGit(root, `  rm -f "${helper}"`);

    const r = testSpawnSync(process.execPath, [CLI, ...MOVE_ARGS], {
      cwd: root,
      encoding: 'utf8',
      env,
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/specifier\(s\) no longer resolve/);
    expect(r.stderr).toContain("src/renderer/lib/utils/util.ts: '../../features/a/helper'");
    expect(r.stdout).not.toMatch(/✓ moved/);
  });
});

describe('devkit move — solution-style tsconfig (project references)', () => {
  const PATHS = { '@/*': ['./src/renderer/*'] };

  it('rewrites importers that only a referenced project includes', () => {
    const root = fixture(
      JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
    );
    writeCfg(root, 'tsconfig.app.json', {
      compilerOptions: { composite: true, paths: PATHS },
      include: ['src'],
    });
    git(root, 'add', '-A');

    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
    expect(read(root, 'src/renderer/features/a/sibling.ts')).toContain("'../../lib/utils/util'");
  });

  it('finishes rewriting when the move itself breaks a project reference', () => {
    const root = fixture(
      JSON.stringify({ files: [], references: [{ path: './src/renderer/features/a' }] }),
    );
    writeCfg(root, 'src/renderer/features/a/tsconfig.json', {
      compilerOptions: { composite: true },
      include: ['.'],
    });
    git(root, 'add', '-A');

    const r = runMoveArgs(root, 'src/renderer/features/a', 'src/renderer/lib');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/could not re-read tsconfig after the move/);
    expect(existsSync(join(root, 'src/renderer/lib/a/util.ts'))).toBe(true);
  });

  it("rewrites a file created mid-move in a referenced project with that project's aliases", () => {
    const root = fixture(
      JSON.stringify({
        compilerOptions: { paths: PATHS },
        include: ['src/renderer/features/a', 'src/renderer/features/c'],
        references: [{ path: './tsconfig.other.json' }],
      }),
    );
    writeCfg(root, 'tsconfig.other.json', {
      compilerOptions: { composite: true, paths: { '~/*': ['./src/renderer/*'] } },
      include: ['src/renderer/features/b'],
    });
    git(root, 'add', '-A');
    const late = join(root, 'src/renderer/features/b/late.ts');
    const env = fakeGit(root, `  printf "import { x } from '~/features/a/util';\\n" > "${late}"`);

    const r = testSpawnSync(process.execPath, [CLI, ...MOVE_ARGS], {
      cwd: root,
      encoding: 'utf8',
      env,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/b/late.ts')).toBe(
      "import { x } from '~/lib/utils/util';\n",
    );
  });

  it('leaves a node_modules file alone even when tsconfig lists it, in the rescan too', () => {
    const root = fixture(
      JSON.stringify({
        compilerOptions: { paths: PATHS },
        include: ['src'],
        files: ['node_modules/vendor/dep.ts'],
      }),
    );
    // an alias import resolves from inside node_modules, unlike a relative one (TypeScript calls
    // that an external library), so only the scope filter keeps this file out of the rewrite
    const vendored = "import { x } from '@/features/a/util';\nexport const v = x;\n";
    writePath(root, 'node_modules/vendor/dep.ts', vendored);
    git(root, 'add', '-A', '-f');

    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'node_modules/vendor/dep.ts')).toBe(vendored);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
  });

  it('rewrites each referenced project with its own aliases', () => {
    const root = fixture(
      JSON.stringify({
        compilerOptions: { paths: PATHS },
        include: ['src/renderer/features/a', 'src/renderer/features/c'],
        references: [{ path: './tsconfig.other.json' }],
      }),
    );
    writeCfg(root, 'tsconfig.other.json', {
      compilerOptions: { composite: true, paths: { '~/*': ['./src/renderer/*'] } },
      include: ['src/renderer/features/b'],
    });
    writePath(
      root,
      'src/renderer/features/b/use.ts',
      "import { x } from '~/features/a/util';\nexport const z = x;\n",
    );
    git(root, 'add', '-A');

    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    // the other project's '~/' import resolves only with its own paths, and keeps that prefix
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'~/lib/utils/util'");
    expect(read(root, 'src/renderer/features/c/c.test.ts')).toContain(
      "vi.mock('@/lib/utils/util')",
    );
  });
});
