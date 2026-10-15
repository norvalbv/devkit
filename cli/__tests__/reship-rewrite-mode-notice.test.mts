import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import { rewriteRepo, runReship as run } from './_reship-rewrite-fixture.mts';

// `--pr --base` silently gated the whole PR as one commit, so a title written for the appended
// delta failed completeness one full attempt later. The mode must be named before any gate runs.

const NOTICE =
  "ship --pr --base: REWRITE — replaces PR #7's 1 commit(s) on origin/feat/pr with ONE commit on origin/main";

/** The fixture's caller sits on the local-only `prepared` branch, like a provisioned worktree. */
function repoWithLoudGate() {
  const repo = rewriteRepo();
  writeFileSync(join(repo.dir, '.husky/_/pre-commit'), '#!/bin/sh\necho GATE_RAN >&2\n');
  chmodSync(join(repo.dir, '.husky/_/pre-commit'), 0o755);
  return { ...repo, env: { ...repo.env, SHIP_DRY_RUN: '1' } };
}

describe('reship --base — names rewrite mode before the gates', () => {
  it('prints the rewrite notice ahead of the gate chain', () => {
    const { dir, env } = repoWithLoudGate();
    const r = run(
      ['feat/pr', 'add a test', '--pr', '--base', 'main', '--', 'conflict.txt'],
      dir,
      env,
    );
    expect(r.status, r.stderr).toBe(0);
    const at = r.stderr.indexOf(NOTICE);
    expect(at, r.stderr).toBeGreaterThanOrEqual(0);
    expect(r.stderr.indexOf('GATE_RAN'), r.stderr).toBeGreaterThan(at);
    expect(r.stderr.indexOf('DRY: committed replacement'), r.stderr).toBeGreaterThan(at);
  });

  it('hands over an append command that survives a shell round-trip', () => {
    const { dir, env } = repoWithLoudGate();
    const r = run(
      ['feat/pr', 'add a test', '--pr', '--base', 'main', '--', 'conflict.txt'],
      dir,
      env,
    );
    const lines = r.stderr.split('\n');
    const addLine = lines[lines.findIndex((l) => l.startsWith(NOTICE)) + 1];
    expect(addLine).toContain(
      'to ADD a commit on top of the PR instead, drop --base: devkit ship ',
    );
    const argv = spawnSync(
      '/bin/bash',
      ['-c', 'eval "set -- $1"; printf "%s\\0" "$@"', '_', addLine.split('devkit ship ')[1]],
      { encoding: 'utf8' },
    )
      .stdout.split('\0')
      .slice(0, -1);
    expect(argv).toEqual(['feat/pr', 'add a test', '--pr', '--', 'conflict.txt']);
  });

  it('stays silent for a plain --pr append', () => {
    const { dir, env } = repoWithLoudGate();
    writeFileSync(join(dir, 'added.test.txt'), 'new\n');
    const r = run(['feat/pr', 'add a test', '--pr', '--', 'added.test.txt'], dir, env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('GATE_RAN');
    expect(r.stderr).not.toContain('REWRITE —');
  });

  it("counts the PR's own commits, not the caller's prepared ones", () => {
    const { dir, env, g, oldPrTip } = repoWithLoudGate();
    g(['checkout', '-q', '-b', 'second', oldPrTip]);
    writeFileSync(join(dir, 'conflict.txt'), 'feature, reviewed\n');
    g(['commit', '-q', '-am', 'review fix']);
    g(['push', '-q', 'origin', 'HEAD:feat/pr']);
    const prTip = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', 'prepared']);
    const r = run(['feat/pr', 't', '--pr', '--base', 'main', '--', 'conflict.txt'], dir, {
      ...env,
      PR_HEAD_OID: prTip,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("replaces PR #7's 2 commit(s) on origin/feat/pr");
  });
});
