/**
 * `devkit review --target <linked worktree>` in OVERLAY mode (sc-1793).
 *
 * A linked worktree's `.git` is a FILE, so the literal `.git/hooks` an empty `origHooksPath` yields
 * can never resolve there. Capture used to abort on the gitfile itself; it now resolves that path to
 * ABSENT — the same verdict a single lstat gives — and refuses only when the checkout really does
 * own a native pre-commit that review cannot freeze.
 *
 * Every fixture here builds a REAL `git worktree add` target: the existing setup suites only ever
 * build ordinary repos, which is precisely why this class of bug went uncovered.
 */

import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOverlayHook } from '../lib/husky/husky-block.mts';
import {
  captureReviewSetup,
  type ReviewSetupManifest,
} from '../lib/ship/review/setup-manifest.mts';
import {
  materializeReviewSetupRuntime,
  verifyReviewSetupRuntime,
  verifyReviewSetupSource,
} from '../lib/ship/review/setup-runtime.mts';
import { resolveReviewSource } from '../lib/ship/review/source-projection.mts';
import { reviewSetupFixtures } from './review-setup-fixture.mts';

const { git, mkTmp, selection, write } = reviewSetupFixtures();

function overlayConfig(origHooksPath: string) {
  return {
    stack: 'generic',
    standalone: false,
    overlay: true,
    origHooksPath,
    components: selection,
    review: { enabled: true, guards: ['size', 'decisions'], decisionsDir: 'docs/decisions' },
  };
}

function pathRecord(manifest: ReviewSetupManifest, id: string) {
  return manifest.setup.paths.find((entry) => entry.id === id);
}

/** Overlay artifacts inside `root`, chaining to `chain` and recording `origHooksPath`. */
function installOverlay(root: string, chain: string, origHooksPath: string): void {
  write(root, '.devkit/hooks/pre-commit', buildOverlayHook(selection, chain), true);
  write(root, '.devkit/config.json', `${JSON.stringify(overlayConfig(origHooksPath), null, 2)}\n`);
  git(root, 'config', 'core.hooksPath', '.devkit/hooks');
}

function worktreeFixture(
  name: string,
  options: { nativeHookInSharedDir?: boolean; husky?: boolean; origHooksPath?: string } = {},
) {
  const parent = mkTmp(`devkit-review-worktree-${name}-`);
  const mainRoot = join(parent, 'main');
  mkdirSync(mainRoot, { recursive: true });
  git(mainRoot, 'init', '-q');
  git(mainRoot, 'commit', '-q', '--allow-empty', '-m', 'root');
  if (options.nativeHookInSharedDir) {
    writeFileSync(join(mainRoot, '.git/hooks/pre-commit'), '#!/bin/sh\necho native\n', {
      mode: 0o755,
    });
  }
  const targetRoot = join(parent, 'wt');
  git(mainRoot, 'worktree', 'add', '-q', '--detach', targetRoot, 'HEAD');
  if (options.husky) {
    write(targetRoot, '.husky/_/h', '#!/bin/sh\nexit 0\n');
    write(targetRoot, '.husky/_/pre-commit', '#!/bin/sh\nexit 0\n', true);
    write(targetRoot, '.husky/pre-commit', '#!/bin/sh\necho team\n', true);
  }
  // What `syncOverlayHook` itself would generate here: it chains only to hooks `detectExistingHooks`
  // can actually see, and `<worktree>/.git/hooks` does not exist to read. A husky chain is in-tree,
  // so it resolves normally. Getting this wrong trips the generator-drift check before capture runs.
  installOverlay(
    targetRoot,
    options.husky ? '.husky/pre-commit' : '',
    options.origHooksPath ?? (options.husky ? '.husky/_' : ''),
  );
  return {
    parent,
    mainRoot,
    targetRoot,
    setupManifest: join(parent, 'setup.json'),
    destination: join(parent, 'private'),
    runtimeManifest: join(parent, 'runtime.json'),
  };
}

