import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const helper = fileURLToPath(new URL('./refuse-dir-paths.sh', import.meta.url));
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const REMEDY_LINE = /^ {2}cd .*$/m;

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
}

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'refuse-dir-'));
  roots.push(dir);
  return dir;
}

/** Source the helper and call it, the way ship-branch.sh and reship.sh do (under errexit + nounset). */
function refuse(root: string, paths: string[]) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      'set -euo pipefail; . "$1"; shift; ship_refuse_dir_paths "$@"',
      'refuse',
      helper,
      root,
      ...paths,
    ],
    { encoding: 'utf8' },
  );
}

/** Run the printed remedy exactly as an operator pasting it would, from `cwd`. */
function runRemedy(stderr: string, cwd: string): string[] {
  const line = REMEDY_LINE.exec(stderr)?.[0];
  expect(line).toBeDefined();
  const out = spawnSync('/bin/bash', ['-c', line!], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  });
  expect(out.status).toBe(0);
  return out.stdout.split('\n').filter(Boolean);
}

describe('ship_refuse_dir_paths', () => {
  it('passes files, deleted paths, and a symlink that points at a directory', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'a.ts'), 'x\n');
    symlinkSync('real', join(root, 'link'));
    const r = refuse(root, ['a.ts', 'gone.ts', 'link']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    // `link/` resolves THROUGH the link: git has no entry under that spelling, so it is refused.
    expect(refuse(root, ['link/']).stderr).toContain('(pass individual files): link/\n');
  });

  it('names every directory in one refusal, %q-quoted, including a trailing-slash spelling', () => {
    const root = tempRoot();
    for (const d of ['a', 'b c', 'd']) mkdirSync(join(root, d));
    writeFileSync(join(root, 'f.ts'), 'x\n');
    const r = refuse(root, ['a', 'f.ts', 'b c', 'd/']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('directory path not allowed (pass individual files): a b\\ c d/\n');
    expect(r.stderr).not.toContain('git ls-files -- '); // the old tracked-set remedy over-briefed
  });

  it('a refusal with no paths at all is not a refusal (empty array under nounset)', () => {
    expect(refuse(tempRoot(), []).status).toBe(0);
  });
});

describe('the printed remedy lists exactly the changed set', () => {
  function seed(): string {
    const root = tempRoot();
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'a@b.c']);
    git(root, ['config', 'user.name', 'a']);
    mkdirSync(join(root, 'd'));
    mkdirSync(join(root, 'e f'));
    mkdirSync(join(root, 'sub'));
    for (const f of ['modified', 'staged', 'deleted', 'unchanged', 'renamed']) {
      writeFileSync(join(root, 'd', f), `${f}\n`);
    }
    writeFileSync(join(root, 'e f', 'spaced'), 'x\n');
    writeFileSync(join(root, 'outside'), 'x\n');
    writeFileSync(join(root, '.gitignore'), 'd/ignored\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'base']);
    writeFileSync(join(root, 'd', 'modified'), 'changed\n');
    writeFileSync(join(root, 'd', 'staged'), 'changed\n');
    git(root, ['add', 'd/staged']);
    git(root, ['rm', '-q', 'd/deleted']);
    git(root, ['mv', 'd/renamed', 'd/moved']);
    writeFileSync(join(root, 'd', 'untracked'), 'x\n');
    writeFileSync(join(root, 'd', 'ignored'), 'x\n');
    writeFileSync(join(root, 'e f', 'spaced'), 'changed\n');
    writeFileSync(join(root, 'outside'), 'changed\n');
    return root;
  }

  const EXPECTED = [
    'd/deleted',
    'd/modified',
    'd/moved',
    'd/renamed', // a rename's deleted side must be briefed, or the ship keeps the old file
    'd/staged',
    'd/untracked',
    'e f/spaced',
  ];

  it('from the repo root: changed, staged, deleted, renamed and untracked — never unchanged or ignored', () => {
    const root = seed();
    const r = refuse(root, ['d', 'e f']);
    expect(r.status).toBe(1);
    expect(runRemedy(r.stderr, root)).toEqual(EXPECTED);
  });

  // Ship's paths are literal (sc-2425): a directory named `*` or `:(exclude)*` must select only
  // itself, never act as a glob or magic that widens or narrows the listed set.
  it('a directory whose name is a glob or pathspec magic lists only its own changes', () => {
    const root = seed();
    for (const d of ['*', ':(exclude)*']) {
      mkdirSync(join(root, d));
      writeFileSync(join(root, d, 'new'), 'x\n');
    }
    expect(runRemedy(refuse(root, ['*']).stderr, root)).toEqual(['*/new']);
    expect(runRemedy(refuse(root, [':(exclude)*']).stderr, root)).toEqual([':(exclude)*/new']);
  });

  // A parallel agent staging a new file between the remedy's two reads must not drop it from both:
  // the shim runs `git add d/late` right after whichever read comes first.
  it('a file another agent stages between the two reads is still listed', () => {
    const root = seed();
    writeFileSync(join(root, 'd', 'late'), 'x\n');
    const shim = join(tempRoot(), 'git');
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      shim,
      `#!/bin/sh\n"${realGit}" "$@"; rc=$?\n[ -e "${shim}.done" ] || { : > "${shim}.done"; "${realGit}" -C "${root}" add d/late; }\nexit $rc\n`,
      { mode: 0o755 },
    );
    const line = REMEDY_LINE.exec(refuse(root, ['d']).stderr)![0];
    // The `cd "$(git rev-parse …)"` prefix is the shim's first call; skip it so the add lands mid-pipe.
    const pipe = line.replace(/^ {2}cd [^&]+&& /, '');
    const out = spawnSync('/bin/bash', ['-c', pipe], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV, PATH: `${join(shim, '..')}:${process.env.PATH}` },
    });
    expect(out.stdout.split('\n')).toContain('d/late');
  });

  it('pasted from a subdirectory it still prints root-relative paths ship accepts', () => {
    const root = seed();
    const r = refuse(root, ['d', 'e f']);
    expect(runRemedy(r.stderr, join(root, 'sub'))).toEqual(EXPECTED);
  });
});

