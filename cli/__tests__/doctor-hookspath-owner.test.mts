/**
 * doctor's OWNERSHIP verdict: whose hook a commit made in THIS checkout actually runs.
 *
 * The sibling suite (`doctor-hook-runner.test.mts`) proves the runner reaches a new checkout. This
 * one proves the checkout then uses its OWN copy — a `core.hooksPath` pinned at another checkout's
 * runner makes git dispatch that checkout's hook, off that checkout's branch, with no error and
 * nothing in the usual config output to suggest it.
 *
 * Everything here is a property of real git — config scopes, `config.worktree`, hook dispatch — so
 * these are real repos and real worktrees throughout. The first test commits for real and reads back
 * which hook body ran, because "the config key is empty" is not the claim the story makes.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectResults } from '../commands/doctor.mts';
import syncHookRunner, { replacePin } from '../commands/sync/sync-hook-runner.mts';
import { replaceableHooksPathPin } from '../lib/doctor/hook-checks.mts';
import { runSelfHostDoctor } from '../lib/doctor/self-host-doctor.mts';
import { rootRegistry, testSpawnSync } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const CHECK = 'hooksPath owner';
const RUNNER_CHECK = 'hook runner (worktree-safe)';
const HUSKY_CFG = { components: { husky: true, biome: false, tsconfig: false, guards: [] } };

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Commit without letting the fixture's own hooks run — setup must not depend on what we're testing. */
function commit(root: string, message: string): void {
  git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message, '--allow-empty');
}

/** A husky-shaped repo whose runner is TRACKED, so it checks out into every worktree. `marker` goes
 * in the runner stub git actually executes, so a commit says which checkout's copy ran. */
