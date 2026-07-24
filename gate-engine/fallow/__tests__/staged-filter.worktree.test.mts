import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * sc-1192 regression: the filter must attribute correctly when it runs as a pre-commit hook in a
 * LINKED WORKTREE — the environment `devkit ship` commits in (cli/lib/ship/ship-branch.sh). git
 * exports an absolute GIT_DIR/GIT_INDEX_FILE into that hook, so the staged set the filter reads
 * comes from the ship worktree's index, not the main checkout's.
 *
 * The reported failure was an ANONYMOUS exit 2: the gate fell back to blocking on the unscoped
 * worktree verdict and could not say which step failed. So these assert the reason text too — an
 * exit 2 that names nothing is the bug, not just an exit 2.
 */
const FILTER = fileURLToPath(new URL('../staged-filter.mts', import.meta.url));

let repo: string;
let wt: string;
let gitEnv: NodeJS.ProcessEnv;

/** Run the filter as the gate does: audit JSON on stdin, cwd + git env of the committing worktree. */
function runFilter(audit: unknown, env: NodeJS.ProcessEnv = gitEnv, cwd = wt) {
  const r = spawnSync('node', [FILTER], {
    cwd,
    env,
    input: JSON.stringify(audit),
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'fallow-staged-wt-'));
  const git = (args: string, cwd = repo) => execSync(`git ${args}`, { cwd, encoding: 'utf8' });
  git('init -q -b main');
  git('config user.email t@t.t');
  git('config user.name Tester');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'b.ts'), 'export const b = 1;\n');
  git('add -A');
  git('commit -qm base');

  // The ship shape: a linked worktree whose .git is a FILE pointing into .git/worktrees/<name>.
  wt = join(repo, '..', `${repo.split('/').pop()}-wt`);
  git(`worktree add -q -b ship-x ${wt} HEAD`);
  writeFileSync(join(wt, 'a.ts'), 'export const a = 1;\nexport const a2 = 2;\n');
  git('add a.ts', wt);

  // Exactly what `git commit` exports into a hook run in a linked worktree.
  const gitDir = execSync('git rev-parse --absolute-git-dir', { cwd: wt, encoding: 'utf8' }).trim();
  gitEnv = { ...process.env, GIT_DIR: gitDir, GIT_INDEX_FILE: join(gitDir, 'index') };
});

afterAll(() => {
  rmSync(wt, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('staged-filter in a linked worktree (devkit ship commit environment)', () => {
  it('ships a clean scoped diff while unrelated worktree findings exist', () => {
    // The ticket's literal scenario: an introduced finding in b.ts, which this commit never staged.
    const r = runFilter({
      verdict: 'fail',
      complexity: {
        findings: [{ introduced: true, path: 'b.ts', name: 'unrelated', line: 1, line_count: 1 }],
      },
      duplication: {
        clone_groups: [
          { introduced: true, instances: [{ file: 'b.ts', start_line: 1, end_line: 1 }] },
        ],
      },
      dead_code: { unused_files: [{ introduced: true, path: 'b.ts' }] },
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('still blocks on a finding that overlaps the staged hunk', () => {
    const r = runFilter({
      verdict: 'fail',
      complexity: {
        findings: [{ introduced: true, path: 'a.ts', name: 'staged', line: 2, line_count: 1 }],
      },
    });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual([
      { kind: 'complexity', path: 'a.ts', name: 'staged', line: 2 },
    ]);
  });

  it('reads the ship worktree index, not the main checkout index', () => {
    // Same GIT_DIR/GIT_INDEX_FILE, cwd in the MAIN checkout (which has nothing staged). The
    // exported index is authoritative during a commit hook, so attribution must not change.
    const r = runFilter(
      {
        verdict: 'fail',
        complexity: {
          findings: [{ introduced: true, path: 'a.ts', name: 'staged', line: 2, line_count: 1 }],
        },
      },
      gitEnv,
      repo,
    );
    expect(r.status).toBe(1);
  });

  it('names the reason on stderr when the staged diff cannot be read', () => {
    const broken = { ...gitEnv, GIT_DIR: join(repo, 'nope', '.git') };
    const r = runFilter({ verdict: 'fail' }, broken);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/fallow-staged-filter: could not read the staged diff/);
    // The classifier fields lead, so they survive the length cap ahead of git's unbounded output…
    expect(r.stderr).toMatch(/exit=\d+/);
    // …and git's own words are carried, which only holds because the child's stderr is piped.
    expect(r.stderr).toMatch(/git diff --cached/);
  });

  it('names the reason on stderr when the payload is unreadable', () => {
    const r = spawnSync('node', [FILTER], { cwd: wt, env: gitEnv, input: '', encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/fallow-staged-filter: unreadable fallow audit payload/);
    expect(r.stderr).toMatch(/empty payload/);
  });
});
