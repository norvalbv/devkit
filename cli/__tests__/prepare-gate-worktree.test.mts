import { execFileSync as rawExecFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { coverageMapSchema } from '../lib/ship/coverage/coverage-rebase.mts';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';

// Gate dependencies (.husky/_, node_modules, coverage) are all GITIGNORED, so `git worktree add`
// never brings them across. The consumer root can itself be a linked worktree — devkit's own stated
// premise ("parallel agents share one working tree"), and what any tool spawning per-task worktrees
// produces. Linking only from $root therefore failed closed on .husky/_ for a perfectly set-up repo
// and silently dropped node_modules/coverage. These cover the fallback to the MAIN worktree.

const scriptPath = fileURLToPath(new URL('../lib/ship/prepare-gate-worktree.sh', import.meta.url));
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A main checkout carrying the gitignored gate deps, plus a linked worktree that (correctly) lacks them. */
function seedRepoWithLinkedWorktree({ husky = true } = {}) {
  // realpath: `git worktree list` reports resolved paths, and macOS /var is a symlink to /private/var.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gatewt-')));
  dirs.push(root);
  const main = join(root, 'main');
  mkdirSync(main, { recursive: true });
  const git = (args: string[], cwd = main) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 'a']);
  writeFileSync(join(main, '.gitignore'), 'node_modules\ncoverage\n.husky/_\n');
  git(['add', '.gitignore']);
  git(['commit', '-q', '-m', 'root']);

  for (const rel of ['node_modules/dep.js', 'coverage/coverage-final.json'].concat(
    husky ? ['.husky/_/pre-commit'] : [],
  )) {
    const target = join(main, rel);
    mkdirSync(dirname(target), { recursive: true });
    // 0o755 on the hook: git SKIPS a non-executable hook, so a 0644 shim is a dark gate chain, and
    // the worktree postcondition checks for exactly that.
    writeFileSync(target, 'x', { mode: rel.startsWith('.husky/') ? 0o755 : 0o644 });
  }

  // The linked worktree: a clean checkout, so none of the above exists in it.
  const linked = join(root, 'linked');
  git(['worktree', 'add', '-q', '-b', 'task', linked]);

  const wt = join(root, 'ephemeral');
  mkdirSync(wt, { recursive: true });
  return { main, linked, wt, git };
}

/**
 * Invoke the real prepare_gate_worktree against <wt> with <root> as the consumer root.
 *
 * `set -euo pipefail` is not decoration: every real caller sources this file under it
 * (ship-branch.sh, reship.sh, review-target.sh), so a predicate that answers "no" must never abort
 * the caller. Without it these tests would run the code in a shell no consumer uses.
 */
function prepare(wt: string, root: string) {
  return spawnSync(
    '/bin/bash',
    ['-c', `set -euo pipefail; . "${scriptPath}"; prepare_gate_worktree "${wt}" "${root}" ship`],
    { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } },
  );
}

/** Seed a directory tree under <base>, `{ 'rel/path': 'contents' }`. */
function seedFiles(base: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    const target = join(base, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
}

const linkTarget = (p: string) => (lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null);

describe('prepare_gate_worktree — gate deps in a linked worktree', () => {
  it('links from the MAIN worktree when the consumer root is a linked one that lacks them', () => {
    const { main, linked, wt } = seedRepoWithLinkedWorktree();

    const r = prepare(wt, linked);

    expect(r.status, `must not fail closed (stderr: ${r.stderr})`).toBe(0);
    expect(linkTarget(join(wt, '.husky/_'))).toBe(join(main, '.husky/_'));
    expect(linkTarget(join(wt, 'node_modules'))).toBe(join(main, 'node_modules'));
    expect(linkTarget(join(wt, 'coverage'))).toBe(join(main, 'coverage'));
  });

  it('still prefers the consumer root when it has its own copy', () => {
    // The main checkout IS the root here — the pre-existing behaviour, which must not change.
    const { main, wt } = seedRepoWithLinkedWorktree();

    const r = prepare(wt, main);

    expect(r.status).toBe(0);
    expect(linkTarget(join(wt, 'node_modules'))).toBe(join(main, 'node_modules'));
  });

  it('still fails closed when no worktree has the husky runner', () => {
    // The guarantee that must survive: a missing runner means the commit has no real gate chain.
    const { linked, wt } = seedRepoWithLinkedWorktree({ husky: false });

    const r = prepare(wt, linked);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/missing \.husky\/_/);
    expect(r.stderr).toMatch(/gates must not fail open/);
  });

  it('names the resolved source of every link it makes', () => {
    // prepare_gate_worktree used to link in silence, which is why sc-1243 presented as "this repo has
    // no linters installed" rather than "the wrong node_modules got linked".
    const { main, linked, wt } = seedRepoWithLinkedWorktree();

    const r = prepare(wt, linked);

    expect(r.stderr).toContain(`linked node_modules ← ${join(main, 'node_modules')}`);
  });
});

