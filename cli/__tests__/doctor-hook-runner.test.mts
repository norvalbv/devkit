/**
 * doctor's worktree-safety check for the hook runner.
 *
 * Husky pins a RELATIVE core.hooksPath (`.husky/_`) and gitignores the runner it points at, so a
 * linked worktree checks out with hooksPath resolving to nothing and git silently runs ZERO hooks.
 * These fixtures build that exact shape with real git — the bug is a property of git + gitignore,
 * so mocking either would prove nothing.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectResults } from '../commands/doctor.mts';
import { rootRegistry } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const CHECK = 'hook runner (worktree-safe)';
const HUSKY_CFG = { components: { husky: true, biome: false, tsconfig: false, guards: [] } };

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

/** A repo shaped exactly like a husky install: relative hooksPath + a self-gitignored runner. */
function huskyRepo({ runner = true } = {}): string {
  const root = mkTmp('doctor-hook-runner-');
  git(root, 'init', '-q');
  mkdirSync(join(root, '.husky'), { recursive: true });
  writeFileSync(join(root, '.husky', 'pre-commit'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  if (runner) {
    mkdirSync(join(root, '.husky', '_'), { recursive: true });
    writeFileSync(join(root, '.husky', '_', '.gitignore'), '*');
    writeFileSync(join(root, '.husky', '_', 'h'), '#!/usr/bin/env sh\n');
    writeFileSync(join(root, '.husky', '_', 'pre-commit'), '. "$(dirname "$0")/h"\n', {
      mode: 0o755,
    });
  }
  git(root, 'config', 'core.hooksPath', '.husky/_');
  return root;
}

async function runnerCheck(root: string, cfg: object = HUSKY_CFG) {
  const { results } = await collectResults(root, cfg, { name: 'config.json', status: 'OK' });
  const result = results.find((r) => r.name === CHECK);
  if (!result) throw new Error(`no "${CHECK}" result — check is not wired into collectResults`);
  return result;
}

describe('doctor — hook runner survives `git worktree add`', () => {
  it('flags a gitignored runner, because no ordinary `git add` can ever carry it', async () => {
    const result = await runnerCheck(huskyRepo());

    expect(result.status).toBe('DRIFT');
    expect(result.detail).toMatch(/gitignored/);
    expect(result.remediation).toMatch(/^devkit sync-hook-runner /);
    // Both the per-hook stub and husky's shared dispatcher are unreachable, so both must be named.
    expect(result.remediation).toContain('.husky/_/pre-commit');
    expect(result.remediation).toContain('.husky/_/h');
  });

  it('passes once the runner is force-added, since tracked files check out everywhere', async () => {
    const root = huskyRepo();
    git(root, 'add', '-f', '.husky/_/h', '.husky/_/pre-commit');

    const result = await runnerCheck(root);

    expect(result.status).toBe('OK');
    expect(result.detail).toMatch(/reachable/);
  });

  it('does not flag a merely-uncommitted runner — the next commit carries it', async () => {
    const root = mkTmp('doctor-hook-runner-plain-');
    git(root, 'init', '-q');
    mkdirSync(join(root, '.husky'), { recursive: true });
    // Standalone shape: hooksPath IS the committed .husky dir, nothing gitignored.
    writeFileSync(join(root, '.husky', 'pre-commit'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    git(root, 'config', 'core.hooksPath', '.husky');

    expect((await runnerCheck(root)).status).toBe('OK');
  });

  it('reports a hooksPath that resolves to nothing as MISSING, not merely drifted', async () => {
    const root = huskyRepo({ runner: false });

    const result = await runnerCheck(root);

    expect(result.status).toBe('MISSING');
    expect(result.detail).toMatch(/resolves to nothing/);
  });

  it('handles a custom hooksPath with no .husky dir instead of crashing', async () => {
    // `devkit init --standalone` leaves an existing custom hooksPath alone, so this layout is live.
    const root = mkTmp('doctor-hook-runner-custom-');
    git(root, 'init', '-q');
    mkdirSync(join(root, '.githooks'), { recursive: true });
    writeFileSync(join(root, '.githooks', 'pre-commit'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    git(root, 'config', 'core.hooksPath', '.githooks');

    // Reading `.husky` unconditionally would throw ENOENT here and take doctor down with it.
    expect((await runnerCheck(root)).status).toBe('OK');
  });

  it('reports an empty runner directory rather than passing it as reachable', async () => {
    const root = huskyRepo({ runner: false });
    mkdirSync(join(root, '.husky', '_'), { recursive: true });

    const result = await runnerCheck(root);

    // An empty runner is just the all-stubs-missing case; a vacuous "0 files reachable" would hide it.
    expect(result.status).toBe('MISSING');
    expect(result.detail).toMatch(/pre-commit declared in \.husky\/ but absent/);
  });

  it('flags one missing stub even when its siblings are perfectly wired', async () => {
    // A repo that adds a commit-msg guard but never regenerates the runner: pre-commit is tracked
    // and reachable, commit-msg silently runs nothing. Dropping absent stubs would report OK here.
    const root = huskyRepo();
    writeFileSync(join(root, '.husky', 'commit-msg'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    git(root, 'add', '-f', '.husky/_/h', '.husky/_/pre-commit');

    const result = await runnerCheck(root);

    expect(result.status).toBe('MISSING');
    expect(result.detail).toMatch(/commit-msg/);
  });

  it('ignores a non-hook file sitting in .husky/', async () => {
    const root = huskyRepo();
    writeFileSync(join(root, '.husky', 'README.md'), 'notes\n');
    git(root, 'add', '-f', '.husky/_/h', '.husky/_/pre-commit');

    // No `_/README.md` stub is owed — matching by git hook name, not by directory listing.
    expect((await runnerCheck(root)).status).toBe('OK');
  });

  it('treats an unset hooksPath with no installed hook as healthy', async () => {
    const root = mkTmp('doctor-hook-runner-bare-');
    git(root, 'init', '-q');

    expect((await runnerCheck(root)).status).toBe('OK');
  });

  it('flags an installed hook that nothing points core.hooksPath at', async () => {
    // Real shape: `.husky/pre-commit` is committed but husky never ran (absent dependency, or an
    // install that skipped `prepare`), so git falls back to its own hooks dir and gates NOTHING.
    const root = huskyRepo();
    git(root, 'config', '--unset', 'core.hooksPath');

    const result = await runnerCheck(root);

    expect(result.status).toBe('DRIFT');
    expect(result.detail).toMatch(/NOTHING gates/);
  });

  it('still flags when an UNRELATED hook occupies git’s own hooks dir', async () => {
    const root = huskyRepo();
    git(root, 'config', '--unset', 'core.hooksPath');
    // Runs INSTEAD of the devkit hook, not as well as it — the gates are still dead.
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });

    expect((await runnerCheck(root)).status).toBe('DRIFT');
  });

  it('accepts a default hook that delegates to .husky', async () => {
    const root = huskyRepo();
    git(root, 'config', '--unset', 'core.hooksPath');
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n. ./.husky/pre-commit\n', {
      mode: 0o755,
    });

    expect((await runnerCheck(root)).status).toBe('OK');
  });
});
