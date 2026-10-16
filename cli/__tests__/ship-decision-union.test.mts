import type { ExecFileSyncOptions } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { today } from '../../gate-engine/decisions/decision-format.mts';
import { scanCorpus } from '../../gate-engine/decisions/integrity/scan.mts';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import { advanceBase, PREFLIGHT_BLOCK, seedForked, shipBase } from './_ship-base-fixture.mts';
import {
  dirs,
  dropWorktree,
  GIT_ENV,
  localBranchExists,
  scriptPath,
} from './_ship-branch-fixture.mts';

const repoFile = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const DECISIONS_CLI = repoFile('gate-engine/decisions/cli.mts');
const ATTRIBUTES = readFileSync(repoFile('.gitattributes'), 'utf8');
const AXIS = 'docs/decisions/ax.md';
const TARGET = ['--target', '--context', 'c', '--ruling', 'r', '--consequences', 'p'];
const TARGET_REST = ['--tradeoff', 't', '--vision-fit', 'n/a'];
const MISFILED = 'would mis-file your decision entries';

/** `guard-decisions add ax …` in `cwd`, the way a branch records a decision. */
function decide(cwd: string, ...args: string[]) {
  execFileSync(process.execPath, [DECISIONS_CLI, 'add', 'ax', ...args], {
    cwd,
    env: { ...process.env, DECISIONS_NO_EMBED: '1' },
    stdio: 'ignore',
  });
}

/** A fork point carrying one axis with a Target and a note, under `attributes`. */
function seedAxis(attributes = ATTRIBUTES) {
  return seedForked((d) => {
    if (attributes) writeFileSync(join(d, '.gitattributes'), attributes);
    decide(d, ...TARGET, ...TARGET_REST, '--new');
    decide(d, '--note', 'fork note');
  });
}

const ANCHOR = join(scriptPath, '..', 'patch-anchor.sh');

interface AxisFixture {
  dir: string;
  forkPoint: string;
  git: (args: string[], opts?: ExecFileSyncOptions) => string;
}

/** Staging's own apply of the caller's axis edit onto `tip`, with the checker looked up in `scriptDir`. */
function stageArm(fx: AxisFixture, tip: string, scriptDir = join(ANCHOR, '..')) {
  fx.git(['fetch', '-q', 'origin', 'base'], { stdio: 'ignore' });
  const wt = join(fx.dir, '.ship-wt');
  fx.git(['worktree', 'add', '-q', '--detach', wt, tip], { stdio: 'ignore' });
  const scratch = join(fx.dir, '.ship-scratch');
  mkdirSync(scratch);
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      '. "$1"; SCRIPT_DIR=$8; GIT_PATHS=(":(top,literal)$5"); ' +
        'ship_apply_text_arm "$2" "$3" "$4" base "$6/p" "$6/e" --worktree "$7"',
      '_',
      ANCHOR,
      fx.dir,
      tip,
      fx.forkPoint,
      AXIS,
      scratch,
      wt,
      scriptDir,
    ],
    { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } },
  );
}

