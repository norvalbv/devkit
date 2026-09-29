import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  materializeDependencyRuntime,
  verifyDependencyRuntime,
} from '../lib/ship/review/dependency-runtime.mts';
import {
  cleanup,
  GIT_ENV,
  mkTmp,
  readTree,
  runSnapshot,
  snapshotFixture,
} from './review-snapshot-fixture.mts';

afterEach(cleanup);

const PACKAGE_JSON = JSON.stringify({ devDependencies: { pkg: '1.0.0' } });

function write(root: string, path: string, contents = 'runtime\n'): string {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
  return destination;
}

function gitIn(root: string, env: NodeJS.ProcessEnv) {
  return (args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
}

/** A main checkout with a bun install, plus a linked worktree whose node_modules is not installed. */
function worktreeFixture(appDir = '.') {
  const parent = realpathSync(mkTmp('devkit-review-worktree-link-'));
  const home = join(parent, '.home');
  mkdirSync(home);
  const env = { ...GIT_ENV, HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
  const main = join(parent, 'main');
  mkdirSync(main);
  const git = gitIn(main, env);
  git(['init', '-q', '-b', 'main']);
  write(main, '.gitignore', 'node_modules\n');
  write(main, join(appDir, 'package.json'), PACKAGE_JSON);
  write(main, join(appDir, 'bun.lock'), '{}\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  const mainModules = join(main, appDir, 'node_modules');
  write(mainModules, 'pkg/package.json', '{}\n');
  write(mainModules, 'pkg/bin.js', 'installed\n');
  mkdirSync(join(mainModules, '.bin'));
  symlinkSync('../pkg/bin.js', join(mainModules, '.bin/pkg'));
  const linked = join(parent, 'linked');
  git(['worktree', 'add', '-q', '--detach', linked]);
  const destination = join(parent, 'destination');
  mkdirSync(destination);
  return {
    parent,
    env,
    main,
    mainModules,
    source: join(linked, appDir),
    destination,
    manifest: join(parent, 'runtime.json'),
  };
}

describe('review dependency runtime: node_modules linked to the main worktree', () => {
  it.each(['absolute', 'relative'])(
    'materializes a %s surface link as a private directory and verifies it',
    (kind) => {
      const { mainModules, source, destination, manifest } = worktreeFixture();
      const target = kind === 'absolute' ? mainModules : '../main/node_modules';
      symlinkSync(target, join(source, 'node_modules'));

      materializeDependencyRuntime(source, destination, manifest);

      const surface = lstatSync(join(destination, 'node_modules'));
      expect(surface.isDirectory() && !surface.isSymbolicLink()).toBe(true);
      expect(readFileSync(join(destination, 'node_modules/pkg/bin.js'), 'utf8')).toBe(
        'installed\n',
      );
      expect(readlinkSync(join(destination, 'node_modules/.bin/pkg'))).toBe('../pkg/bin.js');
      expect(realpathSync(join(destination, 'node_modules/.bin/pkg'))).toBe(
        join(realpathSync(destination), 'node_modules/pkg/bin.js'),
      );
      expect(() => verifyDependencyRuntime(source, manifest)).not.toThrow();
    },
  );

  it('names the shared install when it changes while review runs', () => {
    const { mainModules, source, destination, manifest } = worktreeFixture();
    symlinkSync(mainModules, join(source, 'node_modules'));
    materializeDependencyRuntime(source, destination, manifest);

    writeFileSync(join(mainModules, 'pkg/bin.js'), 'reinstalled\n');

    expect(() => verifyDependencyRuntime(source, manifest)).toThrow(
      /changed while review was running \(shared install .*main\/node_modules changed/,
    );
  });

  it('ignores tool-cache churn from other worktrees sharing the install', () => {
    const { mainModules, source, destination, manifest } = worktreeFixture();
    write(mainModules, '.cache/jiti/before.mjs');
    symlinkSync(mainModules, join(source, 'node_modules'));
    materializeDependencyRuntime(source, destination, manifest);

    for (const cache of ['.cache/jiti/after.mjs', '.vite/deps.json', '.vite-temp/x.mjs']) {
      write(mainModules, cache);
    }

    expect(() => verifyDependencyRuntime(source, manifest)).not.toThrow();
    expect(lstatSync(join(destination, 'node_modules/.cache'), { throwIfNoEntry: false })).toBe(
      undefined,
    );
    write(mainModules, 'pkg/.cache/data.json');
    expect(() => verifyDependencyRuntime(source, manifest)).toThrow(/changed while review/);
  });

  it('resolves a target scope below the Git root and baseline mode', () => {
    const { mainModules, source, destination, manifest } = worktreeFixture('packages/app');
    symlinkSync(mainModules, join(source, 'node_modules'));

    materializeDependencyRuntime(source, destination, manifest, {}, 'baseline');

    expect(readFileSync(join(destination, 'node_modules/pkg/bin.js'), 'utf8')).toBe('installed\n');
  });

  it('ignores an inherited GIT_DIR when locating the main worktree', () => {
    const { parent, mainModules, source, destination, manifest } = worktreeFixture();
    symlinkSync(mainModules, join(source, 'node_modules'));
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(parent, 'not-a-repository');
    try {
      materializeDependencyRuntime(source, destination, manifest);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
    expect(lstatSync(join(destination, 'node_modules')).isDirectory()).toBe(true);
  });

  it('rejects a surface link to another repository with an install remedy', () => {
    const { parent, env, source, destination, manifest } = worktreeFixture();
    const other = join(parent, 'other');
    mkdirSync(other);
    gitIn(other, env)(['init', '-q']);
    write(other, 'node_modules/pkg/package.json', '{}\n');
    symlinkSync(join(other, 'node_modules'), join(source, 'node_modules'));

    expect(() => materializeDependencyRuntime(source, destination, manifest)).toThrow(
      /outside this repository's main worktree; replace it with a real install .*bun install --frozen-lockfile/,
    );
  });

  it('rejects a surface link to a non-dependency directory of the main worktree', () => {
    const { main, source, destination, manifest } = worktreeFixture();
    write(main, 'other-dir/pkg/package.json', '{}\n');
    symlinkSync(join(main, 'other-dir'), join(source, 'node_modules'));

    expect(() => materializeDependencyRuntime(source, destination, manifest)).toThrow(
      /outside this repository's main worktree/,
    );
  });

  it.each([
    ['a main-worktree source file', 'secret.txt'],
    ['the main worktree .git directory', '.git/config'],
  ])('still rejects an inner link to %s', (_name, path) => {
    const { main, mainModules, source, destination, manifest } = worktreeFixture();
    write(main, 'secret.txt', 'secret\n');
    symlinkSync(join(main, path), join(mainModules, 'leak'));
    symlinkSync(mainModules, join(source, 'node_modules'));

    expect(() => materializeDependencyRuntime(source, destination, manifest)).toThrow(
      /escapes the repository/,
    );
    expect(lstatSync(join(destination, 'node_modules'), { throwIfNoEntry: false })).toBe(undefined);
  });

  it('rejects a shared install that misses a dependency the worktree declares', () => {
    const { mainModules, source, destination, manifest } = worktreeFixture();
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({ devDependencies: { pkg: '1.0.0', added: '1.0.0' } }),
    );
    symlinkSync(mainModules, join(source, 'node_modules'));

    expect(() => materializeDependencyRuntime(source, destination, manifest)).toThrow(
      /stale install at .*\(missing: added\); replace it with a real install/,
    );
  });
});

describe('review snapshot: a symlinked node_modules surface', () => {
  it('never captures the link, even under a directory-only `node_modules/` ignore', () => {
    const { root, env, git } = snapshotFixture();
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    const external = mkTmp('devkit-review-shared-install-');
    write(external, 'pkg/package.json', '{}\n');
    symlinkSync(external, join(root, 'node_modules'));

    const result = runSnapshot(root, git(['rev-parse', 'HEAD']).trim(), env);

    expect(result.status, result.stderr).toBe(0);
    const tree = readTree(root, result.stdout.trim(), env);
    expect(tree.has('.gitignore')).toBe(true);
    expect(tree.has('node_modules')).toBe(false);
  });
});
