import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import { rewriteRepo } from './_reship-rewrite-fixture.mts';
import {
  EPHEMERAL_WT_RE,
  GATE_RAN_RE,
  GIT_ENV,
  localBranchExists,
  NOTHING_RE,
  reshipScript,
  scriptPath,
  seedReshipRepo,
  seedShipRepo,
} from './_ship-branch-fixture.mts';

// zsh does not word-split an unquoted `$PATHS`, so a whole list arrives as ONE argument. Diff-family
// git matches nothing for it, which ship used to report as "nothing to commit … misspelled path?".
const UNMATCHED_RE = /briefed path names nothing ship can stage/;
const UNSPLIT_RE = /one argument holds 2 paths — an unquoted \$VAR is not word-split in zsh/;
const JOINED = 'note.txt\nother.txt';

function ship(script: string, dir: string, env: NodeJS.ProcessEnv, argv: string[]) {
  return spawnSync('/bin/bash', [script, ...argv], {
    cwd: dir,
    input: 'body\n',
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...env, SHIP_DRY_RUN: '1' },
  });
}

function seedTwoNewFiles(hookBody = 'echo GATE_RAN >&2; exit 0') {
  const seeded = seedShipRepo({ hookBody });
  writeFileSync(join(seeded.dir, 'note.txt'), 'a\n');
  writeFileSync(join(seeded.dir, 'other.txt'), 'b\n');
  return seeded;
}

describe('ship refuses a briefed path that names nothing', () => {
  it('an unsplit list is named as such before any gate, branch or worktree', () => {
    const { dir, env, git } = seedTwoNewFiles();
    const r = ship(scriptPath, dir, env, ['feat/joined', 't', '--', JOINED]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(UNMATCHED_RE);
    expect(r.stderr).toMatch(UNSPLIT_RE);
    expect(r.stderr).toContain('\n    note.txt other.txt\n');
    expect(r.stderr).not.toMatch(NOTHING_RE);
    expect(r.stderr).not.toMatch(GATE_RAN_RE);
    expect(git(['worktree', 'list'])).not.toMatch(EPHEMERAL_WT_RE);
    expect(localBranchExists(git, 'feat/joined')).toBe(false);
  });

  it('an unsplit list beside a valid path refuses instead of shipping the valid subset', () => {
    const { dir, env, git } = seedTwoNewFiles();
    writeFileSync(join(dir, 'third.txt'), 'c\n');
    const r = ship(scriptPath, dir, env, ['feat/subset', 't', '--', 'third.txt', JOINED]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(UNSPLIT_RE);
    expect(r.stderr).not.toMatch(GATE_RAN_RE);
    expect(localBranchExists(git, 'feat/subset')).toBe(false);
  });

  it('--resume judges the paths this retry adds', () => {
    const { dir, env } = seedTwoNewFiles('exit 1');
    writeFileSync(join(dir, '.gitignore'), '.devkit/\n');
    writeFileSync(join(dir, 'first.txt'), 'f\n');
    expect(ship(scriptPath, dir, env, ['feat/resume', 't', '--', 'first.txt']).status).not.toBe(0);
    const r = ship(scriptPath, dir, env, ['--resume', 'feat/resume', '--', JOINED]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(UNSPLIT_RE);
  });

  it('reship append refuses a typo against origin/<branch>', () => {
    const { dir, env } = seedReshipRepo();
    writeFileSync(join(dir, 'note.txt'), 'delta\n');
    const r = ship(reshipScript, dir, env, ['pr-open', 't', 'note.txt', 'nte.txt']);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/names nothing ship can stage \(.*\): nte\.txt\n/);
  });

  it('reship rewrite accepts a dropped PR-added file, which lives only in the PR head', () => {
    const { dir, env, g } = rewriteRepo({ extraPath: true });
    g(['rm', '-q', 'extra.txt']);
    const r = ship(reshipScript, dir, env, [
      'feat/pr',
      'drop extra',
      '--pr',
      '--base',
      'main',
      '--',
      'conflict.txt',
      'extra.txt',
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(UNMATCHED_RE);
  });
});