describe('ship --base: concurrent decision records under merge=union', () => {
  it('ships a note when the base already merged another note on the same axis', () => {
    const { dir, env, git, bare } = seedAxis();
    advanceBase(bare, (c) => decide(c, '--note', 'base note'));
    decide(dir, '--note', 'caller note');

    const r = shipBase(dir, env, 'feat/notes', [AXIS]);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    const shipped = git(['show', `feat/notes:${AXIS}`]);
    expect(shipped.indexOf('base note')).toBeGreaterThan(-1);
    expect(shipped.indexOf('base note')).toBeLessThan(shipped.indexOf('caller note'));
    expect(git(['diff', '--numstat', 'origin/base', 'feat/notes']).trim()).toBe(`1\t0\t${AXIS}`);
    const corpus = mkdtempSync(join(tmpdir(), 'union-corpus-'));
    dirs.push(corpus);
    writeFileSync(join(corpus, 'ax.md'), shipped);
    expect(scanCorpus(corpus).findings).toEqual([]);
  });

  it('still conflicts without the attribute', () => {
    const { dir, env, git, bare } = seedAxis('');
    advanceBase(bare, (c) => decide(c, '--note', 'base note'));
    decide(dir, '--note', 'caller note');

    const r = shipBase(dir, env, 'feat/plain', [AXIS]);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('changed the same region');
  });

  it('refuses before any branch when the base re-targeted the axis under the note', () => {
    const { dir, env, git, bare } = seedAxis();
    advanceBase(bare, (c) => decide(c, ...TARGET, ...TARGET_REST, '--evidence-change', 'e'));
    decide(dir, '--note', 'note meant for the first ruling');

    const r = shipBase(dir, env, 'feat/retarget', [AXIS]);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(PREFLIGHT_BLOCK);
    expect(r.stderr).toContain(MISFILED);
    expect(r.stderr).toContain(`git checkout origin/base -- ${AXIS}`);
    expect(localBranchExists(git, 'feat/retarget')).toBe(false);
  });

  it('refuses when a same-day base note would renumber an Amends pointer', () => {
    const { dir, env, git, bare } = seedAxis();
    advanceBase(bare, (c) => decide(c, '--note', 'base note'));
    decide(dir, '--note', 'caller note');
    decide(dir, '--note', `**Amends:** note:${today()}~2 — narrows the caller note`);

    const r = shipBase(dir, env, 'feat/amends', [AXIS]);
    dropWorktree(git, r.stderr);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('renumbers that pointer');
  });

  it('staging refuses the same re-target the preflight does', () => {
    const { dir, git, bare, forkPoint } = seedAxis();
    const tip = advanceBase(bare, (c) =>
      decide(c, ...TARGET, ...TARGET_REST, '--evidence-change', 'e'),
    );
    decide(dir, '--note', 'note meant for the first ruling');

    const r = stageArm({ dir, git, forkPoint }, tip);

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain(MISFILED);
    expect(r.stderr).not.toContain('could not verify');
  });

  it('never consults the checker when only the caller changed the axis', () => {
    const fx = seedAxis();
    const tip = advanceBase(fx.bare, (c) => writeFileSync(join(c, 'other.txt'), 'base\n'));
    decide(fx.dir, '--note', 'caller note');

    const r = stageArm(fx, tip, '/nonexistent');

    expect(r.status, r.stderr).toBe(0);
  });

  it('fails closed with its own message when the checker cannot run', () => {
    const fx = seedAxis();
    const tip = advanceBase(fx.bare, (c) => decide(c, '--note', 'base note'));
    decide(fx.dir, '--note', 'caller note');

    const r = stageArm(fx, tip, '/nonexistent');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not verify');
  });

  it('names the clash when two branches each create the same axis', () => {
    const fx = seedForked((d) => writeFileSync(join(d, '.gitattributes'), ATTRIBUTES));
    const tip = advanceBase(fx.bare, (c) => decide(c, ...TARGET, ...TARGET_REST, '--new'));
    decide(
      fx.dir,
      '--target',
      '--context',
      'c2',
      '--ruling',
      'r2',
      '--consequences',
      'p',
      ...TARGET_REST,
      '--new',
    );

    fx.git(['add', AXIS]); // tracked, so the fork-anchored patch carries it
    const r = stageArm(fx, tip);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(MISFILED);
    expect(r.stderr).not.toContain('could not verify');
  });

  it('fails closed when git cannot list what the merge changed', () => {
    const { dir, git } = seedAxis();
    const r = spawnSync(
      '/bin/bash',
      [
        '-c',
        '. "$1"; _ship_union_guard "$2" no-such-rev HEAD base --worktree "$2"',
        '_',
        ANCHOR,
        dir,
      ],
      { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not verify');
    expect(git(['status', '--porcelain'])).toBe('');
  });

  it('marks axis files union and keeps INDEX.md on the line merge', () => {
    const out = execFileSync(
      'git',
      ['check-attr', 'merge', '--', 'docs/decisions/coverage-gate.md', 'docs/decisions/INDEX.md'],
      { cwd: repoFile('.'), encoding: 'utf8' },
    );
    expect(out).toBe(
      'docs/decisions/coverage-gate.md: merge: union\ndocs/decisions/INDEX.md: merge: set\n',
    );
  });
});