/** The tracked files a materialized review worktree would already contain. */
function seed(fx: { targetRoot: string; destination: string }): void {
  mkdirSync(fx.destination, { recursive: true });
  for (const path of ['.devkit/config.json', '.devkit/hooks/pre-commit']) {
    const source = join(fx.targetRoot, path);
    const destination = join(fx.destination, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    chmodSync(destination, lstatSync(source).mode & 0o111 ? 0o755 : 0o644);
  }
}

describe('review setup capture — linked worktree overlay targets', () => {
  it('drives the full lane when the shared hooks dir owns no pre-commit', () => {
    const fx = worktreeFixture('clean');

    const manifest = captureReviewSetup(fx.targetRoot, fx.setupManifest);

    expect(pathRecord(manifest, 'overlay-chain')?.fingerprint).toBe('absent');
    expect(pathRecord(manifest, 'overlay-chain-source')).toBeUndefined();
    expect(manifest.setup.chain).toEqual({
      path: '.git/hooks/pre-commit',
      sourcePath: '.git/hooks',
    });

    // Capture-only assertions cannot reach setup-runtime's own re-resolution, so drive it all.
    expect(() => verifyReviewSetupSource(fx.setupManifest, fx.targetRoot)).not.toThrow();
    seed(fx);
    const runtime = materializeReviewSetupRuntime(
      fx.setupManifest,
      fx.destination,
      fx.runtimeManifest,
    );
    expect(runtime.fields.chainHook).toBe('');
    expect(runtime.fields.overlay).toBe(true);
    expect(verifyReviewSetupRuntime(fx.setupManifest, fx.runtimeManifest)).toEqual(runtime);
  });

  it('refuses a worktree whose native pre-commit lives in the shared hooks dir', () => {
    // Recording this one absent would clear a commit whose real hook chain review never ran, which
    // is exactly what review-gate-in-chain forbids. Fail closed, and name the resolved path.
    const fx = worktreeFixture('native-hook', { nativeHookInSharedDir: true });

    expect(() => captureReviewSetup(fx.targetRoot, fx.setupManifest)).toThrow(
      /native pre-commit lives outside it.*main\/\.git\/hooks\/pre-commit.*full clone/s,
    );
  });

  it('refuses a separate-git-dir checkout whose common dir sits INSIDE the working tree', () => {
    // The case a containment test waves through: `.git` is a gitfile (so the chain resolves absent)
    // while the common dir is nested under the checkout, so `isInside(gitRoot, hooks)` is true.
    // Only a same-directory comparison against `<gitRoot>/.git/hooks` catches it.
    const parent = mkTmp('devkit-review-worktree-separate-');
    const root = join(parent, 'target');
    mkdirSync(root, { recursive: true });
    git(root, 'init', '-q', `--separate-git-dir=${join(root, 'mygit')}`);
    writeFileSync(join(root, 'mygit/hooks/pre-commit'), '#!/bin/sh\necho native\n', {
      mode: 0o755,
    });
    installOverlay(root, '', '');

    expect(() => captureReviewSetup(root, join(parent, 'setup.json'))).toThrow(
      /native pre-commit lives outside it.*mygit\/hooks\/pre-commit/s,
    );
  });

  it('leaves a husky overlay alone, even with a stray hook in the shared dir', () => {
    // In husky mode core.hooksPath is `.husky/_`, so git's own hooks dir is never executed. Probing
    // it would fail the review closed on a repo whose gates are entirely healthy.
    const fx = worktreeFixture('husky', { nativeHookInSharedDir: true, husky: true });

    const manifest = captureReviewSetup(fx.targetRoot, fx.setupManifest);

    expect(manifest.setup.chain).toEqual({ path: '.husky/pre-commit', sourcePath: '.husky' });
    expect(pathRecord(manifest, 'overlay-chain')?.fingerprint).not.toBe('absent');
  });
});

describe('review source projection — non-directory ancestors', () => {
  it('resolves a path under a gitfile to the requested leaf, not the gitfile', () => {
    // Truncating at `.git` would hand the caller a real regular file to stat and fingerprint — the
    // gitfile would be reported as the hook itself.
    const parent = mkTmp('devkit-review-projection-gitfile-');
    const root = join(parent, 'wt');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.git'), 'gitdir: /nowhere/.git/worktrees/wt\n');

    const resolved = resolveReviewSource(root, '.git/hooks/pre-commit');

    // realpathSync because the resolver canonicalizes its root (macOS /var → /private/var).
    expect(resolved.physicalPath).toBe(join(realpathSync(root), '.git/hooks/pre-commit'));
    expect(resolved.projection).toBeNull();
  });

  it('resolves a missing leaf to its own path, not its parent', () => {
    // The ENOENT branch follows the same rule, so the two absent paths cannot diverge.
    const parent = mkTmp('devkit-review-projection-missing-');
    mkdirSync(join(parent, '.devkit'), { recursive: true });

    expect(resolveReviewSource(parent, '.devkit/config.json').physicalPath).toBe(
      join(realpathSync(parent), '.devkit/config.json'),
    );
  });

  it('still rejects a materializer symlink that resolves to a regular file', () => {
    // The guard inside resolveProjection is a TRUST check, not an ENOTDIR-equivalence case: a
    // projected `.devkit` must be a directory, and degrading this to "absent" would authenticate a
    // projection whose physical leaf is a file.
    const parent = mkTmp('devkit-review-projection-symlink-');
    const root = join(parent, 'target');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(parent, 'projected'), 'not a directory\n');
    symlinkSync(join(parent, 'projected'), join(root, '.devkit'));

    expect(() => resolveReviewSource(root, '.devkit/config.json')).toThrow(
      /projected review source parent is not a directory/,
    );
  });

  it('keeps a required entry failing closed when its ancestor is a plain file', () => {
    // The security assertion for applying the absent rule globally rather than only to the chain:
    // package mode's runner paths are all required, so a file planted at `.husky` must still abort.
    const parent = mkTmp('devkit-review-projection-required-');
    const root = join(parent, 'target');
    mkdirSync(root, { recursive: true });
    git(root, 'init', '-q');
    writeFileSync(join(root, '.husky'), 'not a directory\n');
    write(root, '.devkit/config.json', `${JSON.stringify(packageConfig(), null, 2)}\n`);
    git(root, 'config', 'core.hooksPath', '.husky/_');

    // Named exactly: `missing .husky/_` is pathState's verdict on the frozen runner source. A looser
    // /missing \.husky/ would also match reviewHookDrift's own message and prove nothing.
    expect(() => captureReviewSetup(root, join(parent, 'setup.json'))).toThrow(
      /missing \.husky\/_ /,
    );
  });

  it('keeps a required entry failing closed when the file ancestor is not the first segment', () => {
    // `unresolved()` slices the REMAINING segments, so an index-0 fixture cannot catch an off-by-one.
    // A file at `.husky/_` leaves `.husky/_/pre-commit` unresolvable from the second segment on.
    const parent = mkTmp('devkit-review-projection-required-nested-');
    const root = join(parent, 'target');
    mkdirSync(join(root, '.husky'), { recursive: true });
    git(root, 'init', '-q');
    writeFileSync(join(root, '.husky/_'), 'not a directory\n');
    write(root, '.devkit/config.json', `${JSON.stringify(packageConfig(), null, 2)}\n`);
    git(root, 'config', 'core.hooksPath', '.husky/_');

    expect(() => captureReviewSetup(root, join(parent, 'setup.json'))).toThrow(
      /missing \.husky\/_\/pre-commit/,
    );
  });
});