// sc-1243. Running vitest inside a linked worktree creates node_modules/ holding ONLY caches (.vite,
// .vite-temp) — no packages, no .bin. An existence-only preference picked THAT over the main
// checkout's complete one, and every bare-binary package.json script in the ephemeral worktree died
// with `command not found` (127): the gate stage failed, the pre-commit hook failed, and the ship
// deleted the branch it had created.
describe('prepare_gate_worktree — a present-but-unusable dependency dir', () => {
  it('does NOT prefer a node_modules holding only cache dirs', () => {
    const { main, linked, wt } = seedRepoWithLinkedWorktree();
    seedFiles(linked, { 'node_modules/.vite/deps.json': '{}' });

    const r = prepare(wt, linked);

    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(linkTarget(join(wt, 'node_modules'))).toBe(join(main, 'node_modules'));
  });

  it('resolves a binary through the link it created', () => {
    // The end the whole ticket is about: `biome`/`eslint` are found via node_modules/.bin. Executing a
    // seeded shim through the symlink proves the exact resolution path 127 proves broken, without
    // paying for a real `bun run lint`.
    const { main, linked, wt } = seedRepoWithLinkedWorktree();
    const shim = join(main, 'node_modules/.bin/faketool');
    mkdirSync(dirname(shim), { recursive: true });
    writeFileSync(shim, '#!/bin/sh\necho resolved\n', { mode: 0o755 });
    seedFiles(linked, { 'node_modules/.vite/deps.json': '{}' });

    prepare(wt, linked);

    expect(execFileSync(join(wt, 'node_modules/.bin/faketool'), { encoding: 'utf8' })).toContain(
      'resolved',
    );
  });

  it('still prefers a linked worktree that has a REAL node_modules of its own', () => {
    // The deliberate-override case from the original design: a per-worktree install must keep winning.
    const { linked, wt } = seedRepoWithLinkedWorktree();
    seedFiles(linked, { 'node_modules/.vite/deps.json': '{}', 'node_modules/own-dep.js': 'x' });

    const r = prepare(wt, linked);

    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(linkTarget(join(wt, 'node_modules'))).toBe(join(linked, 'node_modules'));
  });

  it('treats a node_modules whose only entry is .bin as usable', () => {
    const { linked, wt } = seedRepoWithLinkedWorktree();
    seedFiles(linked, { 'node_modules/.bin/tool': 'x' });

    prepare(wt, linked);

    expect(linkTarget(join(wt, 'node_modules'))).toBe(join(linked, 'node_modules'));
  });

  it('leaves an unusable dir in BOTH worktrees resolving exactly as it did before', () => {
    // The safety claim behind keeping the existence tail: when neither candidate is populated the
    // resolution is byte-for-byte the old one (root first), so no path can newly fail.
    const { main, linked, wt } = seedRepoWithLinkedWorktree();
    rmSync(join(main, 'node_modules'), { recursive: true, force: true });
    seedFiles(main, { 'node_modules/.vite/x': '{}' });
    seedFiles(linked, { 'node_modules/.vite/x': '{}' });

    const r = prepare(wt, linked);

    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(linkTarget(join(wt, 'node_modules'))).toBe(join(linked, 'node_modules'));
  });

  it('does not let a DANGLING node_modules symlink win', () => {
    // `[ -e ]` is already false for a dangling link, so main wins today. The populated check must not
    // accidentally reverse that by treating "not a directory" as usable.
    const { main, linked, wt } = seedRepoWithLinkedWorktree();
    symlinkSync(join(linked, 'nowhere'), join(linked, 'node_modules'));

    const r = prepare(wt, linked);

    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(linkTarget(join(wt, 'node_modules'))).toBe(join(main, 'node_modules'));
  });

  it('keeps the fail-CLOSED coverage gate fail-closed: an empty local coverage/ is linked AS IS', () => {
    // Deliberately NOT given the populated-preference. Borrowing the main worktree's coverage artifact
    // would pass the gate on coverage computed from another branch's source — decision coverage-gate.md
    // Rejected (b). An empty local coverage/ must stay linked so the gate finds nothing and blocks.
    const { linked, wt } = seedRepoWithLinkedWorktree();
    mkdirSync(join(linked, 'coverage'), { recursive: true });

    const r = prepare(wt, linked);

    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(linkTarget(join(wt, 'coverage'))).toBe(join(linked, 'coverage'));
  });
});

