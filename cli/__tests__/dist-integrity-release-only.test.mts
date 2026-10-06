/** A PR's committed tree may add or delete dist, never rewrite it; only a proven release may. CI
 *  judges it via gate.yml; ship only names drift (sc-2467, typescript-source-prebuilt-mjs). */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  lutimesSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectReleaseOnlyDist,
  printReleaseOnlyDist,
  releaseVersion,
} from '../lib/ship/preflight/release-only-dist.mts';
import { SELF_HOST_EXTRAS } from '../lib/husky/self-host.mts';
import { scopedTargets } from '../../gate-engine/decisions/scoped-targets.mts';
import { rootRegistry, testSpawnSync } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);
const preflightScript = fileURLToPath(new URL('../lib/ship/dist-integrity.mts', import.meta.url));
const gateWorkflow = fileURLToPath(new URL('../../.github/workflows/gate.yml', import.meta.url));

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
/** The refusal's own header. A bare 'release-only' also matches fixture temp paths. */
const REFUSED = 'rewrites tracked dist, which is release-only';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** A devkit-shaped repo whose committed dist carries an importer, the README mirror and a hook. */
function repo(name = '@norvalbv/devkit') {
  const root = mkTmp('dist-mirror-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'a@b.c');
  git(root, 'config', 'user.name', 'a');
  write(root, 'package.json', `${JSON.stringify({ name, version: '0.0.1' })}\n`);
  write(root, '.gitignore', 'dist/\n');
  write(root, 'README.md', '# devkit\n');
  write(root, 'dist/README.md', '# devkit\n');
  write(root, 'dist/cli/a.mjs', 'export const a = 1;\n');
  write(root, 'dist/cli/b.mjs', 'export const b = 1;\n');
  git(root, 'add', 'package.json', '.gitignore', 'README.md');
  git(root, 'add', '-f', 'dist/README.md', 'dist/cli/a.mjs', 'dist/cli/b.mjs');
  git(root, 'commit', '-q', '-m', 'base');
  return { base: git(root, 'rev-parse', 'HEAD'), root };
}

/** The version bump `devkit release` writes into package.json and briefs. */
function bumpTo(root: string, version: string): void {
  write(root, 'package.json', `${JSON.stringify({ name: '@norvalbv/devkit', version })}\n`);
}

/** What `bun run build` leaves behind on main between releases: tracked dist rewritten in place. */
function rebuild(root: string, ...rels: string[]): void {
  for (const rel of rels) write(root, rel, `// rebuilt\n${rel}\n`);
}

/** What ship's staging leaves in the worktree index: the briefed paths, force-added. */
function stage(root: string, ...rels: string[]): void {
  git(root, 'add', '-f', '--', ...rels);
}

/** The tree a commit of what is staged now would carry. */
function snapshot(root: string): string {
  return git(root, 'write-tree');
}

/** The authoritative pass: judge the snapshot of what is staged now. */
function judgeStaged(root: string, base: string, branch = 'feat/x') {
  return inspectReleaseOnlyDist(root, base, branch, { tree: snapshot(root) });
}

describe('releaseVersion', () => {
  // devkit release only cuts x.y.z (cli/commands/release.mts SEMVER_RE), so nothing else qualifies.
  it.each([
    ['release/v1.2.3', '1.2.3'],
    ['release/v0.63.5', '0.63.5'],
    ['release/v1.2.3-rc.1', undefined],
    ['release/v1.2.3-foo..bar', undefined],
    ['release/v1.2', undefined],
    ['release/foo', undefined],
    ['release/v1.2.3/extra', undefined],
    ['feat/release/v1.2.3', undefined],
    ['Release/v1.2.3', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('%s → %s', (branch, expected) => {
    expect(releaseVersion(branch)).toBe(expected);
  });
});

describe('inspectReleaseOnlyDist — a judged tree, the authority', () => {
  it('refuses the rewritten README mirror, the sc-2467 overlap', () => {
    const { base, root } = repo();
    write(root, 'dist/README.md', '# devkit\nanother PR paragraph\n');
    stage(root, 'dist/README.md');

    expect(judgeStaged(root, base)).toEqual({
      active: true,
      releaseOnly: ['dist/README.md'],
      drift: [],
    });
  });

  it('judges the tree, so no brief spelling (./, .., a directory) can slip past', () => {
    const { base, root } = repo();
    rebuild(root, 'dist/cli/a.mjs', 'dist/cli/b.mjs');
    // Staged through a directory pathspec and a dot-dot spelling; the index records plain paths.
    git(root, 'add', '-f', '--', 'dist/cli/../cli/a.mjs', './dist/cli');

    expect(judgeStaged(root, base).releaseOnly).toEqual(['dist/cli/a.mjs', 'dist/cli/b.mjs']);
  });

  it('refuses a mode-only change: the artifact is still rewritten', () => {
    const { base, root } = repo();
    chmodSync(join(root, 'dist/cli/a.mjs'), 0o755);
    stage(root, 'dist/cli/a.mjs');

    expect(judgeStaged(root, base).releaseOnly).toEqual(['dist/cli/a.mjs']);
  });

  it('refuses a type change (a tracked file replaced by a symlink)', () => {
    const { base, root } = repo();
    rmSync(join(root, 'dist/README.md'));
    symlinkSync('../README.md', join(root, 'dist/README.md'));
    stage(root, 'dist/README.md');

    expect(judgeStaged(root, base).releaseOnly).toEqual(['dist/README.md']);
  });

  it('refuses a rewrite committed earlier on the branch, not only a staged one', () => {
    const { base, root } = repo();
    rebuild(root, 'dist/cli/a.mjs');
    git(root, 'commit', '-q', '-am', 'carried dist');

    expect(judgeStaged(root, base).releaseOnly).toEqual(['dist/cli/a.mjs']);
  });

  it('allows a NEW artifact and a deletion — the only dist changes a feature may carry', () => {
    const { base, root } = repo();
    write(root, 'dist/cli/new.mjs', 'export {};\n');
    stage(root, 'dist/cli/new.mjs');
    git(root, 'rm', '-q', '--cached', 'dist/cli/b.mjs');

    expect(judgeStaged(root, base)).toEqual({ active: true, releaseOnly: [], drift: [] });
  });

  it('judges the recorded snapshot, not whatever the index holds later', () => {
    const { base, root } = repo();
    const tree = snapshot(root);
    rebuild(root, 'dist/cli/a.mjs');
    stage(root, 'dist/cli/a.mjs');

    expect(inspectReleaseOnlyDist(root, base, 'feat/x', { tree }).releaseOnly).toEqual([]);
    expect(judgeStaged(root, base).releaseOnly).toEqual(['dist/cli/a.mjs']);
  });

  it('ignores a working-tree rebuild the ship never staged', () => {
    const { base, root } = repo();
    rebuild(root, 'dist/cli/a.mjs');

    expect(judgeStaged(root, base)).toEqual({ active: true, releaseOnly: [], drift: [] });
  });

  it('exempts a proven release: its branch names the version the staged package.json bumps to', () => {
    const { base, root } = repo();
    bumpTo(root, '9.9.9');
    rebuild(root, 'dist/README.md', 'dist/cli/a.mjs');
    stage(root, 'package.json', 'dist/README.md', 'dist/cli/a.mjs');

    expect(judgeStaged(root, base, 'release/v9.9.9').releaseOnly).toEqual([]);
  });

  it.each([
    ['no version bump at all', null],
    ['a bump to a different version than the branch names', '9.9.8'],
  ])('refuses a release-shaped branch with %s', (_label, version) => {
    const { base, root } = repo();
    if (version) bumpTo(root, version);
    rebuild(root, 'dist/README.md');
    stage(root, 'package.json', 'dist/README.md');

    expect(judgeStaged(root, base, 'release/v9.9.9').releaseOnly).toEqual(['dist/README.md']);
  });

  it('refuses a bump that sits in the working tree but was never staged', () => {
    const { base, root } = repo();
    rebuild(root, 'dist/README.md');
    stage(root, 'dist/README.md');
    bumpTo(root, '9.9.9');

    expect(judgeStaged(root, base, 'release/v9.9.9').releaseOnly).toEqual(['dist/README.md']);
  });

  it.each([['9.9.9'], [''], ['0.0'], ['v0.0.1'], [undefined]])(
    'refuses when the base version %j is already that release or is not x.y.z',
    (prior) => {
      const { root } = repo();
      write(
        root,
        'package.json',
        `${JSON.stringify({ name: '@norvalbv/devkit', version: prior })}\n`,
      );
      git(root, 'commit', '-q', '-am', 'base version');
      const base = git(root, 'rev-parse', 'HEAD');
      bumpTo(root, '9.9.9');
      rebuild(root, 'dist/README.md');
      stage(root, 'package.json', 'dist/README.md');

      expect(judgeStaged(root, base, 'release/v9.9.9').releaseOnly).toEqual(['dist/README.md']);
    },
  );

  it.each([
    ['renamed', `${JSON.stringify({ name: 'not-devkit', version: '0.0.1' })}\n`],
    ['unparseable', '{ "name": '],
  ])(
    'stays armed when the ship %s its own package.json: base still says devkit',
    (_label, json) => {
      const { base, root } = repo();
      write(root, 'package.json', json);
      rebuild(root, 'dist/README.md');
      stage(root, 'package.json', 'dist/README.md');

      expect(judgeStaged(root, base).releaseOnly).toEqual(['dist/README.md']);
    },
  );

  it('stays armed when base package.json is malformed but the shipped one says devkit', () => {
    const { root } = repo();
    write(root, 'package.json', '{ "name": ');
    git(root, 'commit', '-q', '-am', 'malformed base');
    const base = git(root, 'rev-parse', 'HEAD');
    bumpTo(root, '0.0.2');
    rebuild(root, 'dist/README.md');
    stage(root, 'package.json', 'dist/README.md');

    expect(judgeStaged(root, base).releaseOnly).toEqual(['dist/README.md']);
  });

  it('stays inert in a consumer repository', () => {
    const { base, root } = repo('consumer');
    rebuild(root, 'dist/cli/a.mjs');
    stage(root, 'dist/cli/a.mjs');

    expect(judgeStaged(root, base)).toEqual({ active: false, releaseOnly: [], drift: [] });
  });
});

describe('inspectReleaseOnlyDist — caller pass, advisory only', () => {
  it('names rewritten tracked dist as sorted drift and never refuses', () => {
    const { base, root } = repo();
    rebuild(root, 'dist/cli/b.mjs', 'dist/cli/a.mjs');
    write(root, 'dist/cli/new.mjs', 'export {};\n');

    expect(inspectReleaseOnlyDist(root, base, 'feat/x')).toEqual({
      active: true,
      releaseOnly: [],
      drift: ['dist/cli/a.mjs', 'dist/cli/b.mjs'],
    });
  });

  it('neither rewrites the shared index nor names a byte-identical rebuild as drift', () => {
    const { base, root } = repo();
    // A rebuild that reproduces the committed bytes leaves only a newer mtime behind.
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(root, 'dist/cli/a.mjs'), future, future);
    rebuild(root, 'dist/cli/b.mjs');
    const before = readFileSync(join(root, '.git', 'index'));

    expect(inspectReleaseOnlyDist(root, base, 'feat/x').drift).toEqual(['dist/cli/b.mjs']);
    expect(readFileSync(join(root, '.git', 'index')).equals(before)).toBe(true);
  });

  it('hashes a stat-dirty path containing a newline as one path, not two', () => {
    const { root } = repo();
    const odd = 'dist/cli/new\nline.mjs';
    write(root, odd, 'export {};\n');
    stage(root, odd);
    git(root, 'commit', '-q', '-m', 'odd name');
    const base = git(root, 'rev-parse', 'HEAD');
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(root, odd), future, future);

    expect(inspectReleaseOnlyDist(root, base, 'feat/x').drift).toEqual([]);
    write(root, odd, 'export const changed = 1;\n');
    utimesSync(join(root, odd), future, future);
    expect(inspectReleaseOnlyDist(root, base, 'feat/x').drift).toEqual([odd]);
  });

  it('compares a stat-dirty symlink by its target text, not the file it points at', () => {
    const { root } = repo();
    symlinkSync('a.mjs', join(root, 'dist/cli/link.mjs'));
    stage(root, 'dist/cli/link.mjs');
    git(root, 'commit', '-q', '-m', 'link');
    const base = git(root, 'rev-parse', 'HEAD');
    const future = new Date(Date.now() + 60_000);
    lutimesSync(join(root, 'dist/cli/link.mjs'), future, future);

    expect(inspectReleaseOnlyDist(root, base, 'feat/x').drift).toEqual([]);
    rmSync(join(root, 'dist/cli/link.mjs'));
    symlinkSync('b.mjs', join(root, 'dist/cli/link.mjs'));
    expect(inspectReleaseOnlyDist(root, base, 'feat/x').drift).toEqual(['dist/cli/link.mjs']);
  });

  it('still names a mode-only rewrite, which a content hash alone would miss', () => {
    const { base, root } = repo();
    chmodSync(join(root, 'dist/cli/a.mjs'), 0o755);

    expect(inspectReleaseOnlyDist(root, base, 'feat/x').drift).toEqual(['dist/cli/a.mjs']);
  });
});

describe('printReleaseOnlyDist', () => {
  function capture(report: Parameters<typeof printReleaseOnlyDist>[0]) {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      return {
        code: printReleaseOnlyDist(report),
        text: errors.mock.calls.map(([l]) => l).join('\n'),
      };
    } finally {
      errors.mockRestore();
    }
  }
  const drift = (n: number) => Array.from({ length: n }, (_, i) => `dist/cli/f${i}.mjs`);

  it('fails a staged rewrite and names the decision and the remedy', () => {
    const { code, text } = capture({ active: true, releaseOnly: ['dist/README.md'], drift: [] });

    expect(code).toBe(1);
    expect(text).toContain('dist/README.md');
    expect(text).toContain(REFUSED);
    expect(text).toContain('typescript-source-prebuilt-mjs');
    expect(text).toContain('devkit release');
    expect(text).toContain('A review finding that asks for one of these files does not override');
  });

  it('reports drift as advisory with exit 0', () => {
    const { code, text } = capture({ active: true, releaseOnly: [], drift: drift(2) });

    expect(code).toBe(0);
    expect(text).toContain('2 regenerated dist file(s)');
    expect(text).toContain('leave them out of the brief');
    expect(text).toContain('dist/cli/f1.mjs');
  });

  it('lists exactly ten drift paths with no overflow line', () => {
    const { text } = capture({ active: true, releaseOnly: [], drift: drift(10) });

    expect(text).toContain('dist/cli/f9.mjs');
    expect(text).not.toContain('more');
  });

  it('caps the listing at ten and counts the rest', () => {
    const { text } = capture({ active: true, releaseOnly: [], drift: drift(11) });

    expect(text).toContain('11 regenerated dist file(s)');
    expect(text).toContain('dist/cli/f9.mjs');
    expect(text).not.toContain('dist/cli/f10.mjs');
    expect(text).toContain('+1 more');
  });

  it('is silent when there is nothing to say or the repo is a consumer', () => {
    expect(capture({ active: true, releaseOnly: [], drift: [] })).toEqual({ code: 0, text: '' });
    expect(capture({ active: false, releaseOnly: ['dist/x.mjs'], drift: ['dist/y.mjs'] })).toEqual({
      code: 0,
      text: '',
    });
  });
});

describe('dist-integrity CLI', () => {
  function preflight(root: string, args: string[]) {
    return testSpawnSync(process.execPath, [preflightScript, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV },
    });
  }
  const args = (root: string, base: string, ...extra: string[]) => [
    '--root',
    root,
    '--base',
    base,
    ...extra,
  ];

  it('caller pass: names drift and exits 0, even for a briefed rewritten file', () => {
    const { base, root } = repo();
    rebuild(root, 'dist/README.md');

    const result = preflight(root, args(root, base, '--branch', 'feat/x', '--', 'dist/README.md'));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('1 regenerated dist file(s)');
    expect(result.stderr).not.toContain(REFUSED);
  });

  it('tree pass: exits 1 when the snapshot rewrites tracked dist', () => {
    const { base, root } = repo();
    rebuild(root, 'dist/README.md');
    stage(root, 'dist/README.md');

    const result = preflight(
      root,
      args(root, base, '--branch', 'feat/x', '--tree', snapshot(root), '--', 'x'),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(REFUSED);
    expect(result.stderr).toContain('dist/README.md');
  });

  it('tree pass: exits 0 for a proven release', () => {
    const { base, root } = repo();
    bumpTo(root, '9.9.9');
    rebuild(root, 'dist/README.md');
    stage(root, 'package.json', 'dist/README.md');

    const result = preflight(
      root,
      args(
        root,
        base,
        '--branch',
        'release/v9.9.9',
        '--tree',
        snapshot(root),
        '--',
        'package.json',
      ),
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it('tree pass skips the physical-build integrity walk', () => {
    const { base, root } = repo();
    write(root, 'dist/cli/new.mjs', 'export {};\n');

    const result = preflight(
      root,
      args(root, base, '--branch', 'feat/x', '--tree', snapshot(root), '--', 'cli/new.mts'),
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it('caller pass still fails on an integrity finding', () => {
    const { base, root } = repo();
    write(root, 'dist/cli/new.mjs', 'export {};\n');

    const result = preflight(root, args(root, base, '--branch', 'feat/x', '--', 'cli/new.mts'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dist/cli/new.mjs');
  });

  it('refuses a --branch with no value instead of exempting or ignoring it', () => {
    const { base, root } = repo();

    const result = preflight(root, args(root, base, '--branch'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--branch');
  });
});

describe('--ship-staged: the self-host hook runs CI’s check from the ship worktree', () => {
  /** The hook's own invocation; ship exports the base and branch, the hook's cwd is the worktree. */
  function shipStaged(root: string, ship: { base?: string; branch?: string }) {
    const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV };
    delete env.DEVKIT_SHIP_PR_BASE_SHA;
    delete env.DEVKIT_SHIP_BRANCH;
    if (ship.base) env.DEVKIT_SHIP_PR_BASE_SHA = ship.base;
    if (ship.branch) env.DEVKIT_SHIP_BRANCH = ship.branch;
    return testSpawnSync(process.execPath, [preflightScript, '--ship-staged'], {
      cwd: root,
      encoding: 'utf8',
      env,
    });
  }

  it('is wired into the self-host hook', () => {
    expect(SELF_HOST_EXTRAS).toContainEqual({
      label: 'release-only-dist',
      cmd: 'node cli/lib/ship/dist-integrity.mts --ship-staged',
    });
  });

  it('refuses a staged rewrite of tracked dist, with CI’s message', () => {
    const { base, root } = repo();
    rebuild(root, 'dist/README.md');
    stage(root, 'dist/README.md');

    const result = shipStaged(root, { base, branch: 'feat/x' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(REFUSED);
    expect(result.stderr).toContain('dist/README.md');
  });

  it('exempts a proven release, reading the branch ship exported', () => {
    const { base, root } = repo();
    bumpTo(root, '9.9.9');
    rebuild(root, 'dist/README.md');
    stage(root, 'package.json', 'dist/README.md');

    const result = shipStaged(root, { base, branch: 'release/v9.9.9' });

    expect(result.status, result.stderr).toBe(0);
  });

  it('passes a staged new artifact', () => {
    const { base, root } = repo();
    write(root, 'dist/cli/new.mjs', 'export {};\n');
    stage(root, 'dist/cli/new.mjs');

    const result = shipStaged(root, { base, branch: 'feat/x' });

    expect(result.status, result.stderr).toBe(0);
  });

  /** A real `git commit` whose hook mirrors the generated one: it moves GIT_INDEX_FILE into the
   *  commit-index carrier and scrubs it before the extra runs, with index.lock held. */
  function commitThroughHook(root: string, base: string, branch: string, ...commitArgs: string[]) {
    const hooks = mkTmp('dist-hooks-');
    write(
      hooks,
      'pre-commit',
      [
        '#!/bin/sh',
        'case "$GIT_INDEX_FILE" in /*) ci=$GIT_INDEX_FILE ;; *) ci=$PWD/$GIT_INDEX_FILE ;; esac',
        'DEVKIT_COMMIT_INDEX_FILE=$ci DEVKIT_COMMIT_GIT_DIR=$(git rev-parse --absolute-git-dir) \\',
        `  exec env -u GIT_INDEX_FILE "${process.execPath}" "${preflightScript}" --ship-staged`,
        '',
      ].join('\n'),
    );
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    git(root, 'config', 'core.hooksPath', hooks);
    const before = git(root, 'rev-parse', 'HEAD');
    const result = testSpawnSync('git', ['-C', root, 'commit', '-q', '-m', 'ship', ...commitArgs], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...GIT_ENV,
        DEVKIT_SHIP_PR_BASE_SHA: base,
        DEVKIT_SHIP_BRANCH: branch,
      },
    });
    return { result, moved: git(root, 'rev-parse', 'HEAD') !== before };
  }

  it('blocks a real commit of a staged dist rewrite from inside the hook', () => {
    const { base, root } = repo();
    rebuild(root, 'dist/README.md');
    stage(root, 'dist/README.md');

    const { result, moved } = commitThroughHook(root, base, 'feat/x');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(REFUSED);
    expect(moved).toBe(false);
  });

  it('judges the temporary index a pathspec commit hands the hook, not the real one', () => {
    const { base, root } = repo();
    rebuild(root, 'dist/README.md');

    const { result, moved } = commitThroughHook(root, base, 'feat/x', '--', 'dist/README.md');

    expect(result.stderr).toContain(REFUSED);
    expect(moved).toBe(false);
  });

  it('lets a clean commit through while git holds index.lock (no false block)', () => {
    const { base, root } = repo();
    write(root, 'dist/cli/new.mjs', 'export {};\n');
    stage(root, 'dist/cli/new.mjs');

    const { result, moved } = commitThroughHook(root, base, 'feat/x');

    expect(result.status, result.stderr).toBe(0);
    expect(moved).toBe(true);
  });

  it("is fed CI's PR base by ship and a reship rewrite, never by an append reship", () => {
    const shipDir = fileURLToPath(new URL('../lib/ship/', import.meta.url));
    const ship = readFileSync(join(shipDir, 'ship-branch.sh'), 'utf8');
    const reship = readFileSync(join(shipDir, 'reship.sh'), 'utf8');
    const review = readFileSync(join(shipDir, 'review-target.sh'), 'utf8');

    expect(ship).toContain('export DEVKIT_SHIP_PR_BASE_SHA="$BASE"');
    // An append's worktree is cut from the PR tip, so judging from it would refuse a later edit of
    // an artifact the PR itself added, which CI (diffing from the merge-base) accepts.
    expect(reship).toContain(
      'if [ "$REWRITE" -eq 1 ]; then export DEVKIT_SHIP_PR_BASE_SHA="$BASE"; else unset DEVKIT_SHIP_PR_BASE_SHA; fi',
    );
    expect(review).toMatch(/\bDEVKIT_SHIP_PR_BASE_SHA\b[\s\S]*\bunset "\$name"/);
  });

  it('judged from the PR base, a later edit of a dist file the PR added stays an addition', () => {
    const { base, root } = repo();
    write(root, 'dist/cli/new.mjs', 'export {};\n');
    stage(root, 'dist/cli/new.mjs');
    git(root, 'commit', '-q', '-m', 'pr adds an artifact');
    write(root, 'dist/cli/new.mjs', 'export const v = 2;\n');
    stage(root, 'dist/cli/new.mjs');

    expect(shipStaged(root, { base, branch: 'feat/x' }).status).toBe(0);
  });

  it('no-ops outside a ship, where no base is exported', () => {
    const { root } = repo();
    rebuild(root, 'dist/README.md');
    stage(root, 'dist/README.md');

    const result = shipStaged(root, {});

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
  });
});

describe('gate.yml enforces it on every PR', () => {
  /** The step's own `run:` block, so this exercises exactly what CI executes. */
  function gateStep(): string {
    const text = readFileSync(gateWorkflow, 'utf8');
    const step = /- name: Release-only dist[^\n]*\n([\s\S]*?)\n\n/.exec(text)?.[1];
    expect(step, 'gate.yml must carry the release-only dist step').toBeDefined();
    expect(step).toContain("if: github.event_name == 'pull_request'");
    const run = /run: \|\n([\s\S]*)$/.exec(step!)?.[1];
    expect(run).toBeDefined();
    return run!.replaceAll('cli/lib/ship/dist-integrity.mts', preflightScript);
  }

  /** A PR branch `head` forked from main, plus an unrelated later main commit (the PR's base tip). */
  function pullRequest(branch: string, change: (root: string) => void) {
    const { base: fork, root } = repo();
    git(root, 'switch', '-q', '-c', branch);
    change(root);
    git(root, 'add', '-A');
    git(root, 'add', '-f', 'dist');
    git(root, 'commit', '-q', '-m', 'pr');
    const head = git(root, 'rev-parse', 'HEAD');
    git(root, 'switch', '-q', 'main');
    // main moves on after the fork, rewriting dist the way a release merge does.
    write(root, 'dist/cli/b.mjs', 'export const b = 2;\n');
    git(root, 'add', '-f', 'dist/cli/b.mjs');
    git(root, 'commit', '-q', '-m', 'release merged');
    const baseTip = git(root, 'rev-parse', 'HEAD');
    git(root, 'switch', '-q', '--detach', head);
    expect(git(root, 'merge-base', baseTip, head)).toBe(fork);
    return testSpawnSync('/bin/bash', ['-c', gateStep()], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV, DIST_BASE: baseTip, DIST_HEAD: head, DIST_BRANCH: branch },
    });
  }

  it('fails a PR whose committed tree rewrites tracked dist', () => {
    const result = pullRequest('feat/x', (root) => {
      write(root, 'README.md', '# devkit\nrow\n');
      write(root, 'dist/README.md', '# devkit\nrow\nanother PR paragraph\n');
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(REFUSED);
    expect(result.stderr).toContain('dist/README.md');
  });

  it("passes a PR that adds a new artifact, judging from the merge-base, not main's moved tip", () => {
    // main's later dist rewrite is not this PR's: diffing against the tip would invert it into one.
    const result = pullRequest('feat/x', (root) => {
      write(root, 'cli/new.mts', 'export {};\n');
      write(root, 'dist/cli/new.mjs', 'export {};\n');
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it('passes a proven release PR, which rewrites dist by design', () => {
    const result = pullRequest('release/v9.9.9', (root) => {
      bumpTo(root, '9.9.9');
      rebuild(root, 'dist/README.md', 'dist/cli/a.mjs');
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it('fails a release-named PR with no version bump', () => {
    const result = pullRequest('release/v9.9.9', (root) => rebuild(root, 'dist/README.md'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(REFUSED);
  });
});

describe('the release-only ruling reaches the reviewers', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const governing = async (file: string) =>
    (await scopedTargets([file], '', 6, repoRoot)).find(
      (t) => t.slug === 'typescript-source-prebuilt-mjs',
    );

  it('loads on a change to the CLI dispatcher and says a stale tracked dist file is no finding', async () => {
    const target = await governing('cli/index.mts');

    expect(target?.via).toBe('scope-match');
    expect(target?.ruling).toContain('keeps its base bytes until devkit release');
    expect(target?.ruling).toContain('is not a review finding');
  });

  it.each(['.github/workflows/gate.yml', 'cli/lib/ship/ship-branch.sh', 'package.json'])(
    'still governs %s, which the earlier scope covered',
    async (file) => {
      expect((await governing(file))?.via).toBe('scope-match');
    },
  );
});
