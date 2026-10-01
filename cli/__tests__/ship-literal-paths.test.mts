import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  DIR_RE,
  dropWorktree,
  createScopedPreservedCommit,
  localBranchExists,
  publishEnvFor,
  reshipScript,
  scriptPath,
  seedReshipRepo,
  seedShipRepo,
  seedShipRepoLocalRemote,
  WT_RE,
} from './_ship-branch-fixture.mts';

// sc-2425: an explicit `-- <path>` names ONE file, whatever bytes its name holds — a raw pathspec
// read `:(exclude)*` or `*.txt` as magic or a glob and silently changed what shipped.

const MAGIC = ':(exclude)*';
const GLOB = '*.txt';

function seed(files: Record<string, string>) {
  const seeded = seedShipRepoLocalRemote();
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(seeded.dir, name, '..'), { recursive: true });
    writeFileSync(join(seeded.dir, name), body);
  }
  seeded.git(['add', '--', ...Object.keys(files).map((f) => `:(literal)${f}`)], {
    stdio: 'ignore',
  });
  seeded.git(['commit', '-q', '-m', 'tracked'], { stdio: 'ignore' });
  seeded.git(['push', '-q', 'origin', 'work:work'], { stdio: 'ignore' });
  return seeded;
}

function ship(
  dir: string,
  env: NodeJS.ProcessEnv,
  branch: string,
  paths: string[],
  opts: { cwd?: string; extraEnv?: Record<string, string> } = {},
) {
  return spawnSync('/bin/bash', [scriptPath, branch, 'ship it', '--', ...paths], {
    cwd: opts.cwd ?? dir,
    input: 'b\n',
    encoding: 'utf8',
    env: { ...env, SHIP_DRY_RUN: '1', ...opts.extraEnv },
  });
}

/** NUL-exact name-status of what the shipped branch changed against the base it forked from. */
function shipped(git: (args: string[]) => string, branch: string): string[] {
  return git(['diff', '--name-status', '--no-renames', '-z', `${branch}^`, branch])
    .split('\0')
    .filter(Boolean);
}