// sc-1267. "Populated" only proves that an install exists; it does not prove that the install
// satisfies the commit selected as the ship base. When origin/main adds a dependency after the
// shared checkout last ran `bun install`, an unrelated ship can otherwise pass early binary-based
// gates and die much later with ERR_MODULE_NOT_FOUND.
describe('prepare_gate_worktree — dependency manifest freshness', () => {
  it('falls back to the main worktree when the linked install misses a base dependency', () => {
    const { main, linked, wt } = seedRepoWithLinkedWorktree();
    seedFiles(wt, {
      'package.json': JSON.stringify({ devDependencies: { 'fresh-dep': '^1.0.0' } }),
      'bun.lock': '{}',
    });
    seedFiles(linked, { 'node_modules/old-dep/package.json': '{}' });
    seedFiles(main, { 'node_modules/fresh-dep/package.json': '{}' });

    const r = prepare(wt, linked);

    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(linkTarget(join(wt, 'node_modules'))).toBe(join(main, 'node_modules'));
  });

  it('fails before gates when every available install misses a base dependency', () => {
    const { main, linked, wt } = seedRepoWithLinkedWorktree();
    seedFiles(wt, {
      'package.json': JSON.stringify({ dependencies: { 'fresh-dep': '^1.0.0' } }),
      'bun.lock': '{}',
    });
    seedFiles(linked, { 'node_modules/old-dep/package.json': '{}' });

    const r = prepare(wt, linked);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no node_modules satisfies the ship base package.json');
    expect(r.stderr).toContain('fresh-dep');
    expect(r.stderr).toContain(join(linked, 'node_modules'));
    expect(r.stderr).toContain(join(main, 'node_modules'));
    expect(r.stderr).toContain('bun install --frozen-lockfile');
  });
});

// sc-1934: the linked install IS the engine the worktree hook runs — one older than
// `.devkit/baselines` blocks every grandfathered ratchet entry as new, so ship must stop first.
describe('prepare_gate_worktree — a linked devkit too old to read .devkit/baselines', () => {
  const pinDevkit = (main: string, version: string) =>
    seedFiles(main, {
      'node_modules/@norvalbv/devkit/package.json': JSON.stringify({ version }),
    });

  it('refuses before linking when the install (resolved from the MAIN worktree) is below 0.53', () => {
    const { main, linked, wt } = seedRepoWithLinkedWorktree();
    pinDevkit(main, '0.52.0');
    seedFiles(wt, { '.devkit/baselines/size-lines.json': '{}' });

    const r = prepare(wt, linked);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('installed devkit 0.52.0 predates 0.53.0');
    expect(r.stderr).toContain('.devkit/baselines/size-lines.json');
    expect(r.stderr).toContain(join(main, 'node_modules', '@norvalbv', 'devkit'));
    expect(r.stderr).toContain('devkit upgrade');
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);
  });

  it('proceeds when the installed reader is current', () => {
    const { main, linked, wt } = seedRepoWithLinkedWorktree();
    pinDevkit(main, '0.62.0');
    seedFiles(wt, { '.devkit/baselines/size-lines.json': '{}' });

    const r = prepare(wt, linked);

    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(linkTarget(join(wt, 'node_modules'))).toBe(join(main, 'node_modules'));
  });

  it('judges the worktree the hook runs in, not the live checkout, which can move under it', () => {
    const { main, linked, wt } = seedRepoWithLinkedWorktree();
    pinDevkit(main, '0.52.0');
    seedFiles(wt, { 'eslint/baselines/size.json': '{}' });
    seedFiles(linked, { '.devkit/baselines/size.json': '{}' });

    const r = prepare(wt, linked);

    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
  });

  it("finds a monorepo package's canonical-only baselines, not just the root's", () => {
    const { main, linked, wt } = seedRepoWithLinkedWorktree();
    pinDevkit(main, '0.52.0');
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: wt, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    git(['init', '-q']);
    seedFiles(wt, {
      'packages/app/.devkit/config.json': '{}',
      'packages/app/.devkit/baselines/size.json': '{}',
    });
    git(['add', 'packages/app/.devkit/config.json']);

    const r = prepare(wt, linked);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('packages/app/.devkit/baselines/size.json');
  });

  it('leaves a consistent legacy-only repo on an old pin alone', () => {
    const { main, linked, wt } = seedRepoWithLinkedWorktree();
    pinDevkit(main, '0.52.0');
    seedFiles(wt, { 'eslint/baselines/size-lines.json': '{}' });

    const r = prepare(wt, linked);

    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
  });

  it('a check that cannot run never aborts the ship under set -e (corrupt installed devkit manifest)', () => {
    const { main, linked, wt } = seedRepoWithLinkedWorktree();
    pinDevkit(main, '0.52.0');
    seedFiles(wt, { '.devkit/baselines/size-lines.json': '{}' });
    seedFiles(main, { 'node_modules/@norvalbv/devkit/package.json': '{ not json' });

    const r = prepare(wt, linked);

    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stderr).toContain('baseline reader preflight unavailable (exit 2)');
    expect(linkTarget(join(wt, 'node_modules'))).toBe(join(main, 'node_modules'));
  });
});

