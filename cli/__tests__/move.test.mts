/**
 * `devkit move` codemod — verifies it relocates a file and rewrites EVERY reference style
 * (alias importer, relative importer, the moved file's own relative imports, vi.mock + dynamic
 * import string args, colocated test sibling) into `@/` alias form, and surgically prunes the
 * structure baseline. Runs the real CLI in a throwaway git repo (git mv needs an index).
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
const waitForPath = async (path) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
};

describe('devkit move', () => {
  it('relocates a file and rewrites all references in alias style + prunes baseline', () => {
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

    // relative importer rewritten to alias
    expect(read(root, 'src/renderer/features/a/sibling.ts')).toContain("'@/lib/utils/util'");
    expect(read(root, 'src/renderer/features/a/sibling.ts')).not.toContain("'./util'");

    // moved file's OWN relative import re-anchored to alias (helper stayed put)
    expect(read(root, 'src/renderer/lib/utils/util.ts')).toContain("'@/features/a/helper'");

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
    expect(read(root, 'src/renderer/lib/new-rules/rule.ts')).toContain("'@/lib/new-rules/shared'");
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/new-rules/rule'");
    expect(git(root, 'ls-files', '--', 'src/renderer/lib/new-rules').toString()).toBe('');
    expect(git(root, 'ls-files', '-s').toString()).toBe(indexBefore);
  });

  it('rewrites a source leaf added while Git starts moving its directory', () => {
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
    expect(read(root, 'src/renderer/lib/new-rules/late.ts')).toContain("'@/lib/new-rules/rule'");
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
    expect(read(root, 'src/renderer/lib/a/util.ts')).toContain("'@/lib/a/helper'");
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

  it('--dry-run still previews when tsconfig declares no alias, but reports the real run cannot run', () => {
    const root = fixture(NO_ALIAS_TSCONFIG);
    const r = runMove(root, '--dry-run');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[dry] mv src/renderer/features/a/util.ts');
    expect(r.stdout).toContain('[dry] would rewrite importers');
    expect(r.stderr).toMatch(/no "@\/\*"-style path alias found/);
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.ts'))).toBe(false);
  });

  it('the real run aborts on a missing alias without printing an mv line', () => {
    const root = fixture(NO_ALIAS_TSCONFIG);
    const r = runMove(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no "@\/\*"-style path alias found/);
    expect(r.stdout).not.toContain('mv '); // nothing moved, so nothing may claim it did
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
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no "@\/\*"-style path alias found/);
    expect(r.stderr).not.toMatch(/Cannot read properties of undefined/);
  });

  it('ignores exact-match paths keys, which this codemod cannot rewrite', () => {
    const root = fixture(
      JSON.stringify({ compilerOptions: { paths: { '@app': ['./src/renderer/app.ts'] } } }),
    );
    const r = runMove(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no "@\/\*"-style path alias found/);
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
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    // '~/' was selected, so the relative importer re-anchors to it
    expect(read(root, 'src/renderer/features/a/sibling.ts')).toContain("'~/lib/utils/util'");
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