/** Call the unmatched-path guard the way both ship scripts do: root, trees, `--`, then the brief. */
function refuseUnmatched(root: string, trees: string[], paths: string[]) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      'set -euo pipefail; . "$1"; shift; ship_refuse_unmatched_paths "$@"',
      'refuse',
      helper,
      root,
      ...trees,
      '--',
      ...paths,
    ],
    { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } },
  );
}

/** Committed files, then: gone.ts deleted on disk only, rmd.ts `git rm`'d (in the tree only). */
function seedTracked() {
  const root = tempRoot();
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'a@b.c']);
  git(root, ['config', 'user.name', 'a']);
  for (const f of ['a.ts', 'b.ts', 'a b', 'x\ny', 'gone.ts', 'rmd.ts']) {
    writeFileSync(join(root, f), 'x\n');
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base']);
  rmSync(join(root, 'gone.ts'));
  git(root, ['rm', '-q', 'rmd.ts']);
  symlinkSync('missing-target', join(root, 'dangling'));
  return { root, head: git(root, ['rev-parse', 'HEAD']).trim() };
}

describe('ship_refuse_unmatched_paths', () => {
  it('passes real files, odd names, deletions, a git-rm path, and a dangling symlink', () => {
    const { root, head } = seedTracked();
    const r = refuseUnmatched(
      root,
      [head],
      ['a.ts', 'a b', 'x\ny', 'gone.ts', './gone.ts', 'rmd.ts', 'dangling'],
    );
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('an empty brief is not a refusal (empty array under nounset)', () => {
    expect(refuseUnmatched(tempRoot(), ['HEAD'], []).status).toBe(0);
  });

  it('names every typo in one refusal, with no shell-split hint', () => {
    const { root, head } = seedTracked();
    const r = refuseUnmatched(root, [head, head], ['typo.ts', 'a.ts', 'other typo.ts']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      `names nothing ship can stage (not on disk, in the index, or in ${head.slice(0, 7)}): typo.ts other\\ typo.ts\n`,
    );
    expect(r.stderr).not.toContain('one argument holds');
  });

  // A bare pathspec would glob `*.ts` onto a.ts and pass; `:(literal)` keeps it the typo it is.
  // The blank path exercises the empty split array under bash 3.2's nounset.
  it('a glob-shaped or blank path is refused cleanly, never matched or crashed on', () => {
    const { root, head } = seedTracked();
    const r = refuseUnmatched(root, [head], ['*.ts', ' ']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      `in ${head.slice(0, 7)}): \\*.ts \\ \n  paths are repo-root-relative\n`,
    );
    expect(r.stderr).not.toContain('one argument holds');
  });

  it('a newline- or space-joined list is named as unsplit, with a copyable argv tail', () => {
    const { root, head } = seedTracked();
    for (const joined of ['a.ts\nb.ts\nrmd.ts', 'a.ts b.ts']) {
      const r = refuseUnmatched(root, [head], [joined]);
      expect(r.status).toBe(1);
      const n = joined.split(/\s/).length;
      expect(r.stderr).toContain(
        `one argument holds ${n} paths — an unquoted $VAR is not word-split in zsh`,
      );
      const tail = r.stderr.trimEnd().split('\n').at(-1)!;
      const argv = spawnSync(
        '/bin/bash',
        ['-c', 'eval "set -- $1"; printf "%s\\0" "$@"', '_', tail],
        {
          encoding: 'utf8',
        },
      ).stdout.split('\0');
      expect(argv.slice(0, -1)).toEqual(joined.split(/\s/));
    }
  });
});