// The hole the populated-preference cannot close: a `.husky/_` that IS populated but carries no
// pre-commit shim resolves fine, and the ship then commits and opens a PR with zero gates.
describe('prepare_gate_worktree — the worktree must have a hook chain git will run', () => {
  /** As `prepare`, but with <wt> a real worktree of the seeded repo so core.hooksPath resolves. */
  function prepareInRepo(wt: string, root: string, main: string, git: (a: string[]) => string) {
    rmSync(wt, { recursive: true, force: true });
    git(['-C', main, 'worktree', 'add', '-q', '--detach', wt]);
    return prepare(wt, root);
  }

  it('fails closed when the hook git would run is missing', () => {
    const { main, linked, wt, git } = seedRepoWithLinkedWorktree();
    git(['-C', main, 'config', 'core.hooksPath', '.husky/_']);
    rmSync(join(main, '.husky/_/pre-commit'));
    seedFiles(main, { '.husky/_/husky.sh': 'x' }); // populated, but nothing git will execute

    const r = prepareInRepo(wt, linked, main, git);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no executable pre-commit hook/);
    expect(r.stderr).toMatch(/gates must not fail open/);
  });

  it('fails closed when the hook exists but is not executable', () => {
    const { main, linked, wt, git } = seedRepoWithLinkedWorktree();
    git(['-C', main, 'config', 'core.hooksPath', '.husky/_']);
    chmodSync(join(main, '.husky/_/pre-commit'), 0o644); // git silently SKIPS a non-executable hook

    const r = prepareInRepo(wt, linked, main, git);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no executable pre-commit hook/);
  });

  it('passes when the linked runner supplies the hook', () => {
    const { main, linked, wt, git } = seedRepoWithLinkedWorktree();
    git(['-C', main, 'config', 'core.hooksPath', '.husky/_']);

    const r = prepareInRepo(wt, linked, main, git);

    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
  });

  it('accepts the committed standalone hook without requiring a husky runner', () => {
    const { main, linked, wt, git } = seedRepoWithLinkedWorktree();
    rmSync(join(main, '.husky/_'), { recursive: true, force: true });
    const hook = join(main, '.husky/pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    git(['-C', main, 'add', '.husky/pre-commit']);
    git(['-C', main, 'commit', '-qm', 'standalone hook']);
    git(['-C', main, 'config', 'core.hooksPath', '.husky']);

    const r = prepareInRepo(wt, linked, main, git);

    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(linkTarget(join(wt, '.husky/pre-commit'))).toBeNull();
  });

  it('does not newly fail a repo that configures no hooksPath at all', () => {
    const { main, linked, wt, git } = seedRepoWithLinkedWorktree();

    const r = prepareInRepo(wt, linked, main, git);

    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
  });
});

/** The judge preflight is ADVISORY and may never stop a ship. Both call sites invoke it BARE under
 *  `set -euo pipefail`, so the tolerated-exit mapping has to live INSIDE the function. */
