/** Transient GitHub push failures, and adopting an origin branch that already holds the gated commit. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import {
  createPreservedCommit,
  dirs,
  ghStub,
  localBranchExists,
  publishEnvFor,
  remoteBranchExists,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const SERVER_ERROR = ' ! [remote rejected] feat/x -> feat/x (Internal Server Error)';
const HOOK_DECLINED =
  'remote: Internal Server Error in test output\n ! [remote rejected] feat/x -> feat/x (pre-receive hook declined)';

/** A `git` on PATH whose first SHIM_FAILS pushes print `reason` the way GitHub does, then exit 1. */
function gitShim(reason) {
  const bin = mkdtempSync(join(tmpdir(), 'ship-git-shim-'));
  dirs.push(bin);
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh
for a in "$@"; do
  [ "$a" = push ] || continue
  n=$(($(cat "$SHIM_COUNT" 2>/dev/null || echo 0) + 1)); echo "$n" > "$SHIM_COUNT"
  if [ "$n" -le "\${SHIM_FAILS:-0}" ]; then
    printf 'To github.com:acme/app.git\\n%s\\nerror: failed to push some refs\\n' '${reason}' >&2; exit 1
  fi
  break
done
exec '${REAL_GIT}' "$@"
`,
  );
  chmodSync(join(bin, 'git'), 0o755);
  return bin;
}

function shipEnv(dir, env, { reason = SERVER_ERROR, fails = 0, attempts = '4', gh } = {}) {
  const { publishEnv } = publishEnvFor(dir, env);
  const count = join(dir, 'push-count');
  const ghPath = gh ? `${ghStub(gh)}:` : '';
  return {
    count,
    env: {
      ...publishEnv,
      PATH: `${ghPath}${gitShim(reason)}:${publishEnv.PATH}`,
      SHIM_COUNT: count,
      SHIM_FAILS: String(fails),
      DEVKIT_PUSH_ATTEMPTS: attempts,
      DEVKIT_PUSH_RETRY_DELAY: '0',
    },
  };
}

function ship(dir, env, branch) {
  writeFileSync(join(dir, 'note.txt'), 'hi\n');
  return spawnSync('/bin/bash', [scriptPath, branch, 'ship it', '--', 'note.txt'], {
    cwd: dir,
    input: 'pr body\n',
    encoding: 'utf8',
    env,
  });
}

const pushes = (count) => Number(readFileSync(count, 'utf8').trim());

/** A receipt-verified preserved commit, already pushed to origin by hand (the reporter's workaround). */
function preservedOnOrigin(dir, env, git, branch) {
  const preserved = createPreservedCommit({ dir, env, git, branch, tempPrefix: 'ship-adopt-' });
  git(['update-ref', `refs/devkit/ship-receipts/${branch}`, preserved]);
  git(['push', '-q', '--no-verify', 'origin', `${branch}:${branch}`], { stdio: 'ignore' });
  return preserved;
}

describe('ship-branch.sh — transient push failures', () => {
  it('retries a GitHub 5xx and opens the PR once the push lands', () => {
    const { dir, env, bare } = seedShipRepoLocalRemote();
    const { count, env: runEnv } = shipEnv(dir, env, { fails: 2 });

    const r = ship(dir, runEnv, 'feat/flaky');

    expect(r.status, r.stderr).toBe(0);
    expect(pushes(count)).toBe(3);
    expect(r.stderr).toContain('push attempt 1/4 hit a transient GitHub error');
    expect(r.stdout).toContain('https://github.com/acme/app/pull/42');
    expect(remoteBranchExists(bare, 'feat/flaky')).toBe(true);
  });

  it('never retries a hook decline, even when hook output mentions a server error', () => {
    const { dir, env, bare } = seedShipRepoLocalRemote();
    const { count, env: runEnv } = shipEnv(dir, env, { reason: HOOK_DECLINED, fails: 9 });

    const r = ship(dir, runEnv, 'feat/declined');

    expect(r.status, r.stderr).toBe(1);
    expect(pushes(count)).toBe(1);
    expect(r.stderr).toContain('retry: devkit ship --resume feat/declined');
    expect(remoteBranchExists(bare, 'feat/declined')).toBe(false);
  });

  it('converges on a plain re-run after the retry budget runs out', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const failing = shipEnv(dir, env, { fails: 9, attempts: '2' });

    const first = ship(dir, failing.env, 'feat/outage');
    expect(first.status, first.stderr).toBe(1);
    expect(pushes(failing.count)).toBe(2);
    expect(localBranchExists(git, 'feat/outage')).toBe(true);

    const retry = ship(dir, shipEnv(dir, env).env, 'feat/outage');
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).toContain('gate receipt verified');
    expect(remoteBranchExists(bare, 'feat/outage')).toBe(true);
  });
});

describe('ship-branch.sh — origin already holds the preserved commit', () => {
  it('skips the push and opens the PR', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    preservedOnOrigin(dir, env, git, 'feat/adopt');
    const { count, env: runEnv } = shipEnv(dir, env);

    const r = ship(dir, runEnv, 'feat/adopt');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/origin\/feat\/adopt already holds gated commit \w{7}; skipping push/);
    expect(existsSync(count)).toBe(false);
    expect(r.stdout).toContain('https://github.com/acme/app/pull/42');
    expect(localBranchExists(git, 'feat/adopt')).toBe(false);
  });

  it('reports the already-open PR instead of creating a second one', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    preservedOnOrigin(dir, env, git, 'feat/adopt-open');
    const created = join(dir, 'pr-created');
    const gh = `case "$2" in view) printf '7\\tOPEN\\tfeat/adopt-open\\tx\\tacme/app\\twork\\tu\\n' ;; create) touch '${created}' ;; esac`;

    const r = ship(dir, shipEnv(dir, env, { gh }).env, 'feat/adopt-open');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('https://github.com/acme/app/pull/7');
    expect(existsSync(created)).toBe(false);
  });

  it('still refuses when origin holds a different commit', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    preservedOnOrigin(dir, env, git, 'feat/diverged');
    git(['push', '-q', '--no-verify', '-f', 'origin', 'work:feat/diverged'], { stdio: 'ignore' });

    const r = ship(dir, shipEnv(dir, env).env, 'feat/diverged');

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('remote branch already exists: origin/feat/diverged');
  });
});
