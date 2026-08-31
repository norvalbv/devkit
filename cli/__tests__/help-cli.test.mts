import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CLI } from './_helpers.mts';

// Run the CLI with an explicit env (so a test can strip git from PATH). cwd is the repo itself —
// these paths only read help / preflight, they never mutate anything.
const run = (args, env) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: env ?? process.env });

describe('devkit help surface', () => {
  it('`--help` lists every command (derived from meta)', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    for (const name of [
      'init',
      'doctor',
      'ship',
      'review',
      'reconcile',
      'guard-branch',
      'base-status',
      'prove-regression',
    ]) {
      expect(r.stdout).toContain(`devkit ${name}`);
    }
  });

  it('`help <command>` prints that command full help', () => {
    const r = run(['help', 'ship']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/devkit ship —/);
    expect(r.stdout).toMatch(/SHIP_DRY_RUN/);
    expect(r.stdout).toContain('--dry-gates');
    expect(r.stdout).toContain('--from-branch');
    expect(r.stdout).toMatch(/Never leaves a local branch or commit/);
  });

  it('rejects --from-branch with --pr at the dispatcher boundary', () => {
    const r = run(['ship', 'feat/x', 't', '--pr', '--base', 'main', '--from-branch']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--from-branch is only valid for a new ship');
  });

  it('does not reinterpret a body value that resembles --from-branch as a mode flag', () => {
    const r = run(['ship', '--pr', 'feat/x', 't', '--body', '--from-branch', '--', 'note.txt'], {
      ...process.env,
      SHIP_RESOLVE_ONLY: '1',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('BR=feat/x');
    expect(r.stderr).not.toContain('--from-branch is only valid for a new ship');
  });

  it('does not mistake an opaque --body value for the option terminator', () => {
    const r = run(['ship', 'feat/x', 't', '--body', '--', '--pr', '--', 'note.txt'], {
      ...process.env,
      SHIP_RESOLVE_ONLY: '1',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('BR=feat/x');
    expect(r.stderr).not.toContain('unknown flag: --pr');
  });

  it('`<command> --help` works for every command generically', () => {
    const r = run(['reconcile', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/devkit reconcile —/);
  });

  it('documents the generic captured-evidence contract', () => {
    const r = run(['prove-regression', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--red <ref>');
    expect(r.stdout).toContain('-- <test command>');
    expect(r.stdout).toContain('--vitest-report');
    expect(r.stdout).toMatch(/CAPTURED execution\s+evidence, not\s+automatic proof/i);
    expect(r.stdout).toMatch(/sampled boundary\s+fingerprints matched/i);
    expect(r.stdout).toMatch(/not an atomic filesystem snapshot/i);
    expect(r.stdout).toMatch(/each\s+operand receives an independent copy/i);
    expect(r.stdout).not.toMatch(/node_modules is linked|mutable exception/i);
    expect(r.stdout).toMatch(/Windows interruption terminates\s+only the direct helper/i);
  });

  it('leaves --help after prove-regression command boundary in the child argv', () => {
    const r = run([
      'prove-regression',
      '--red',
      'definitely-not-a-ref',
      '--green',
      'definitely-not-a-ref',
      '--',
      'node',
      'test.mjs',
      '--help',
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toMatch(/devkit prove-regression —/);
    expect(r.stderr).toContain('prove-regression setup:');
  });

  it('documents the review trust boundary and target/base options', () => {
    const r = run(['review', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/devkit review —/);
    expect(r.stdout).toContain('--target <path>');
    expect(r.stdout).toContain('--base <ref>');
    expect(r.stdout).toMatch(/trusted targets only/i);
    expect(r.stdout).toContain('devkit init --overlay --review');
  });

  it('`help <unknown>` errors and falls back to the top-level help (EC8)', () => {
    const r = run(['help', 'nope']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown command "nope"/);
    expect(r.stdout).toContain('devkit init'); // top-level list still shown
  });
});

describe('git preflight (require-git)', () => {
  // node lives in the same dir as git on most setups; strip PATH to just node's dir is unreliable.
  // Use an empty PATH with node invoked by absolute path → `git` is unresolvable (ENOENT).
  const noGitEnv = { ...process.env, PATH: '/var/empty' };

  it('a git-command fails with one friendly message, not a raw spawn error (EC6)', () => {
    const r = run(['doctor'], noGitEnv);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/git is not installed or not on PATH/);
    expect(r.stderr).not.toMatch(/spawnSync|ENOENT/);
  });

  it('a non-git command (sync-skills) is unaffected by missing git', () => {
    const r = run(['sync-skills', '--dry-run'], noGitEnv);
    // It runs (dry-run) without the git preflight tripping.
    expect(r.stderr).not.toMatch(/git is not installed/);
  });
});
