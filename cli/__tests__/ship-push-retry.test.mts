/** Transient GitHub push failures, and adopting an origin branch that already holds the gated commit. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const pushRetryScript = fileURLToPath(new URL('../lib/ship/push-retry.sh', import.meta.url));

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
    [ -z "\${SHIM_LAND:-}" ] || '${REAL_GIT}' "$@" >/dev/null 2>&1
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

function ship(dir, env, branch, title = 'ship it') {
  writeFileSync(join(dir, 'note.txt'), 'hi\n');
  return spawnSync('/bin/bash', [scriptPath, branch, title, '--', 'note.txt'], {
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

  it('treats a failed push whose commit reached origin as landed, without a retry', () => {
    const { dir, env, bare } = seedShipRepoLocalRemote();
    const { count, env: runEnv } = shipEnv(dir, env, { fails: 1 });

    const r = ship(dir, { ...runEnv, SHIM_LAND: '1' }, 'feat/lost-response');

    expect(r.status, r.stderr).toBe(0);
    expect(pushes(count)).toBe(1);
    expect(r.stderr).toMatch(/push response failed after origin accepted \w{7}/);
    expect(remoteBranchExists(bare, 'feat/lost-response')).toBe(true);
  });

  // A malformed knob must fall back to the default budget, never retry without bound.
  it('caps retries at the default when DEVKIT_PUSH_ATTEMPTS is not a number', () => {
    const { dir, env } = seedShipRepoLocalRemote();
    const { count, env: runEnv } = shipEnv(dir, env, { fails: 99, attempts: 'many' });

    const r = ship(dir, runEnv, 'feat/bad-knob');

    expect(r.status, r.stderr).toBe(1);
    expect(pushes(count)).toBe(4);
  });
});

describe('ship_push_transient', () => {
  const transient = (line) => {
    const file = join(mkdtempSync(join(tmpdir(), 'push-err-')), 'err');
    writeFileSync(file, `To github.com:acme/app.git\n${line}\nerror: failed to push some refs\n`);
    return (
      spawnSync('/bin/bash', ['-c', `. '${pushRetryScript}'; ship_push_transient '${file}'`])
        .status === 0
    );
  };

  it.each([
    ' ! [remote rejected] main -> main (Internal Server Error)',
    ' ! [remote rejected] main -> main (502 Bad Gateway)',
    ' ! [remote rejected] main -> main (Service Unavailable)',
    ' ! [remote rejected] main -> main (Gateway Timeout)',
    "fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 503",
    'fatal: the remote end hung up unexpectedly',
    'fatal: early EOF',
  ])('retries %s', (line) => {
    expect(transient(line)).toBe(true);
  });

  it.each([
    ' ! [remote rejected] main -> main (pre-receive hook declined)',
    ' ! [rejected]        main -> main (non-fast-forward)',
    'remote: Internal Server Error while running tests',
    "fatal: Authentication failed for 'https://github.com/a/b.git/'",
    "fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403",
  ])('does not retry %s', (line) => {
    expect(transient(line)).toBe(false);
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
    const url = 'https://ghe.example.com/acme/app/pull/7';
    const gh = `case "$2" in view) printf '7\\tOPEN\\tfeat/adopt-open\\tx\\tacme/app\\twork\\t${url}\\n' ;; create) touch '${created}' ;; esac`;

    const r = ship(dir, shipEnv(dir, env, { gh }).env, 'feat/adopt-open');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(url); // gh's own URL, so a GitHub Enterprise host is not rewritten
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

  it("keeps the closed-PR refusal when the adopted branch's PR already merged", () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    preservedOnOrigin(dir, env, git, 'feat/adopt-merged');
    const created = join(dir, 'pr-created');
    const gh = `case "$2" in view) printf '7\\tMERGED\\tfeat/adopt-merged\\tx\\tacme/app\\twork\\tu\\n' ;; create) touch '${created}' ;; esac`;

    const r = ship(dir, shipEnv(dir, env, { gh }).env, 'feat/adopt-merged');

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('its PR #7 is MERGED');
    expect(existsSync(created)).toBe(false);
  });

  it('never publishes an adopted commit the receipt checks reject', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    preservedOnOrigin(dir, env, git, 'feat/adopt-retitled');
    const created = join(dir, 'pr-created');
    const gh = `case "$2" in create) touch '${created}' ;; esac`;

    const r = ship(dir, shipEnv(dir, env, { gh }).env, 'feat/adopt-retitled', 'a different title');

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('cannot safely resume it');
    expect(existsSync(created)).toBe(false);
  });
});
