import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { relIntentPath } from '../lib/ship/ship-intent.mts';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import { rewriteRepo } from './_reship-rewrite-fixture.mts';
import { bodyUpdateRepo, GIT_ENV, reshipScript } from './_ship-branch-fixture.mts';

// A fresh `ship --pr` carrying an explicit body but no content change is refused before any PR
// mutation: changing only a description is `devkit pr-body`'s job, not a silent ship success.

function reship(args: string[], dir: string, env: Record<string, string>) {
  return spawnSync('/bin/bash', [reshipScript, ...args], {
    cwd: dir,
    input: '',
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...env },
  });
}

/** Runs a no-delta re-ship (a.ts is left byte-identical to origin/feat/pr) and reads its effects. */
function noDeltaRun(flags: string[], extraEnv: Record<string, string> = {}) {
  const { bare, dir, env, g, ghLog, ghBody } = bodyUpdateRepo();
  const head = () => g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
  const before = head();
  writeFileSync(join(dir, 'body.md'), 'fresh body\n');
  const r = reship(['feat/pr', 'same content', '--pr', ...flags, '--', 'a.ts'], dir, {
    ...env,
    ...extraEnv,
  });
  return {
    r,
    gh: existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '',
    bodyWritten: existsSync(ghBody),
    headMoved: head() !== before,
    recordKept: existsSync(join(dir, relIntentPath('feat/pr'))),
  };
}

function expectRefused(run: ReturnType<typeof noDeltaRun>) {
  expect(run.r.status, run.r.stderr).toBe(1);
  expect(run.r.stderr).toContain('nothing to commit, so the PR body was NOT updated');
  expect(run.r.stderr).toContain("devkit pr-body 'feat/pr' --body-file <file>");
  expect(run.gh).not.toMatch(/^pr (edit|ready)/m);
  expect(run.bodyWritten).toBe(false);
  expect(run.headMoved).toBe(false);
  expect(run.recordKept, 'the refused run releases its own record').toBe(false);
}

describe('reship — a fresh no-delta run with an explicit body is refused', () => {
  it('refuses --body-file and names devkit pr-body', () => {
    expectRefused(noDeltaRun(['--body-file', 'body.md']));
  });

  it('refuses an explicit empty --body the same way', () => {
    expectRefused(noDeltaRun(['--body', '']));
  });

  it('refuses under SHIP_DRY_RUN too', () => {
    expectRefused(noDeltaRun(['--body', 'preview'], { SHIP_DRY_RUN: '1' }));
  });

  it('does not mark the PR ready, and says so', () => {
    const run = noDeltaRun(['--body', 'fresh body', '--ready']);
    expectRefused(run);
    expect(run.r.stderr).toContain('the PR was not marked ready either');
  });

  it('prints exactly one not-run CI outcome under --wait-ci', () => {
    const run = noDeltaRun(['--body', 'fresh body', '--wait-ci']);
    expectRefused(run);
    expect(run.r.stderr.match(/ci-outcome=/g)).toHaveLength(1);
    expect(run.r.stderr).toContain('ci-outcome=not-run pr=? reason=nothing-was-pushed');
  });

  // A --base rewrite whose replacement equals the PR base used to publish the body over the old head.
  it('refuses a --base rewrite whose replacement is empty, naming the base it compared against', () => {
    const { bare, dir, env, g, ghLog, ghBody } = rewriteRepo();
    const before = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    writeFileSync(join(dir, 'conflict.txt'), 'main\n'); // byte-identical to origin/main
    const r = reship(
      ['feat/pr', 'empty', '--pr', '--base', 'main', '--body', 'b', '--', 'conflict.txt'],
      dir,
      env,
    );
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('no changes vs origin/main — nothing to commit');
    expect(existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '').not.toMatch(/^pr edit/m);
    expect(existsSync(ghBody)).toBe(false);
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).toBe(before);
  });

  // A refused body left recorded would be published by a later --resume, so the refusal must say so.
  it('says the refused body is still recorded when the intent lock blocks its release', () => {
    const { dir, env, ghLog } = bodyUpdateRepo();
    const shim = mkdtempSync(join(tmpdir(), 'reship-lock-shim-'));
    const lock = join(dir, `${relIntentPath('feat/pr')}.lock`);
    // Another attempt takes the intent lock between this run's record write and its delta check.
    writeFileSync(
      join(shim, 'git'),
      `#!/bin/sh\ncase "$*" in *" diff --cached --quiet") mkdir -p '${lock}'; printf '%s:held' "$PPID" > '${lock}/holder' ;; esac\nPATH=\${PATH#*:} exec git "$@"\n`,
    );
    chmodSync(join(shim, 'git'), 0o755);
    const r = reship(['feat/pr', 'same', '--pr', '--body', 'b', '--', 'a.ts'], dir, {
      ...env,
      PATH: `${shim}:${env.PATH}`,
    });
    rmSync(shim, { recursive: true, force: true });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('the PR body was NOT updated');
    expect(r.stderr).toContain('this refused body is still recorded — do NOT --resume it');
    expect(existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '').not.toMatch(/^pr edit/m);
    expect(existsSync(join(dir, relIntentPath('feat/pr')))).toBe(true);
  });

  it('leaves the body-less no-delta run on its existing "nothing to re-push" path', () => {
    const run = noDeltaRun([]);
    expect(run.r.status).toBe(1);
    expect(run.r.stderr).toContain('nothing to re-push');
    expect(run.r.stderr).not.toContain('PR body was NOT updated');
    expect(run.gh).not.toMatch(/^pr edit/m);
  });
});
