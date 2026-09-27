import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import { rewriteRepo } from './_reship-rewrite-fixture.mts';

// `ship --pr --base` pins the PR head and base with one fetch under the remote supervisor. A repo
// past gc.auto made that fetch start a detached auto-gc the supervisor reaped as its own (sc-3761).

const scriptPath = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
const GENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function run(args, dir, env) {
  return spawnSync('/bin/bash', [scriptPath, ...args], {
    cwd: dir,
    input: 'body\n',
    encoding: 'utf8',
    env: { ...process.env, ...GENV, ...env },
  });
}

const PIN_RE = /cannot pin origin\/feat\/pr and origin\/(\S+)/;

/** Stragglers the git shim detached; they outlive the supervisor's reap only when it never ran. */
function killStragglers(pidFile) {
  if (!existsSync(pidFile)) return;
  for (const pid of readFileSync(pidFile, 'utf8').split('\n').filter(Boolean)) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {}
  }
}

describe('reship --base — the rewrite pin under the remote supervisor (sc-3761)', () => {
  /** Runs one --base rewrite with a private TMPDIR, so a leaked pin temp file is observable. */
  function pinRun(base, extraEnv) {
    const repo = rewriteRepo();
    const tmp = mkdtempSync(join(tmpdir(), 'reship-pin-tmp-'));
    const pidFile = join(repo.stubBin, 'stragglers.pid');
    dirs.push(tmp);
    try {
      const r = run(
        ['feat/pr', 'publish resolved PR', '--pr', '--base', base, '--', 'conflict.txt'],
        repo.dir,
        { ...repo.env, TMPDIR: tmp, AUTO_GC_STRAGGLER_PIDS: pidFile, ...extraEnv },
      );
      return { ...repo, r, tmp, pidFile };
    } finally {
      killStragglers(pidFile);
    }
  }

  it('a fetch whose detached auto-gc would outlive it still pins and publishes', () => {
    // Before sc-3761 the owned straggler was reaped after the linger grace and the finished fetch
    // read as 124 — every `ship --pr --base` in a repo past gc.auto failed before any gate ran.
    const { r, bare, g, mainTip, pidFile } = pinRun('main', {});
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(PIN_RE);
    const replacement = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    expect(g(['--git-dir', bare, 'rev-parse', `${replacement}^`])).toBe(mainTip);
    // The shim saw the suppression and started nothing: the fix is at the call site, not a reap.
    expect(existsSync(pidFile)).toBe(false);
  });

  it('names a reaped fetch as unfinished — never as a missing branch — and leaves no pin behind', () => {
    const { r, g, tmp } = pinRun('main', { AUTO_GC_IGNORES_CONFIG: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'cannot pin origin/feat/pr and origin/main: git fetch did not finish cleanly within 60s',
    );
    expect(r.stderr).not.toContain('both branches must exist');
    // The fetch itself landed its refs before the reap; the EXIT trap must still drop them.
    expect(g(['for-each-ref', '--format=%(refname)', 'refs/devkit/reship-rewrite'])).toBe('');
    expect(readdirSync(tmp).filter((f) => f.startsWith('reship-pin-fetch'))).toEqual([]);
  }, 30_000);

  it("keeps the missing-branch diagnosis for a base origin lacks, with git's own reason", () => {
    const { r, g, tmp } = pinRun('no-such-base', {});
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'cannot pin origin/feat/pr and origin/no-such-base — both branches must exist',
    );
    expect(r.stderr).toContain("couldn't find remote ref refs/heads/no-such-base");
    expect(g(['for-each-ref', '--format=%(refname)', 'refs/devkit/reship-rewrite'])).toBe('');
    expect(readdirSync(tmp).filter((f) => f.startsWith('reship-pin-fetch'))).toEqual([]);
  });

  // Only git's own fatal for a ref this pin requested means "missing"; a substring anywhere does not.
  it.each([
    [
      'a non-fatal line quoting the phrase',
      "warning: couldn't find remote ref in cache\nfatal: unable to access remote",
    ],
    [
      'a fatal naming a ref the pin never requested',
      "fatal: couldn't find remote ref refs/heads/other",
    ],
    ['the phrase mid-line', "error: helper said couldn't find remote ref refs/heads/main"],
  ])('does not call %s a missing branch', (_name, stderr) => {
    const { r } = pinRun('main', { FETCH_FAIL_STATUS: '128', FETCH_FAIL_STDERR: stderr });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'cannot pin origin/feat/pr and origin/main: git fetch failed (exit 128)',
    );
    expect(r.stderr).not.toContain('both branches must exist');
  });

  it('reports any other fetch failure with its status and stderr instead of blaming the branches', () => {
    const { r } = pinRun('main', { FETCH_FAIL_STATUS: '128' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'cannot pin origin/feat/pr and origin/main: git fetch failed (exit 128)',
    );
    expect(r.stderr).toContain('fatal: Could not read from remote repository.');
    expect(r.stderr).not.toContain('both branches must exist');
  });
});