function huskyRepo(marker: string): string {
  const root = mkTmp('doctor-hookspath-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  mkdirSync(join(root, '.husky', '_'), { recursive: true });
  writeFileSync(join(root, '.husky', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(root, '.husky', '_', '.gitignore'), '*');
  writeFileSync(join(root, '.husky', '_', 'h'), '#!/usr/bin/env sh\n');
  writeFileSync(
    join(root, '.husky', '_', 'pre-commit'),
    `#!/bin/sh\necho "${marker}" >&2\nexit 0\n`,
    {
      mode: 0o755,
    },
  );
  git(root, 'config', 'core.hooksPath', '.husky/_');
  git(root, 'add', '-f', '.husky/pre-commit', '.husky/_/h', '.husky/_/pre-commit');
  commit(root, 'initial');
  return root;
}

/** A linked worktree of `root`, on its own branch. `marker` (when given) rewrites the runner stub
 * ON THAT BRANCH, so the two checkouts genuinely disagree about what the hook says. */
function worktree(root: string, name: string, marker?: string): string {
  // Inside a tracked tmp dir of its own: worktrees must not sit under `root` (they would show up as
  // untracked content in the very commits these tests make) and must not collide between tests.
  const wt = join(mkTmp('doctor-hookspath-wt-'), name);
  git(root, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', name, wt);
  if (marker) {
    writeFileSync(
      join(wt, '.husky', '_', 'pre-commit'),
      `#!/bin/sh\necho "${marker}" >&2\nexit 0\n`,
      {
        mode: 0o755,
      },
    );
    git(wt, 'add', '-f', '.husky/_/pre-commit');
    commit(wt, 'worktree hook');
  }
  return wt;
}

/** Pin `target` as this checkout's own core.hooksPath — what the host tooling writes after a
 * `git worktree add`, and the state every test here is about. */
function pin(root: string, wt: string, target: string): void {
  git(root, 'config', 'extensions.worktreeConfig', 'true');
  git(wt, 'config', '--worktree', 'core.hooksPath', target);
}

async function results(root: string, cfg: typeof HUSKY_CFG = HUSKY_CFG) {
  const { results: all } = await collectResults(root, cfg, { name: 'config.json', status: 'OK' });
  return all;
}

async function ownerCheck(root: string, cfg: typeof HUSKY_CFG = HUSKY_CFG) {
  return (await results(root, cfg)).find((r) => r.name === CHECK);
}

/** Commit for real and return everything the hook printed — both streams, since which one carries a
 * hook's output is git's business, not something worth asserting on. */
function commitAndReadHook(wt: string, name: string): string {
  writeFileSync(join(wt, `${name}.txt`), 'x');
  git(wt, 'add', '-A');
  // Supervised: this commit EXECUTES a hook, so it is a process tree rather than a leaf git call.
  // See docs/decisions/suite-hangs-bound-at-the-spawn-site.md (sc-2393).
  const done = testSpawnSync('git', ['-C', wt, 'commit', '-m', name], { encoding: 'utf8' });
  return `${done.stdout ?? ''}${done.stderr ?? ''}`;
}

function scopedPin(wt: string): string {
  try {
    return git(wt, 'config', '--worktree', '--get', 'core.hooksPath').trim();
  } catch {
    return '';
  }
}

describe('doctor — whose hooks run in this checkout', () => {
  it('replacing the sibling pin flips which checkout’s hook a real commit runs', async () => {
    // The story's actual claim, end to end. Everything else here guards a branch of it.
    const root = huskyRepo('HOOK-FROM-MAIN');
    const wt = worktree(root, 'feature', 'HOOK-FROM-WT');
    pin(root, wt, join(root, '.husky', '_'));

    // Before: the worktree's commits run the MAIN checkout's hook, off main's branch.
    expect(commitAndReadHook(wt, 'before')).toContain('HOOK-FROM-MAIN');
    expect((await ownerCheck(wt))?.status).toBe('DRIFT');

    expect(syncHookRunner([], wt)).toBe(0);

    expect(scopedPin(wt)).toBe('.husky/_');
    expect(commitAndReadHook(wt, 'after')).toContain('HOOK-FROM-WT');
    expect((await ownerCheck(wt))?.status).toBe('OK');
  });

  it('does not append over a concurrent writer when a captured repair plan becomes stale', () => {
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    pin(root, wt, join(root, '.husky', '_'));
    const planned = replaceableHooksPathPin(wt);
    expect(planned).not.toBeNull();
    if (!planned) throw new Error('expected a repairable sibling pin');

    const central = join(mkTmp('doctor-hookspath-central-'), 'hooks');
    mkdirSync(central);
    writeFileSync(join(central, 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    git(wt, 'config', '--worktree', 'core.hooksPath', central);

    expect(replacePin(wt, wt, planned)).toBe(false);
    expect(git(wt, 'config', '--worktree', '--get-all', 'core.hooksPath').trim()).toBe(central);
  });

  it('fails safely when another Git writer already owns the config.worktree lock', () => {
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    const original = join(root, '.husky', '_');
    pin(root, wt, original);
    const gitDir = git(wt, 'rev-parse', '--absolute-git-dir').trim();
    const lock = join(gitDir, 'config.worktree.lock');
    writeFileSync(lock, 'held by another writer');

    expect(syncHookRunner([], wt)).toBe(1);
    expect(git(wt, 'config', '--worktree', '--get-all', 'core.hooksPath').trim()).toBe(original);
    rmSync(lock);
  });

  it('rolls back when the local runner disappears after locked revalidation', () => {
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    const original = join(root, '.husky', '_');
    pin(root, wt, original);
    const planned = replaceableHooksPathPin(wt);
    expect(planned).not.toBeNull();
    if (!planned) throw new Error('expected a repairable sibling pin');

    // The getter places the competing filesystem write at the exact TOCTOU boundary: after the
    // locked repair plan was recomputed, but before its candidate is renamed into place.
    let raced = false;
    const racingPlan = {
      from: planned.from,
      get to() {
        if (!raced) {
          raced = true;
          rmSync(join(wt, '.husky', '_', 'pre-commit'));
        }
        return planned.to;
      },
    };

    expect(replacePin(wt, wt, racingPlan)).toBe(false);
    expect(scopedPin(wt)).toBe(original);
  });

  it('names the checkout whose hooks run, and the command that hands them back', async () => {
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    pin(root, wt, join(root, '.husky', '_'));

    const result = await ownerCheck(wt);

    expect(result?.status).toBe('DRIFT');
    expect(result?.detail).toContain('owned by sibling checkout');
    expect(result?.detail).toContain(root);
    expect(result?.remediation).toContain('devkit sync-hook-runner');
    expect(result?.remediation).toContain('git config --worktree core.hooksPath .husky/_');
  });

  it('leaves the pin alone when a declared hook has no stub here — replacement would un-gate it', async () => {
    // The runner DIRECTORY exists, so an existence test would call this healthy and clear the pin.
    // But `.husky/commit-msg` has no stub in this checkout, so commit-msg would then run nothing —
    // strictly worse than the sibling hook it currently borrows.
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    writeFileSync(join(wt, '.husky', 'commit-msg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    git(wt, 'add', '-f', '.husky/commit-msg');
    commit(wt, 'declare commit-msg');
    pin(root, wt, join(root, '.husky', '_'));

    const result = await ownerCheck(wt);
    expect(result?.status).toBe('DRIFT');
    expect(result?.remediation).not.toContain('--unset');
    expect(result?.remediation).toContain('bun install');

    syncHookRunner([], wt);
    expect(scopedPin(wt)).toBe(join(root, '.husky', '_'));
  });

  it('stages an untracked runner and replaces the pin in ONE run', async () => {
    // The shape found live: a worktree cut before the runner was tracked. Its runner exists on disk
    // but is gitignored, so it is not self-gated yet — and telling the user to `bun install` first
    // would be wrong, because staging is exactly what sync-hook-runner does before it re-reads.
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    git(wt, 'rm', '-q', '--cached', '.husky/_/pre-commit', '.husky/_/h');
    commit(wt, 'untrack the runner');
    // husky regenerates its self-ignoring runner locally, which is what makes the files unreachable
    // rather than merely uncommitted — the distinction the whole staging half turns on.
    writeFileSync(join(wt, '.husky', '_', '.gitignore'), '*');
    pin(root, wt, join(root, '.husky', '_'));

    expect((await ownerCheck(wt))?.remediation).toContain('devkit sync-hook-runner');

    syncHookRunner([], wt);

    expect(git(wt, 'ls-files', '.husky/_').trim()).toContain('.husky/_/pre-commit');
    expect(scopedPin(wt)).toBe('.husky/_');
  });

  it('leaves the pin alone when this checkout’s runner directory is empty', async () => {
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    pin(root, wt, join(root, '.husky', '_'));
    rmSync(join(wt, '.husky', '_'), { recursive: true, force: true });

    syncHookRunner([], wt);

    expect(scopedPin(wt)).toBe(join(root, '.husky', '_'));
  });

  it('reports a repo-wide absolute hooksPath but never clears it — it is not this checkout’s to drop', async () => {
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    // Repo-wide, so every checkout inherits it; unsetting from here would re-wire all of them.
    git(root, 'config', 'core.hooksPath', join(root, '.husky', '_'));

    const result = await ownerCheck(wt);
    expect(result?.status).toBe('DRIFT');
    expect(result?.remediation).toContain('repo-wide');
    expect(result?.remediation).not.toContain('--worktree');

    syncHookRunner([], wt);
    expect(git(wt, 'config', '--local', '--get', 'core.hooksPath').trim()).toBe(
      join(root, '.husky', '_'),
    );
  });

  it('never treats a repo-wide value as per-checkout when the worktree extension is off', async () => {
    // `git config --worktree` FALLS BACK to --local without extensions.worktreeConfig: it reads the
    // repo-wide value while looking scoped, and its --unset deletes that repo-wide value. Scope has
    // to come from the extension + config.worktree, never from the read succeeding.
    const root = huskyRepo('MAIN');
    const outside = mkTmp('doctor-hookspath-outside-');
    mkdirSync(join(outside, 'hooks'));
    writeFileSync(join(outside, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    git(root, 'config', 'core.hooksPath', join(outside, 'hooks'));

    const result = await ownerCheck(root);
    expect(result?.remediation ?? '').not.toContain('--worktree');

    syncHookRunner([], root);
    expect(git(root, 'config', '--local', '--get', 'core.hooksPath').trim()).toBe(
      join(outside, 'hooks'),
    );
  });

  it('survives a --worktree read that git refuses outright', async () => {
    // Two worktrees and no extension: `git config --worktree` exits 128 rather than falling back.
    const root = huskyRepo('MAIN');
    worktree(root, 'one');
    const wt = worktree(root, 'two');

    expect(await ownerCheck(wt)).toBeUndefined();
    expect((await ownerCheck(wt, HUSKY_CFG)) ?? null).toBeNull();
  });

  it('stays silent for a relative hooksPath whose runner is a symlink into another checkout', async () => {
    // devkit's own ship gate worktrees are built this way. Resolving a RELATIVE value through its
    // link target would report every single `devkit ship` as a defect.
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'gate');
    rmSync(join(wt, '.husky', '_'), { recursive: true, force: true });
    symlinkSync(join(root, '.husky', '_'), join(wt, '.husky', '_'));

    expect(await ownerCheck(wt)).toBeUndefined();
  });

  it('reports a RELATIVE pin that escapes the checkout', async () => {
    // git accepts `../…` and dispatches it verbatim; treating "relative" as "inside" would miss it.
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    pin(root, wt, relative(wt, join(root, '.husky', '_')));

    expect((await ownerCheck(wt))?.status).toBe('DRIFT');
  });

  it('stays silent for a deliberate org-shared hooks directory outside every checkout', async () => {
    // A working, intentional configuration that doctor passes today. Flipping it to exit 1 would
    // red a consumer whose setup is doing exactly what they asked for.
    const root = huskyRepo('MAIN');
    const shared = mkTmp('doctor-hookspath-org-');
    mkdirSync(join(shared, 'githooks'));
    writeFileSync(join(shared, 'githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    git(root, 'config', 'core.hooksPath', join(shared, 'githooks'));

    expect(await ownerCheck(root)).toBeUndefined();
  });

  it('preserves an intentional WORKTREE-scoped central hooks directory', async () => {
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    const central = mkTmp('doctor-hookspath-central-');
    mkdirSync(join(central, 'hooks'));
    writeFileSync(join(central, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    pin(root, wt, join(central, 'hooks'));

    expect((await ownerCheck(wt))?.status).toBe('OK');
    expect(syncHookRunner([], wt)).toBe(0);
    expect(scopedPin(wt)).toBe(join(central, 'hooks'));
  });

  it('does not call a pin a shadow when it merely restates the fallback', async () => {
    // `<main>/.git/hooks` with no shared value is byte-identical to git's own default, which every
    // worktree already shares through the common dir — so this pin changes nothing and must not be
    // reported as another checkout's hooks. Note git hands back `/private/var/…` while the pin was
    // written as `/var/…`, so a lexical comparison alone calls this a shadow.
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    git(root, 'config', '--unset', 'core.hooksPath');
    pin(root, wt, join(root, '.git', 'hooks'));

    const result = await ownerCheck(wt);

    expect(result?.status).toBe('OK');
    expect(result?.detail).not.toContain('owned by sibling checkout');
  });

  it('reports a pin at a SIBLING worktree, not just at the main checkout', async () => {
    const root = huskyRepo('MAIN');
    const sibling = worktree(root, 'sibling');
    const wt = worktree(root, 'feature');
    pin(root, wt, join(sibling, '.husky', '_'));

    const result = await ownerCheck(wt);
    expect(result?.status).toBe('DRIFT');
    expect(result?.detail).toContain(sibling);
  });

  it('reports a pin at a checkout that has since been removed', async () => {
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    pin(root, wt, join(root, '..', 'gone', '.husky', '_'));

    const result = await ownerCheck(wt);
    expect(result?.status).toBe('MISSING');
    expect(result?.detail).toContain('resolves to nothing');
    syncHookRunner([], wt);
    expect(scopedPin(wt)).toBe(join(root, '..', 'gone', '.husky', '_'));
  });

  it('repairs a missing sibling while git still retains its prunable provenance', async () => {
    const root = huskyRepo('MAIN');
    const sibling = worktree(root, 'gone-sibling');
    const wt = worktree(root, 'feature');
    pin(root, wt, join(sibling, '.husky', '_'));
    rmSync(sibling, { recursive: true, force: true });

    expect((await ownerCheck(wt))?.status).toBe('MISSING');
    expect(syncHookRunner([], wt)).toBe(0);
    expect(scopedPin(wt)).toBe('.husky/_');
  });

  it('refuses ambiguous multiple worktree values', async () => {
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    pin(root, wt, join(root, '.husky', '_'));
    git(wt, 'config', '--worktree', '--add', 'core.hooksPath', '.husky/_');

    const before = git(wt, 'config', '--worktree', '--get-all', 'core.hooksPath');
    const all = await results(wt);
    expect(all.find((result) => result.name === CHECK)?.detail).toContain(
      'worktree-scoped core.hooksPath values',
    );
    const runner = all.find((result) => result.name === RUNNER_CHECK);
    expect(runner?.status).toBe('DRIFT');
    expect(runner?.detail).toContain('worktree-scoped core.hooksPath values');
    expect(syncHookRunner([], wt)).toBe(0);
    expect(git(wt, 'config', '--worktree', '--get-all', 'core.hooksPath')).toBe(before);
  });

  it('--dry-run reports the pin without touching it', async () => {
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    pin(root, wt, join(root, '.husky', '_'));

    expect(syncHookRunner(['--dry-run'], wt)).toBe(0);

    expect(scopedPin(wt)).toBe(join(root, '.husky', '_'));
  });

  it('surfaces a benign per-checkout pin, which shadows every repo-wide write in silence', async () => {
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    pin(root, wt, join(wt, '.husky', '_')); // its own runner — nothing is wrong, but it IS invisible

    const result = await ownerCheck(wt);

    expect(result?.status).toBe('OK');
    expect(result?.detail).toContain('pins its own core.hooksPath');
    syncHookRunner([], wt);
    expect(scopedPin(wt)).toBe(join(wt, '.husky', '_'));
  });

  it('adds no row at all to an ordinary repo’s doctor output', async () => {
    // Asserting the absence of ONE name would pass even if the check were never wired in; assert
    // the whole result set instead.
    const root = huskyRepo('MAIN');
    const before = (await results(root)).map((r) => r.name);

    expect(before).toContain(RUNNER_CHECK);
    expect(before).not.toContain(CHECK);
  });

  it('judges a monorepo package subdir against the git root', async () => {
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    const pkg = join(wt, 'services', 'api');
    mkdirSync(pkg, { recursive: true });
    pin(root, wt, join(root, '.husky', '_'));

    expect((await ownerCheck(pkg))?.status).toBe('DRIFT');
  });

  it('stops calling the runner healthy when an override is the only thing wiring it', async () => {
    // With no shared value behind it, a pin at a sibling checkout means the only hooks that run here
    // are someone else's. Reporting that as OK stated the defect as health — and would have handed
    // sync-hook-runner a licence to clear the one thing still gating this checkout.
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    git(root, 'config', '--unset', 'core.hooksPath');
    pin(root, wt, join(root, '.husky', '_'));

    const all = await results(wt);
    expect(all.find((r) => r.name === RUNNER_CHECK)?.status).toBe('DRIFT');

    syncHookRunner([], wt);
    expect(scopedPin(wt)).toBe(join(root, '.husky', '_'));
  });
});

describe('self-host doctor — the dogfood repo owes itself the same verdict', () => {
  it('reports a foreign pin and fails, on the path collectResults never reaches', async () => {
    // devkit itself is developed almost entirely from linked worktrees, and `devkit doctor` returns
    // from runSelfHostDoctor BEFORE collectResults — so wiring the check into collectResults alone
    // would leave it dead in the one repo most likely to hit this.
    const root = huskyRepo('MAIN');
    const wt = worktree(root, 'feature');
    pin(root, wt, join(root, '.husky', '_'));
    // Drop the committed hook so the generator comparison short-circuits: rebuilding the self-host
    // block needs devkit's own package.json bin map, which no fixture can stand in for. The hook
    // wiring under test runs after that branch either way.
    rmSync(join(wt, '.husky', 'pre-commit'));
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.join(' '));
    });

    const code = await runSelfHostDoctor(
      wt,
      { components: { skills: false, agents: false } },
      false,
    );

    log.mockRestore();
    expect(lines.join('\n')).toContain(CHECK);
    expect(lines.join('\n')).toContain('run ITS hooks');
    expect(code).toBe(1);
  });
});

describe('sync-hook-runner — staging still works', () => {
  it('force-adds a gitignored runner and then finds nothing left to do', () => {
    const root = mkTmp('doctor-hookspath-stage-');
    git(root, 'init', '-q');
    mkdirSync(join(root, '.husky', '_'), { recursive: true });
    writeFileSync(join(root, '.husky', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(root, '.husky', '_', '.gitignore'), '*');
    writeFileSync(join(root, '.husky', '_', 'h'), '#!/usr/bin/env sh\n');
    writeFileSync(join(root, '.husky', '_', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    git(root, 'config', 'core.hooksPath', '.husky/_');

    expect(syncHookRunner([], root)).toBe(0);

    expect(git(root, 'ls-files', '.husky/_').trim().split('\n')).toContain('.husky/_/pre-commit');
    expect(existsSync(join(root, '.husky', '_', 'h'))).toBe(true);
  });
});