describe('ship_judge_preflight — advisory, and errexit-safe by construction', () => {
  /** Source the real function and call it exactly as ship-branch.sh does: bare, under set -e. */
  const callUnderErrexit = (root: string, extraEnv: Record<string, string> = {}) =>
    spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
. ${JSON.stringify(scriptPath)}
ship_judge_preflight ${JSON.stringify(root)}
echo "SURVIVED:$?"`,
      ],
      { encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...extraEnv } },
    );

  it('says nothing at all when the reviewer gate is not selected', () => {
    const root = mkdtempSync(join(tmpdir(), 'jp-noreview-'));
    dirs.push(root);
    mkdirSync(join(root, '.devkit'), { recursive: true });
    writeFileSync(
      join(root, '.devkit/config.json'),
      JSON.stringify({ components: { guards: ['size', 'dup'] } }),
    );

    const r = callUnderErrexit(root);

    expect(r.stdout).toContain('SURVIVED:0');
    expect(r.stderr).not.toContain('guard-judge preflight');
  });

  it('survives a root the tool cannot even read — a broken check never aborts a ship', () => {
    const r = callUnderErrexit(join(tmpdir(), 'jp-does-not-exist-xyz'));

    // The bare call did not trip errexit, and the ship is told the gates still decide.
    expect(r.stdout).toContain('SURVIVED:0');
    expect(r.stderr).toContain('the reviewer gate still decides');
  });

  it('survives an unresolvable judge binary rather than reporting a ship failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'jp-nobin-'));
    dirs.push(root);
    mkdirSync(join(root, '.devkit'), { recursive: true });
    writeFileSync(
      join(root, '.devkit/config.json'),
      JSON.stringify({ components: { guards: ['review'] } }),
    );
    writeFileSync(
      join(root, 'guard.config.json'),
      JSON.stringify({
        review: {
          model: 'gpt-5.6-sol',
          escalationModel: 'gpt-5.6-sol',
          correctnessModel: 'gpt-5.6-sol',
        },
      }),
    );

    const r = callUnderErrexit(root, { GUARD_CODEX_BIN: join(tmpdir(), 'no-such-codex-xyz') });

    expect(r.stdout).toContain('SURVIVED:0');
    expect(r.stderr).toContain('not installed or not on PATH');
  });
});

// sc-1292 wiring under the errexit shell real callers use; unit behaviour lives in
// cli/lib/ship/coverage/coverage-rebase.test.mts.
describe('prepare_gate_worktree — linked coverage is rebased onto the worktree', () => {
  // Raw leaf git calls still carry a native bound so one cannot wedge this single-worker project.
  const LEAF_TIMEOUT_MS = 30_000;

  /** A real git worktree (as ship creates) under a root with a SPACE, as real consumer paths have. */
  function seedShipWorktree(coverageKeyRoot: (main: string) => string) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gatewt cov-')));
    dirs.push(root);
    const main = join(root, 'main');
    mkdirSync(join(main, 'src'), { recursive: true });
    const git = (args: string[], cwd = main) =>
      rawExecFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV },
        timeout: LEAF_TIMEOUT_MS,
      });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'a@b.c']);
    git(['config', 'user.name', 'a']);
    writeFileSync(join(main, '.gitignore'), 'node_modules\ncoverage\n.husky/_\n');
    writeFileSync(join(main, 'src/a.ts'), 'export const a = 1;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'root']);
    const key = `${coverageKeyRoot(main)}/src/a.ts`;
    seedFiles(main, {
      'node_modules/dep.js': 'x',
      'coverage/coverage-final.json': JSON.stringify({ [key]: { path: key, s: {}, f: {}, b: {} } }),
      'coverage/.last-clear.json': '{}',
    });
    mkdirSync(join(main, '.husky/_'), { recursive: true });
    writeFileSync(join(main, '.husky/_/pre-commit'), 'x', { mode: 0o755 });
    const wt = join(root, 'ship wt');
    git(['worktree', 'add', '-q', '--detach', wt]);
    return { main, wt };
  }

  it('replaces the link with a rebased report when coverage came from the developer checkout', () => {
    const { main, wt } = seedShipWorktree((m) => m);

    const r = prepare(wt, main);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(`rebased coverage keys from ${main} onto the worktree`);
    expect(lstatSync(join(wt, 'coverage')).isDirectory()).toBe(true);
    expect(linkTarget(join(wt, 'coverage/.last-clear.json'))).toBe(
      join(main, 'coverage/.last-clear.json'),
    );
    const report = coverageMapSchema.parse(
      JSON.parse(readFileSync(join(wt, 'coverage/coverage-final.json'), 'utf8')),
    );
    expect(Object.keys(report)).toEqual([`${realpathSync(wt)}/src/a.ts`]);
    // Linked AFTER staging: the rebase must not leave anything the ship could commit.
    expect(
      rawExecFileSync('git', ['status', '--porcelain'], {
        cwd: wt,
        encoding: 'utf8',
        timeout: LEAF_TIMEOUT_MS,
      }),
    ).toBe('');
  });

  it('keeps the plain link when the report already names the worktree paths', () => {
    const { main, wt } = seedShipWorktree(() => '');
    // Re-key under the worktree itself — the case of coverage produced inside it.
    const key = `${realpathSync(wt)}/src/a.ts`;
    writeFileSync(
      join(main, 'coverage/coverage-final.json'),
      JSON.stringify({ [key]: { path: key } }),
    );

    const r = prepare(wt, main);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('rebased coverage keys');
    expect(linkTarget(join(wt, 'coverage'))).toBe(join(main, 'coverage'));
  });
});
