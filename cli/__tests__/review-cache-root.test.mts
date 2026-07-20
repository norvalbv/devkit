import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reviewCacheRoot } from '../lib/ship/review/cache/root.mts';
import { rootRegistry } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();

afterEach(cleanup);

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function initRepository(
  parent: string,
  nested = false,
  identity = 'tracked',
): { gitRoot: string; target: string } {
  const gitRoot = join(parent, 'repo');
  const target = nested ? join(gitRoot, 'packages/app') : gitRoot;
  mkdirSync(target, { recursive: true });
  git(gitRoot, 'init', '-q');
  git(gitRoot, 'config', 'user.email', 'review-cache@example.test');
  git(gitRoot, 'config', 'user.name', 'Review Cache Test');
  writeFileSync(join(gitRoot, 'tracked.txt'), `${identity}\n`);
  if (nested) writeFileSync(join(target, 'package.json'), '{}\n');
  git(gitRoot, 'add', '-A');
  git(gitRoot, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'initial');
  return { gitRoot: realpathSync(gitRoot), target: realpathSync(target) };
}

function physicalTemp(label: string): string {
  return realpathSync(mkTmp(`devkit-review-cache-${label}-`));
}

describe('reviewCacheRoot', () => {
  it('persists one stable physical namespace outside disposable runtimes and the target', () => {
    const fx = initRepository(physicalTemp('repo'));
    const cacheBase = physicalTemp('base');
    const firstTemp = physicalTemp('runtime-one');
    const secondTemp = physicalTemp('runtime-two');

    const first = reviewCacheRoot(fx.target, firstTemp, { cacheBase });
    writeFileSync(join(first, 'checkpoint'), 'pass\n');
    const second = reviewCacheRoot(fx.target, secondTemp, { cacheBase });

    expect(second).toBe(first);
    expect(first).toMatch(
      new RegExp(
        `^${cacheBase.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}/devkit/review/[a-f0-9]{64}$`,
      ),
    );
    expect(lstatSync(first).isDirectory()).toBe(true);
    expect(lstatSync(first).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(second, 'checkpoint'), 'utf8')).toBe('pass\n');
    for (const excluded of [fx.target, firstTemp, secondTemp]) {
      expect(relative(excluded, first).startsWith('..')).toBe(true);
      expect(relative(first, excluded).startsWith('..')).toBe(true);
    }
  });

  it('keys linked worktrees together by common directory and package-relative target', () => {
    const fx = initRepository(physicalTemp('linked-repo'), true);
    const linked = join(physicalTemp('linked-parent'), 'worktree');
    git(fx.gitRoot, 'worktree', 'add', '--detach', '-q', linked, 'HEAD');
    const cacheBase = physicalTemp('linked-base');

    const mainRoot = reviewCacheRoot(fx.target, physicalTemp('main-runtime'), { cacheBase });
    const linkedRoot = reviewCacheRoot(
      join(linked, 'packages/app'),
      physicalTemp('linked-runtime'),
      { cacheBase },
    );
    const repositoryRoot = reviewCacheRoot(fx.gitRoot, physicalTemp('root-runtime'), { cacheBase });

    expect(linkedRoot).toBe(mainRoot);
    expect(repositoryRoot).not.toBe(mainRoot);
  });

  it('changes identity when a repository is recreated at the same path', () => {
    const parent = physicalTemp('recreate-parent');
    const cacheBase = physicalTemp('recreate-base');
    const first = initRepository(parent);
    const firstRoot = reviewCacheRoot(first.target, physicalTemp('recreate-runtime-one'), {
      cacheBase,
    });

    rmSync(first.gitRoot, { recursive: true, force: true });
    const second = initRepository(parent, false, 'replacement');
    const secondRoot = reviewCacheRoot(second.target, physicalTemp('recreate-runtime-two'), {
      cacheBase,
    });

    expect(secondRoot).not.toBe(firstRoot);
  });

  it('canonicalizes repositories with multiple unrelated history roots', () => {
    const fx = initRepository(physicalTemp('multi-root-repo'));
    git(fx.gitRoot, 'branch', 'first-root');
    git(fx.gitRoot, 'checkout', '-q', '--orphan', 'second-root');
    git(fx.gitRoot, 'rm', '-qrf', '.');
    writeFileSync(join(fx.gitRoot, 'second.txt'), 'second root\n');
    git(fx.gitRoot, 'add', 'second.txt');
    git(fx.gitRoot, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'second root');
    git(
      fx.gitRoot,
      '-c',
      'core.hooksPath=/dev/null',
      'merge',
      '--allow-unrelated-histories',
      '-qm',
      'join roots',
      'first-root',
    );

    expect(git(fx.gitRoot, 'rev-list', '--max-parents=0', 'HEAD').split('\n')).toHaveLength(2);
    expect(
      existsSync(
        reviewCacheRoot(fx.target, physicalTemp('multi-root-runtime'), {
          cacheBase: physicalTemp('multi-root-base'),
        }),
      ),
    ).toBe(true);
  });

  it('honours a physical XDG cache home without relying on a shell HOME expansion', () => {
    const fx = initRepository(physicalTemp('xdg-repo'));
    const cacheBase = physicalTemp('xdg-base');
    const root = reviewCacheRoot(fx.target, physicalTemp('xdg-runtime'), {
      environment: { XDG_CACHE_HOME: cacheBase },
      homeDirectory: '/must/not/be/read',
      platform: 'linux',
    });

    expect(root.startsWith(`${cacheBase}/devkit/review/`)).toBe(true);
  });

  it('rejects nested-target runtimes and cache namespaces anywhere inside the Git root', () => {
    const fx = initRepository(physicalTemp('nested-overlap-repo'), true);
    const externalTemp = physicalTemp('nested-overlap-runtime');
    const cacheSibling = join(fx.gitRoot, 'packages/cache');

    expect(existsSync(cacheSibling)).toBe(false);
    expect(() =>
      reviewCacheRoot(fx.target, externalTemp, {
        environment: { XDG_CACHE_HOME: cacheSibling },
        homeDirectory: '/must/not/be/read',
        platform: 'linux',
      }),
    ).toThrow(/must live outside the target Git worktree/);
    expect(existsSync(cacheSibling)).toBe(false);

    const nestedTemp = join(fx.gitRoot, 'packages/runtime');
    mkdirSync(nestedTemp);
    const externalCache = physicalTemp('nested-overlap-cache');
    expect(() => reviewCacheRoot(fx.target, nestedTemp, { cacheBase: externalCache })).toThrow(
      /private review runtime must live outside the target Git worktree/,
    );
    expect(existsSync(join(externalCache, 'devkit'))).toBe(false);
  });

  it('keeps linked-worktree caches and runtimes out of the shared Git common directory', () => {
    const fx = initRepository(physicalTemp('common-dir-repo'), true);
    const linked = join(physicalTemp('common-dir-linked-parent'), 'worktree');
    git(fx.gitRoot, 'worktree', 'add', '--detach', '-q', linked, 'HEAD');
    const linkedTarget = join(linked, 'packages/app');
    const commonDirectory = realpathSync(join(fx.gitRoot, '.git'));
    const commonCache = join(commonDirectory, 'review-cache');

    expect(() =>
      reviewCacheRoot(linkedTarget, physicalTemp('common-dir-runtime'), {
        cacheBase: commonCache,
      }),
    ).toThrow(/Git common directory/);
    expect(existsSync(commonCache)).toBe(false);

    const externalCache = physicalTemp('common-dir-external-cache');
    expect(() =>
      reviewCacheRoot(linkedTarget, commonDirectory, { cacheBase: externalCache }),
    ).toThrow(/private review runtime must live outside .* Git common directory/);
    expect(existsSync(join(externalCache, 'devkit'))).toBe(false);
  });

  it('rejects cache overlap, relative bases, and symlink redirection', () => {
    const fx = initRepository(physicalTemp('unsafe-repo'));
    const temp = physicalTemp('unsafe-runtime');
    expect(() => reviewCacheRoot(fx.target, temp, { cacheBase: fx.target })).toThrow(
      /must live outside the target Git worktree/,
    );
    expect(() => reviewCacheRoot(fx.target, temp, { cacheBase: 'relative/cache' })).toThrow(
      /cache base must be an absolute path/,
    );

    const cacheBase = physicalTemp('symlink-base');
    const redirected = physicalTemp('symlink-destination');
    mkdirSync(join(cacheBase, 'devkit'));
    symlinkSync(redirected, join(cacheBase, 'devkit/review'), 'dir');
    expect(() => reviewCacheRoot(fx.target, temp, { cacheBase })).toThrow(
      /persistent review cache must be a physical directory/,
    );
    expect(existsSync(join(redirected, 'checkpoint'))).toBe(false);
  });

  it('does not follow a cache-base parent symlink into the Git worktree', () => {
    const fx = initRepository(physicalTemp('symlink-parent-repo'), true);
    const cacheParent = physicalTemp('symlink-parent-base');
    const redirected = join(cacheParent, 'redirected');
    symlinkSync(join(fx.gitRoot, 'packages'), redirected, 'dir');

    expect(() =>
      reviewCacheRoot(fx.target, physicalTemp('symlink-parent-runtime'), {
        cacheBase: join(redirected, 'cache'),
      }),
    ).toThrow(/persistent review cache must be a physical directory/);
    expect(existsSync(join(fx.gitRoot, 'packages/cache'))).toBe(false);
  });
});
