import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Gate dependencies (.husky/_, node_modules, coverage) are all GITIGNORED, so `git worktree add`
// never brings them across. The consumer root can itself be a linked worktree — devkit's own stated
// premise ("parallel agents share one working tree"), and what any tool spawning per-task worktrees
// produces. Linking only from $root therefore failed closed on .husky/_ for a perfectly set-up repo
// and silently dropped node_modules/coverage. These cover the fallback to the MAIN worktree.

vi.setConfig({ testTimeout: 30_000 });

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
    writeFileSync(target, 'x');
  }

  // The linked worktree: a clean checkout, so none of the above exists in it.
  const linked = join(root, 'linked');
  git(['worktree', 'add', '-q', '-b', 'task', linked]);

  const wt = join(root, 'ephemeral');
  mkdirSync(wt, { recursive: true });
  return { main, linked, wt };
}

/** Invoke the real prepare_gate_worktree against <wt> with <root> as the consumer root. */
function prepare(wt: string, root: string) {
  return spawnSync(
    '/bin/bash',
    ['-c', `. "${scriptPath}"; prepare_gate_worktree "${wt}" "${root}" ship`],
    { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } },
  );
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
});