describe('review setup capture — native hooks probe', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    for (const name of ['GIT_COMMON_DIR', 'GIT_DIR', 'GIT_WORK_TREE']) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  it('refuses a SYMLINKED native pre-commit, which git executes like any other', () => {
    // lstat reports a symlink as "not a file", but git runs it — and symlinked hooks are how
    // dotfiles setups and hook managers install. Judging by lstat here would silently skip the very
    // hook this guard exists to protect.
    const fx = worktreeFixture('symlinked-hook');
    const real = join(fx.parent, 'real-hook');
    writeFileSync(real, '#!/bin/sh\necho native\n', { mode: 0o755 });
    symlinkSync(real, join(fx.mainRoot, '.git/hooks/pre-commit'));

    expect(() => captureReviewSetup(fx.targetRoot, fx.setupManifest)).toThrow(
      /native pre-commit lives outside it/,
    );
  });

  it('ignores a non-executable native pre-commit, which git skips', () => {
    // Deliberately fail-open: git never runs a mode-0644 hook, so review is not skipping anything.
    const fx = worktreeFixture('non-executable-hook');
    writeFileSync(join(fx.mainRoot, '.git/hooks/pre-commit'), '#!/bin/sh\necho native\n', {
      mode: 0o644,
    });

    expect(
      pathRecord(captureReviewSetup(fx.targetRoot, fx.setupManifest), 'overlay-chain')?.fingerprint,
    ).toBe('absent');
  });

  it('ignores a directory named pre-commit in the shared hooks dir', () => {
    const fx = worktreeFixture('directory-hook');
    mkdirSync(join(fx.mainRoot, '.git/hooks/pre-commit'), { recursive: true });

    expect(
      pathRecord(captureReviewSetup(fx.targetRoot, fx.setupManifest), 'overlay-chain')?.fingerprint,
    ).toBe('absent');
  });

  it('answers about the target repo even when the ambient git environment names another', () => {
    // Verified against real git: BOTH GIT_COMMON_DIR and GIT_DIR override `rev-parse
    // --git-common-dir` even with `-C <target>`. `devkit review` is routinely spawned from inside
    // git (a hook, `rebase --exec`), and an unstripped probe would answer about the OTHER repo —
    // find no hook there — and silently skip this checkout's real one.
    const fx = worktreeFixture('ambient-env', { nativeHookInSharedDir: true });
    const other = join(fx.parent, 'other');
    mkdirSync(other, { recursive: true });
    git(other, 'init', '-q');
    process.env.GIT_COMMON_DIR = join(other, '.git');
    process.env.GIT_DIR = join(other, '.git');

    expect(() => captureReviewSetup(fx.targetRoot, fx.setupManifest)).toThrow(
      /native pre-commit lives outside it/,
    );
  });

  it('fails closed when the common directory cannot be resolved at all', () => {
    // A worktree whose main checkout was deleted or moved: the gitfile still satisfies detectGitRoot,
    // but git can no longer answer. `gitOut` reports that as '' — which must abort, never fall
    // through to the silent skip this guard exists to prevent.
    const fx = worktreeFixture('stale-gitfile');
    rmSync(join(fx.mainRoot, '.git'), { recursive: true, force: true });

    expect(() => captureReviewSetup(fx.targetRoot, fx.setupManifest)).toThrow(
      /could not resolve the target Git common directory/,
    );
  });

  it('refuses a trailing-slash hooksPath, which names the same directory', () => {
    // `core.hooksPath = .git/hooks/` is a hand-writable value that devkit records verbatim. It
    // produces the IDENTICAL chain path, so deciding the refusal on the raw recorded spelling
    // rather than the normalized one would let a one-character difference disable the guard.
    const fx = worktreeFixture('trailing-slash', {
      nativeHookInSharedDir: true,
      origHooksPath: '.git/hooks/',
    });

    expect(() => captureReviewSetup(fx.targetRoot, fx.setupManifest)).toThrow(
      /native pre-commit lives outside it/,
    );
  });

  it('refuses a submodule whose native pre-commit lives under the superproject', () => {
    // A submodule's `.git` is a gitfile too, and its hooks live in <super>/.git/modules/<name> —
    // outside the checkout, and owned by a different repository than the one under review.
    const parent = mkTmp('devkit-review-submodule-');
    const superRoot = join(parent, 'super');
    const subOrigin = join(parent, 'sub-origin');
    for (const root of [superRoot, subOrigin]) {
      mkdirSync(root, { recursive: true });
      git(root, 'init', '-q');
      git(root, 'commit', '-q', '--allow-empty', '-m', 'root');
    }
    git(superRoot, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subOrigin, 'sub');
    const subRoot = join(superRoot, 'sub');
    writeFileSync(
      join(superRoot, '.git/modules/sub/hooks/pre-commit'),
      '#!/bin/sh\necho native\n',
      {
        mode: 0o755,
      },
    );
    installOverlay(subRoot, '', '');

    expect(() => captureReviewSetup(subRoot, join(parent, 'setup.json'))).toThrow(
      /native pre-commit lives outside it.*modules\/sub\/hooks\/pre-commit/s,
    );
  });
});

function packageConfig() {
  return {
    stack: 'generic',
    standalone: true,
    overlay: false,
    components: selection,
    review: { enabled: true, guards: ['size', 'decisions'], decisionsDir: 'docs/decisions' },
  };
}
