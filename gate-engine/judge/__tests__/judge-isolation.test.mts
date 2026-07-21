import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GIT_ENV_VARS, withoutGitEnv } from '../judge-isolation.mts';

// The incident this guards: git EXPORTS an absolute GIT_DIR/GIT_INDEX_FILE into any hook it runs in a
// LINKED worktree — which is exactly how `devkit ship` commits. Everything the gate chain spawns
// inherits them, so a judge that runs git against another repository writes THAT repository's index
// over the ship's staged diff. It happened: a ship's staged paths were replaced by a foreign
// 216-entry index, and the pending commit became a whole-repo deletion.

describe('withoutGitEnv', () => {
  it('strips every GIT_ENV_VARS name', () => {
    const dirty = Object.fromEntries(GIT_ENV_VARS.map((name) => [name, '/leaked']));
    const clean = withoutGitEnv(dirty);
    for (const name of GIT_ENV_VARS) expect(clean).not.toHaveProperty(name);
  });

  it('preserves everything else verbatim — including unrelated GIT_-prefixed author vars', () => {
    const clean = withoutGitEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      GIT_AUTHOR_NAME: 'ada',
      GIT_INDEX_FILE: '/repo/.git/worktrees/ship/index',
    });
    expect(clean.PATH).toBe('/usr/bin');
    expect(clean.HOME).toBe('/home/x');
    // Identity vars are NOT repository-location vars: stripping them would silently change authorship.
    expect(clean.GIT_AUTHOR_NAME).toBe('ada');
    expect(clean.GIT_INDEX_FILE).toBeUndefined();
  });

  it('does not mutate the env it was handed', () => {
    const source = { GIT_DIR: '/repo/.git' };
    withoutGitEnv(source);
    expect(source.GIT_DIR).toBe('/repo/.git');
  });

  it('covers the two variables git actually leaks through a linked-worktree hook', () => {
    // Asserted by name rather than by list membership: these two are the whole point, and a future
    // trim of the list must fail here rather than quietly reopening the hole.
    expect(GIT_ENV_VARS).toContain('GIT_INDEX_FILE');
    expect(GIT_ENV_VARS).toContain('GIT_DIR');
  });

  it('matches _review_worktree_clear_git_env in cli/lib/ship/review/worktrees.sh', () => {
    // Two scrubs of the same environment, one in TS and one in shell. They must never drift: a name
    // present in only one list is a hole in whichever path uses the shorter one.
    const sh = readFileSync(
      path.resolve(import.meta.dirname, '../../../cli/lib/ship/review/worktrees.sh'),
      'utf8',
    );
    const body = sh.match(/_review_worktree_clear_git_env\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(body).toBeDefined();
    const names = body?.match(/\bGIT_[A-Z_]+\b/g) ?? [];
    expect([...new Set(names)].sort()).toEqual([...GIT_ENV_VARS].sort());
  });
});

// End-to-end proof of the leak itself, with no devkit code in the loop: this is the behaviour every
// scrub in the codebase exists to defend against, so it is asserted against real git rather than
// assumed. If a future git stops exporting GIT_INDEX_FILE to worktree hooks, this test says so.
describe('git leaks an absolute index path into linked-worktree hooks', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devkit-gitenv-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  it('exports GIT_INDEX_FILE as an absolute path into the worktree admin dir', () => {
    const repo = path.join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-qm', 'base');

    const captured = path.join(root, 'captured-env');
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\nprintf '%s' "\${GIT_INDEX_FILE:-unset}" > ${captured}\n`, {
      mode: 0o755,
    });

    const wt = path.join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    writeFileSync(path.join(wt, 'b.txt'), 'b\n');
    git(wt, 'add', 'b.txt');
    git(wt, 'commit', '-qm', 'in-worktree');

    const leaked = readFileSync(captured, 'utf8');
    expect(path.isAbsolute(leaked)).toBe(true);
    expect(leaked).toContain(path.join('.git', 'worktrees'));
    expect(leaked.endsWith('index')).toBe(true);
    // …and that is the exact name the judge spawn strips.
    expect(withoutGitEnv({ GIT_INDEX_FILE: leaked }).GIT_INDEX_FILE).toBeUndefined();
  });
});
