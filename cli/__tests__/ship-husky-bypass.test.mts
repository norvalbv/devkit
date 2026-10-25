/** A package-mode ship runs through husky's real runner, which exits 0 under HUSKY=0 before it
 *  runs `.husky/pre-commit`: ship must prove devkit's block ran, not just that a hook started. */
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  dirs,
  dropWorktree,
  ghStub,
  remoteBranchExists,
  reshipScript,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const HUSKY_RUNNER = join(dirname(createRequire(import.meta.url).resolve('husky')), 'husky');
const SENTINEL = `[ -n "\${DEVKIT_SHIP:-}" ] && echo 'devkit-gates: chain start' >&2`;
const NO_OUTPUT_RE = /NO gate output captured/;
const HUSKY_REMEDY_RE = /HUSKY=0.*unset HUSKY/s;
const REGEN_REMEDY_RE = /devkit init --force/;

const block = (body: string) => `# >>> devkit-guards >>>\n${body}\n# <<< devkit-guards <<<\n`;
const FAILING_BLOCK = block(`${SENTINEL}\necho HUSKY_BLOCK_RAN >&2\nexit 1`);

/** husky 9's on-disk layout: the 2-line `_/pre-commit` stub, the `_/h` runner, and the committed
 *  `.husky/pre-commit` script the runner derives from its own path. */
function seedHuskyRepo(hookScript: string) {
  const seeded = seedShipRepoLocalRemote();
  const { dir, git } = seeded;
  writeFileSync(join(dir, '.husky/pre-commit'), hookScript);
  git(['add', '.husky/pre-commit'], { stdio: 'ignore' });
  git(['commit', '-q', '--no-verify', '-m', 'hook'], { stdio: 'ignore' });
  git(['push', '-q', 'origin', 'work:work'], { stdio: 'ignore' });
  writeFileSync(join(dir, '.husky/_/pre-commit'), '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n');
  copyFileSync(HUSKY_RUNNER, join(dir, '.husky/_/h'));
  chmodSync(join(dir, '.husky/_/h'), 0o755);
  writeFileSync(join(dir, 'note.txt'), 'hi\n');
  // Never source the developer's real ~/.config/husky/init.sh.
  const xdg = mkdtempSync(join(tmpdir(), 'husky-xdg-'));
  dirs.push(xdg);
  return { ...seeded, xdg, env: { ...seeded.env, XDG_CONFIG_HOME: xdg, HUSKY: '' } };
}

function ship(dir: string, env: NodeJS.ProcessEnv, args: string[], script = scriptPath) {
  return spawnSync('/bin/bash', [script, ...args], {
    cwd: dir,
    input: 'b\n',
    encoding: 'utf8',
    env,
  });
}

describe('ship — package-mode husky runner', () => {
  it('blocks under HUSKY=0 instead of landing an ungated commit, and pushes nothing', () => {
    const { dir, env, bare } = seedHuskyRepo(FAILING_BLOCK);
    const stubBin = ghStub('exit 0');
    const r = ship(dir, { ...env, HUSKY: '0', PATH: `${stubBin}:${process.env.PATH}` }, [
      'feat/husky-env',
      't',
      'note.txt',
    ]);
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(NO_OUTPUT_RE);
    expect(r.stderr).toMatch(HUSKY_REMEDY_RE);
    expect(remoteBranchExists(bare, 'feat/husky-env')).toBe(false);
  });

  it('blocks when HUSKY=0 comes from husky init.sh rather than the environment', () => {
    const { dir, env, git, xdg } = seedHuskyRepo(FAILING_BLOCK);
    mkdirSync(join(xdg, 'husky'));
    writeFileSync(join(xdg, 'husky/init.sh'), 'export HUSKY=0\n');
    const r = ship(dir, { ...env, SHIP_DRY_RUN: '1' }, ['feat/husky-init', 't', 'note.txt']);
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(NO_OUTPUT_RE);
  });

  it('runs the block normally when HUSKY is unset', () => {
    const { dir, env, git } = seedHuskyRepo(block(`${SENTINEL}\necho HUSKY_BLOCK_RAN >&2`));
    const r = ship(dir, { ...env, SHIP_DRY_RUN: '1' }, ['feat/husky-ok', 't', 'note.txt']);
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/pre-commit gates ran/);
    const log = readFileSync(join(dir, '.devkit/last-ship-gates-feat-husky-ok.log'), 'utf8');
    expect(log).toContain('HUSKY_BLOCK_RAN');
  });

  it('blocks a devkit block that predates the sentinel and names the regenerate command', () => {
    const { dir, env, git } = seedHuskyRepo(block('echo OLD_BLOCK_RAN >&2'));
    const r = ship(dir, { ...env, SHIP_DRY_RUN: '1' }, ['feat/husky-old', 't', 'note.txt']);
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(REGEN_REMEDY_RE);
  });

  it('blocks a --dry-gates rehearsal under HUSKY=0', () => {
    const { dir, env } = seedHuskyRepo(FAILING_BLOCK);
    const r = ship(dir, { ...env, HUSKY: '0' }, [
      'feat/husky-dry',
      't',
      '--dry-gates',
      '--',
      'note.txt',
    ]);
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(NO_OUTPUT_RE);
  });

  it('blocks a re-ship (ship --pr) under HUSKY=0', () => {
    const { dir, env, git } = seedHuskyRepo(FAILING_BLOCK);
    git(['push', '-q', 'origin', 'work:pr-open'], { stdio: 'ignore' });
    const r = ship(
      dir,
      { ...env, HUSKY: '0', SHIP_DRY_RUN: '1' },
      ['pr-open', 't', 'note.txt'],
      reshipScript,
    );
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(NO_OUTPUT_RE);
  });
});