describe('ship-branch.sh — explicit paths are literal files (sc-2425)', () => {
  it('a filename that looks like exclude magic ships as that one file', () => {
    const { dir, env, git } = seed({ [MAGIC]: 'a\n', 'other.txt': 'a\n' });
    writeFileSync(join(dir, MAGIC), 'b\n');
    writeFileSync(join(dir, 'other.txt'), 'b\n');

    const r = ship(dir, env, 'feat/magic', [MAGIC]);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(shipped(git, 'feat/magic')).toEqual(['M', MAGIC]);
  });

  it('a filename holding a glob does not sweep in the files it would match', () => {
    const { dir, env, git } = seed({ [GLOB]: 'a\n', 'a.txt': 'a\n' });
    writeFileSync(join(dir, GLOB), 'b\n');
    writeFileSync(join(dir, 'a.txt'), 'b\n');

    const r = ship(dir, env, 'feat/glob', [GLOB]);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(shipped(git, 'feat/glob')).toEqual(['M', GLOB]);
  });

  it('deleting a glob-named file ships only that deletion, never its matches', () => {
    const { dir, env, git } = seed({ [GLOB]: 'a\n', 'a.txt': 'a\n' });
    rmSync(join(dir, GLOB));
    writeFileSync(join(dir, 'a.txt'), 'b\n');

    const r = ship(dir, env, 'feat/glob-delete', [GLOB]);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(shipped(git, 'feat/glob-delete')).toEqual(['D', GLOB]);
  });

  it('an untracked glob-named file ships alone, not beside untracked matches', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, GLOB), 'new\n');
    writeFileSync(join(dir, 'stray.txt'), 'new\n');

    const r = ship(dir, env, 'feat/glob-new', [GLOB]);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(shipped(git, 'feat/glob-new')).toEqual(['A', GLOB]);
  });

  // Untracked and gitignored paths are enumerated by git, then copied and added one by one.
  for (const [label, name] of [
    ['magic', MAGIC],
    ['newline', 'two\nlines.txt'],
  ]) {
    it(`an untracked ${label}-named file ships as exactly that file`, () => {
      const { dir, env, git } = seedShipRepoLocalRemote();
      writeFileSync(join(dir, name), 'new\n');
      writeFileSync(join(dir, 'stray.txt'), 'new\n');

      const r = ship(dir, env, 'feat/untracked-odd', [name]);
      dropWorktree(git, r.stderr);

      expect(r.status, r.stderr).toBe(0);
      expect(shipped(git, 'feat/untracked-odd')).toEqual(['A', name]);
    });

    it(`a gitignored ${label}-named file is force-added as exactly that file`, () => {
      const { dir, env, git } = seedShipRepoLocalRemote();
      writeFileSync(join(dir, '.gitignore'), '.devkit/ship-intent-*\n*\n!.gitignore\n!.husky/\n');
      writeFileSync(join(dir, name), 'new\n');
      writeFileSync(join(dir, 'stray.txt'), 'new\n');

      const r = ship(dir, env, 'feat/ignored-odd', [name]);
      dropWorktree(git, r.stderr);

      expect(r.status, r.stderr).toBe(0);
      expect(shipped(git, 'feat/ignored-odd')).toEqual(['A', name]);
    });
  }

  it('a filename containing a newline ships once and intact', () => {
    const name = 'two\nlines.txt';
    const { dir, env, git } = seed({ [name]: 'a\n', 'other.txt': 'a\n' });
    writeFileSync(join(dir, name), 'b\n');
    writeFileSync(join(dir, 'other.txt'), 'b\n');

    const r = ship(dir, env, 'feat/newline', [name]);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(shipped(git, 'feat/newline')).toEqual(['M', name]);
  });

  // Ambient pathspec modes are the caller's shell, not an input. GIT_LITERAL_PATHSPECS=1 would read
  // the `:(literal)` prefix as part of the filename; GIT_GLOB_PATHSPECS=1 is fatal beside it.
  for (const knob of [
    'GIT_LITERAL_PATHSPECS',
    'GIT_GLOB_PATHSPECS',
    'GIT_NOGLOB_PATHSPECS',
    'GIT_ICASE_PATHSPECS',
  ]) {
    it(`ambient ${knob}=1 does not change which file ships`, () => {
      const { dir, env, git } = seed({ [GLOB]: 'a\n', 'a.txt': 'a\n' });
      writeFileSync(join(dir, GLOB), 'b\n');
      writeFileSync(join(dir, 'a.txt'), 'b\n');

      const r = ship(dir, env, 'feat/ambient', [GLOB], { extraEnv: { [knob]: '1' } });
      dropWorktree(git, r.stderr);

      expect(r.status, r.stderr).toBe(0);
      expect(shipped(git, 'feat/ambient')).toEqual(['M', GLOB]);
    });
  }

  it('the ./ spelling still names the root file', () => {
    const { dir, env, git } = seed({ [GLOB]: 'a\n', 'a.txt': 'a\n' });
    writeFileSync(join(dir, GLOB), 'b\n');
    writeFileSync(join(dir, 'a.txt'), 'b\n');

    const r = ship(dir, env, 'feat/dot', [`./${GLOB}`]);
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(shipped(git, 'feat/dot')).toEqual(['M', GLOB]);
  });

  // Paths are repo-root relative (git runs at -C "$ROOT"); a cwd-relative `[ -d ]` let a
  // root-level directory through from a subdirectory, and git then recursed into it.
  it('refuses a root-level directory even when invoked from a subdirectory', () => {
    const { dir, env, git } = seed({ 'lib/one.ts': '1\n', 'sub/keep': '' });
    writeFileSync(join(dir, 'lib/one.ts'), '2\n');

    const r = ship(dir, env, 'feat/dir-from-sub', ['lib'], { cwd: join(dir, 'sub') });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(DIR_RE);
    expect(localBranchExists(git, 'feat/dir-from-sub')).toBe(false);
  });
});

// `--pr` re-push stages each path on its own: `add` when present, `rm --ignore-unmatch` when gone. A
// raw glob in that `rm` deleted every sibling it matched from the PR branch.
describe('reship.sh --pr — explicit paths are literal files (sc-2425)', () => {
  function seedPr(files: Record<string, string>) {
    const seeded = seedReshipRepo();
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(seeded.dir, name, '..'), { recursive: true });
      writeFileSync(join(seeded.dir, name), body);
    }
    seeded.git(['add', '--', ...Object.keys(files).map((f) => `:(literal)${f}`)], {
      stdio: 'ignore',
    });
    seeded.git(['commit', '-q', '-m', 'pr content'], { stdio: 'ignore' });
    seeded.git(['push', '-q', '-f', 'origin', 'work:pr-open'], { stdio: 'ignore' });
    return seeded;
  }

  function reship(dir: string, env: NodeJS.ProcessEnv, paths: string[], extraEnv = {}) {
    const r = spawnSync('/bin/bash', [reshipScript, 'pr-open', 'again', '--pr', '--', ...paths], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1', ...extraEnv },
    });
    const wt = WT_RE.exec(r.stderr)?.[1];
    return { r, wt };
  }

  function stacked(env: NodeJS.ProcessEnv, wt: string): string[] {
    return spawnSync(
      'git',
      ['-C', wt, 'diff', '--name-status', '--no-renames', '-z', 'HEAD~1', 'HEAD'],
      {
        encoding: 'utf8',
        env,
      },
    )
      .stdout.split('\0')
      .filter(Boolean);
  }

  it('deleting a glob-named file removes only it; the files it would match survive', () => {
    const { dir, env, git } = seedPr({ [GLOB]: 'a\n', 'a.txt': 'a\n', 'b.txt': 'a\n' });
    rmSync(join(dir, GLOB));

    const { r, wt } = reship(dir, env, [GLOB]);

    expect(r.status, r.stderr).toBe(0);
    expect(stacked(env, wt!)).toEqual(['D', GLOB]);
    git(['worktree', 'remove', '--force', wt!], { stdio: 'ignore' });
  });

  it('a modified magic-named file re-pushes as that one file', () => {
    const { dir, env, git } = seedPr({ [MAGIC]: 'a\n', 'other.txt': 'a\n' });
    writeFileSync(join(dir, MAGIC), 'b\n');
    writeFileSync(join(dir, 'other.txt'), 'b\n');

    const { r, wt } = reship(dir, env, [MAGIC], { GIT_GLOB_PATHSPECS: '1' });

    expect(r.status, r.stderr).toBe(0);
    expect(stacked(env, wt!)).toEqual(['M', MAGIC]);
    git(['worktree', 'remove', '--force', wt!], { stdio: 'ignore' });
  });

  it('refuses a root-level directory even when invoked from a subdirectory', () => {
    const { dir, env } = seedPr({ 'lib/one.ts': '1\n', 'sub/keep': '' });
    const r = spawnSync('/bin/bash', [reshipScript, 'pr-open', 'again', '--pr', '--', 'lib'], {
      cwd: join(dir, 'sub'),
      input: '',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(DIR_RE);
  });
});

// Resume filters out deleted briefed paths, then re-adds the rest: a raw `*.txt` survived the filter
// through an unbriefed sibling and swept that sibling's edit in, refusing a correct commit.
describe('ship-branch.sh resume — explicit paths are literal files (sc-2425)', () => {
  it('resumes a commit that deleted a glob-named path without absorbing an unbriefed match', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    const preserved = createScopedPreservedCommit({
      dir,
      env,
      git,
      branch: 'feat/glob-resume',
      tracked: { [GLOB]: 'bye\n', 'a.txt': 'a\n' },
      deleted: [GLOB],
    });
    git(['update-ref', 'refs/devkit/ship-receipts/feat/glob-resume', preserved]);
    writeFileSync(join(dir, 'a.txt'), 'an unbriefed edit\n');

    const retry = spawnSync('/bin/bash', [scriptPath, 'feat/glob-resume', 'ship it', '--', GLOB], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: publishEnv,
    });

    expect(retry.status, retry.stderr).toBe(0);
    expect(
      spawnSync('git', ['-C', bare, 'rev-parse', 'feat/glob-resume'], {
        encoding: 'utf8',
        env,
      }).stdout.trim(),
    ).toBe(preserved);
  });
});

// Without -z git C-quotes these names; the quoted spelling names no file, so the staged-set check
// reported a formatter no-op as lost work and falsely aborted the ship.
describe('ship-branch.sh staged-set check — odd names survive a formatter no-op', () => {
  for (const name of ['café.txt', 'say "hi".txt', 'back\\slash.txt', 'two\nlines.txt']) {
    it(`allows a formatter no-op on ${JSON.stringify(name)}`, () => {
      const { dir, env, git } = seedShipRepo({
        hookBody: "git restore --source=HEAD --staged --worktree -- . ':(exclude)note.txt'\nexit 0",
      });
      writeFileSync(join(dir, name), 'base\n');
      git(['add', '--', name], { stdio: 'ignore' });
      git(['commit', '--no-verify', '-qm', 'odd name'], { stdio: 'ignore' });
      writeFileSync(join(dir, name), 'needs formatting\n');
      writeFileSync(join(dir, 'note.txt'), 'real change\n');

      const r = spawnSync('/bin/bash', [scriptPath, 'feat/odd-noop', 't', name, 'note.txt'], {
        cwd: dir,
        input: 'b\n',
        encoding: 'utf8',
        env: { ...env, SHIP_DRY_RUN: '1' },
      });

      dropWorktree(git, r.stderr);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/normalized to its base content/);
      expect(r.stderr).not.toMatch(/missing work that was staged/);
      expect(r.stderr).toMatch(/DRY: committed locally/);
    });
  }
});
