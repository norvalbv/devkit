/** sc-2159 run record + orphan preflight. Sibling of ship-branch.test.mts, which has no
 *  maxTestLines headroom. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  testExecFileSync as execFileSync,
  processAlive,
  testSpawnSync as spawnSync,
  waitForPath,
} from './_helpers.mts';
import {
  dirs,
  ghStub,
  localBranchExists,
  reshipScript,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

/** A pid high enough to be free on both macOS and Linux, asserted absent before use so a test can
 *  never pass because the "dead" owner was quietly alive. */
const DEAD_PID = '999999';

/** Live sleepers to reap, so a refusal test cannot leave one behind. */
const live: number[] = [];
afterEach(() => {
  while (live.length > 0) {
    const pid = live.pop();
    try {
      if (pid) process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

function publishEnvFor(env) {
  return {
    ...env,
    PATH: `${ghStub('echo https://github.com/acme/app/pull/42')}:${env.PATH ?? process.env.PATH ?? ''}`,
  };
}

/** Register a linked worktree that OUTLIVES the run, i.e. exactly what a killed ship leaves. */
function orphanWorktree(git, branch, { detach = false } = {}) {
  const wt = mkdtempSync(join(tmpdir(), 'ship-orphan-'));
  dirs.push(wt);
  rmSync(wt, { recursive: true, force: true }); // `worktree add` wants a non-existent destination
  git(['worktree', 'add', '-q', ...(detach ? ['--detach'] : ['-b', branch]), wt, 'work']);
  const admin = git(['-C', wt, 'rev-parse', '--absolute-git-dir']).trim();
  return { wt, admin, record: join(admin, 'devkit-ship-run') };
}

function writeRecord(path, fields) {
  writeFileSync(
    path,
    `${Object.entries(fields)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`,
  );
}

/** The identity the preflight will compute for a pid — same pinned command as ship-run-record.sh, so
 *  a drift between writer and reader shows up here rather than as a wrongly-reclaimed live ship. */
function identityOf(pid) {
  return execFileSync('/bin/sh', ['-c', `LC_ALL=C TZ=UTC ps -o lstart= -p ${pid}`], {
    encoding: 'utf8',
  })
    .replace(/\s+/g, ' ')
    .trim();
}

/** A process that is genuinely alive for the duration of one test, standing in for a ship whose
 *  worktree the preflight must refuse to touch.
 *
 *  Raw `spawn` + `detached` + `unref` on purpose (the idiom review-gate-supervisor.test.mts already
 *  uses): _helpers.mts's supervised wrappers reap their whole process group on return, so a sleeper
 *  started through them is dead before the assertion runs. afterEach owns the kill. */
function spawnSleeper() {
  const child = spawn('/bin/sh', ['-c', 'sleep 300'], { detached: true, stdio: 'ignore' });
  child.unref();
  const { pid } = child;
  if (!pid) throw new Error('sleeper did not start');
  live.push(pid);
  return String(pid);
}

/** Evaluate one expression against the shell libraries, without paying for a whole ship run. */
function evalInShipLib(body, extraEnv = {}) {
  const lib = dirname(scriptPath);
  return execFileSync(
    '/bin/bash',
    [
      '-c',
      `set -euo pipefail
. "${lib}/worktree-registry.sh"
. "${lib}/ship-run-record.sh"
. "${lib}/reclaim-orphan-worktrees.sh"
${body}`,
    ],
    { encoding: 'utf8', env: { ...process.env, ...extraEnv } },
  ).trim();
}

/** `alive` / `dead`, via the predicate the preflight actually branches on. */
function livenessOf(pid, identity) {
  return evalInShipLib(
    `if _ship_orphan_alive ${JSON.stringify(pid)} ${JSON.stringify(identity)}; then echo alive; else echo dead; fi`,
  );
}

/** Run N reclaims of one branch genuinely concurrently, and report when each was in flight.
 *
 *  A barrier file, not just parallel spawns: process start-up dominates the git work, so two shells
 *  launched together can still enter the destructive section milliseconds apart. Each racer blocks
 *  until the barrier appears, so they contend for the same worktree registry for real. */
function reclaimConcurrently(dir, branch, racers = 2) {
  const lib = dirname(scriptPath);
  const barrier = join(dir, '.reclaim-barrier');
  const script = `. "${lib}/worktree-registry.sh"
. "${lib}/ship-run-record.sh"
. "${lib}/reclaim-orphan-worktrees.sh"
for _ in $(seq 1 20000); do [ -f "${barrier}" ] && break; done
PREFLIGHT_HINT=
ship_reclaim_orphan_worktrees "${dir}" "${branch}" >/dev/null 2>&1
exit 0`;
  const started = Array.from({ length: racers }, () => {
    const child = spawn('/bin/bash', ['-c', script], { cwd: dir, stdio: 'ignore' });
    const startedAt = performance.now();
    return once(child, 'exit').then(([code]) => ({
      code,
      startedAt,
      endedAt: performance.now(),
    }));
  });
  writeFileSync(barrier, '');
  return Promise.all(started);
}

function runShip(dir, env, branch, extra = {}) {
  return spawnSync('/bin/bash', [scriptPath, branch, 'ship it', 'note.txt'], {
    cwd: dir,
    input: 'pr body\n',
    encoding: 'utf8',
    env,
    ...extra,
  });
}

function seedScopedFile(dir) {
  writeFileSync(join(dir, 'note.txt'), 'hi\n');
}

function worktreeList(git) {
  return git(['worktree', 'list']);
}

describe('liveness and record parsing under hostile values', () => {
  it.each([
    ['0', "kill -0 0 targets the caller's own process group, so it always succeeds"],
    ['-1', 'kill -0 -1 targets every process the caller may signal'],
  ])('treats pid %s as absent, not alive (%s)', (pid) => {
    // Regression: `ps -p` rejects both, but the kill fallback SUCCEEDS for them because POSIX gives
    // 0 and negatives special meaning in kill(2). Before the guard, a record carrying either value
    // read as permanently alive — so its orphan could never be reclaimed and every retry refused,
    // which is the exact manual-cleanup loop this work exists to remove.
    expect(livenessOf(pid, '')).toBe('dead');
  });

  it.each([['abc'], ['12 34'], ['1e5'], ['']])('treats a non-numeric pid %j as absent', (pid) => {
    expect(livenessOf(pid, '')).toBe('dead');
  });

  it('falls back to presence only when the record carries no identity', () => {
    // The busybox-`ps` degradation ladder. It must fail toward ALIVE: refusing costs a message,
    // reclaiming a live ship costs its worktree mid-gate.
    const pid = spawnSleeper();
    expect(livenessOf(pid, '')).toBe('alive');
    expect(livenessOf(DEAD_PID, '')).toBe('dead');
  });

  it('drops a torn trailing key rather than reading half a value as a real one', () => {
    // A SIGKILL can land mid-append. `keep` is the dangerous one: reading a half-written `keep`
    // as set would make an ordinary orphan look deliberately preserved and block reclamation.
    const torn = join(mkdtempSync(join(tmpdir(), 'ship-torn-')), 'devkit-ship-run');
    dirs.push(dirname(torn));
    writeFileSync(torn, 'v=1\nbranch=feat/x\npid=12345\nbase=deadbeef\nkee');
    expect(evalInShipLib(`ship_run_record_get ${JSON.stringify(torn)} keep`)).toBe('');
    expect(evalInShipLib(`ship_run_record_get ${JSON.stringify(torn)} pid`)).toBe('12345');
  });

  it('reads the LAST value of a repeated key, matching the append-only write order', () => {
    const rec = join(mkdtempSync(join(tmpdir(), 'ship-append-')), 'devkit-ship-run');
    dirs.push(dirname(rec));
    writeFileSync(rec, 'v=1\ngate_pid=111\nkeep=1\ngate_pid=222\n');
    expect(evalInShipLib(`ship_run_record_get ${JSON.stringify(rec)} gate_pid`)).toBe('222');
  });

  it('reports a partial worktree list as unknown, never as empty', () => {
    // The whole reason the porcelain reader carries git's exit status in-band. An `awk` pipeline
    // would render a torn .git/worktrees entry as "no worktrees registered" — which downstream
    // reads as "nothing is holding this branch" and licenses deleting it.
    const seen = evalInShipLib(
      `worktree_registry_stream /definitely/not/a/repo | tr '\\0' '\\n' | grep '^devkit-worktree-list-status' || true`,
    );
    expect(seen).not.toBe('');
    expect(seen).not.toContain('status 0');
  });
});

describe('concurrent agents sharing one checkout', () => {
  it('leaves a branch that moved past the recorded base alone (compare-and-delete)', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const base = git(['rev-parse', 'work']).trim();
    const { wt, record } = orphanWorktree(git, 'feat/moved');
    writeRecord(record, {
      v: 1,
      branch: 'feat/moved',
      wt,
      pid: DEAD_PID,
      identity: 'Wed Aug 26 14:18:10 2026',
      base,
      branch_created: 1,
      mode: 'live',
    });
    execFileSync('git', ['commit', '--no-verify', '-q', '--allow-empty', '-m', 'concurrent'], {
      cwd: wt,
      env,
    });
    const moved = git(['rev-parse', 'feat/moved']).trim();
    expect(moved).not.toBe(base);

    runShip(dir, publishEnvFor(env), 'feat/moved');

    expect(localBranchExists(git, 'feat/moved')).toBe(true);
    expect(git(['rev-parse', 'feat/moved']).trim()).toBe(moved);
  });

  it("never touches a sibling agent's live ship on a different branch", () => {
    // Two panes shipping at once. The preflight enumerates EVERY registered worktree, so a bug in
    // candidate selection would let one agent reclaim the other's worktree mid-gate.
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const base = git(['rev-parse', 'work']).trim();
    const sibling = orphanWorktree(git, 'feat/sibling');
    const pid = spawnSleeper();
    writeRecord(sibling.record, {
      v: 1,
      branch: 'feat/sibling',
      wt: sibling.wt,
      pid,
      identity: identityOf(pid),
      base,
      branch_created: 1,
      mode: 'live',
    });

    const r = runShip(dir, publishEnvFor(env), 'feat/mine');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('feat/sibling');
    expect(worktreeList(git)).toContain(sibling.wt);
    expect(localBranchExists(git, 'feat/sibling')).toBe(true);
  });

  it('lets only one of two concurrent reclaims delete the branch, and neither corrupt it', async () => {
    const { dir, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const base = git(['rev-parse', 'work']).trim();
    const { wt, record } = orphanWorktree(git, 'feat/race');
    writeRecord(record, {
      v: 1,
      branch: 'feat/race',
      wt,
      pid: DEAD_PID,
      identity: 'Wed Aug 26 14:18:10 2026',
      base,
      branch_created: 1,
      mode: 'live',
    });

    const racers = await reclaimConcurrently(dir, 'feat/race');

    // Prove the race actually happened before trusting what it proves: both reclaims must have been
    // in flight at the same moment. A sequential pair would show the second one running over an
    // already-clean state and would assert nothing about a contended registry.
    const [first, second] = racers.sort((x, y) => x.startedAt - y.startedAt);
    expect(first.endedAt).toBeGreaterThan(second.startedAt);
    for (const racer of racers) expect(racer.code).toBe(0);

    expect(localBranchExists(git, 'feat/race')).toBe(false);
    expect(worktreeList(git)).not.toContain(wt);
    // A wedged registry surfaces here: `worktree list` itself starts failing.
    expect(() => git(['worktree', 'list'])).not.toThrow();
  });

  it('names the GATE pid when the shell died but its detached gate tree survived', async () => {
    // sc-2159's literal shape, and the arm that made the whole feature necessary. Reporting the
    // recorded shell pid here would tell the operator to kill a process that is already gone, and
    // the no-op would leave force-removing a worktree live reviewers occupy as the only apparent
    // way forward.
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const base = git(['rev-parse', 'work']).trim();
    const { wt, record } = orphanWorktree(git, 'feat/gate-alive');
    const gatePid = spawnSleeper();
    writeRecord(record, {
      v: 1,
      branch: 'feat/gate-alive',
      wt,
      pid: DEAD_PID,
      identity: 'Wed Aug 26 14:18:10 2026',
      base,
      branch_created: 1,
      mode: 'live',
      gate_pid: gatePid,
      gate_identity: identityOf(gatePid),
    });

    const r = runShip(dir, publishEnvFor(env), 'feat/gate-alive');

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('is still running');
    expect(r.stderr).toContain('its shell is gone, but its gate tree is still running');
    expect(r.stderr).toContain(`pid ${gatePid}`);
    expect(r.stderr).not.toContain(`pid ${DEAD_PID}`);
    // Live reviewers still hold this worktree; nothing may touch it.
    expect(worktreeList(git)).toContain(wt);
    expect(localBranchExists(git, 'feat/gate-alive')).toBe(true);
  });

  it('does not offer removing the main working tree, which git always refuses', async () => {
    // The unattributable case that fires on a shared checkout sitting on the branch being shipped —
    // including this PR's own ship. `worktree remove` never applies to a main working tree.
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    git(['checkout', '-q', '-b', 'feat/main-wt'], { stdio: 'ignore' });

    const r = runShip(dir, publishEnvFor(env), 'feat/main-wt');

    expect(r.stderr).toContain('main working tree');
    expect(r.stderr).not.toMatch(/worktree remove --force '[^']*'\s*&&/);
  });

  it('reports a locked worktree instead of reclaiming it', () => {
    // `worktree lock` is how an operator says "in use, off limits" — including across machines on a
    // shared checkout, where the owning process is not even visible in this ps table.
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const base = git(['rev-parse', 'work']).trim();
    const { wt, record } = orphanWorktree(git, 'feat/locked');
    writeRecord(record, {
      v: 1,
      branch: 'feat/locked',
      wt,
      pid: DEAD_PID,
      identity: 'Wed Aug 26 14:18:10 2026',
      base,
      branch_created: 1,
      mode: 'live',
    });
    git(['worktree', 'lock', '--reason', 'held by an operator', wt]);

    const r = runShip(dir, publishEnvFor(env), 'feat/locked');

    expect(r.stderr).toContain('locked');
    expect(r.stderr).toContain('held by an operator');
    expect(worktreeList(git)).toContain(wt);
    expect(localBranchExists(git, 'feat/locked')).toBe(true);
    git(['worktree', 'unlock', wt], { stdio: 'ignore' });
  });
});

describe('wiring the record into the rest of the ship', () => {
  it('hands the gate chain a closed stdin and no private signal-lock path', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const probe = join(dir, 'gate-env');
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      `#!/bin/sh\nprintf 'stdin=[%s] lock=[%s]\\n' "$(cat)" "\${DEVKIT_MANAGED_SIGNAL_ROOT:-unset}" > "${probe}"\n`,
    );
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);

    const r = runShip(
      dir,
      { ...env, SHIP_DRY_RUN: '1', DEVKIT_MANAGED_SIGNAL_ROOT: '/tmp/should-not-leak' },
      'feat/gate-env',
    );

    expect(r.status, r.stderr).toBe(0);
    // `cat` returning empty proves /dev/null, not the caller's 'pr body' pipe.
    expect(readFileSync(probe, 'utf8').trim()).toBe('stdin=[] lock=[unset]');
    const wt = /worktree kept at (\S+)/.exec(r.stderr)?.[1];
    if (wt) git(['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
    git(['branch', '-D', 'feat/gate-env'], { stdio: 'ignore' });
  });

  it('records a re-ship worktree as owning no branch', () => {
    // reship's worktree is --detach, so nothing may ever delete a branch on its behalf. Recording it
    // is still what makes a leftover attributable rather than a directory nobody dares remove.
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    git(['push', '-q', 'origin', 'work:pr-open'], { stdio: 'ignore' });
    seedScopedFile(dir);

    const r = spawnSync('/bin/bash', [reshipScript, '--pr', 'pr-open', 'ship it', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: { ...publishEnvFor(env), SHIP_DRY_RUN: '1' },
    });

    expect(r.status, r.stderr).toBe(0);
    expect(bare).toBeTruthy();
    const admin = git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    const records = execFileSync(
      '/bin/sh',
      ['-c', `cat ${JSON.stringify(admin)}/worktrees/*/devkit-ship-run 2>/dev/null || true`],
      { encoding: 'utf8' },
    );
    expect(records).toContain('branch_created=0');
    expect(records).toContain('mode=reship');
    for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
      if (line.startsWith('worktree ') && line.includes('devkit-reship-')) {
        git(['worktree', 'remove', '--force', line.slice('worktree '.length)], { stdio: 'ignore' });
      }
    }
  });

  it('ignores a record whose branch is not the one being shipped', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const base = git(['rev-parse', 'work']).trim();
    const { wt, record } = orphanWorktree(git, 'feat/other', { detach: true });
    writeRecord(record, {
      v: 1,
      branch: 'feat/other',
      wt,
      pid: DEAD_PID,
      identity: 'Wed Aug 26 14:18:10 2026',
      base,
      branch_created: 0,
      mode: 'live',
    });

    const r = runShip(dir, publishEnvFor(env), 'feat/unrelated');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('reclaimed');
    expect(worktreeList(git)).toContain(wt);
  });
});

describe('ship run record + orphan preflight', () => {
  it('reclaims the worktree and empty branch a killed ship left, then ships (sc-2159)', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const base = git(['rev-parse', 'work']).trim();
    const { wt, record } = orphanWorktree(git, 'feat/orphan');
    // A pid that is provably gone: this is the ONLY thing that licenses reclamation.
    expect(() => process.kill(Number(DEAD_PID), 0)).toThrow();
    writeRecord(record, {
      v: 1,
      branch: 'feat/orphan',
      wt,
      pid: DEAD_PID,
      identity: 'Wed Aug 26 14:18:10 2026',
      base,
      branch_created: 1,
      mode: 'live',
    });

    const r = runShip(dir, publishEnvFor(env), 'feat/orphan');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('reclaimed the worktree of a ship that was killed');
    expect(r.stderr).toContain('held no commit — deleted');
    // The whole point: the run does not merely delete the orphan, it goes on to open the PR that the
    // orphan was blocking. Asserting the branch vanished would pass even if the ship then died.
    expect(r.stdout).toContain('https://github.com/acme/app/pull/42');
    expect(worktreeList(git)).not.toContain(wt);
  });

  it('refuses without touching anything while the recorded owner is still alive', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const base = git(['rev-parse', 'work']).trim();
    const { wt, record } = orphanWorktree(git, 'feat/live');
    const pid = spawnSleeper();
    writeRecord(record, {
      v: 1,
      branch: 'feat/live',
      wt,
      pid,
      identity: identityOf(pid),
      base,
      branch_created: 1,
      mode: 'live',
    });

    const r = runShip(dir, publishEnvFor(env), 'feat/live');

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('is still running');
    expect(r.stderr).toContain(`pid ${pid}`);
    // Refusing must be inert: a live ship's worktree and branch survive untouched.
    expect(worktreeList(git)).toContain(wt);
    expect(localBranchExists(git, 'feat/live')).toBe(true);
    expect(existsSync(wt)).toBe(true);
  });

  it('treats a recycled pid as dead — presence alone must not protect an orphan', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const base = git(['rev-parse', 'work']).trim();
    const { wt, record } = orphanWorktree(git, 'feat/recycled');
    const pid = spawnSleeper(); // alive, but NOT the process the record describes
    writeRecord(record, {
      v: 1,
      branch: 'feat/recycled',
      wt,
      pid,
      identity: 'Mon Jan  1 00:00:00 1990',
      base,
      branch_created: 1,
      mode: 'live',
    });

    const r = runShip(dir, publishEnvFor(env), 'feat/recycled');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('reclaimed the worktree of a ship that was killed');
    expect(worktreeList(git)).not.toContain(wt);
  });

  it('matches identity across a locale and timezone change, so a LIVE ship is never reclaimed', () => {
    // The regression this exists for: `ps -o lstart=` is locale- AND TZ-formatted. An agent harness
    // and an interactive shell routinely differ, and an unpinned identity would read MISMATCH for a
    // running ship — licensing a force-remove of its worktree mid-gate.
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const base = git(['rev-parse', 'work']).trim();
    const { wt, record } = orphanWorktree(git, 'feat/locale');
    const pid = spawnSleeper();
    const written = execFileSync(
      '/bin/bash',
      ['-c', `. "${join(scriptPath, '../ship-run-record.sh')}"; ship_run_identity ${pid}`],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'de_DE.UTF-8', TZ: 'America/New_York' },
      },
    ).trim();
    expect(written).not.toBe('');
    writeRecord(record, {
      v: 1,
      branch: 'feat/locale',
      wt,
      pid,
      identity: written,
      base,
      branch_created: 1,
      mode: 'live',
    });

    const r = runShip(dir, { ...publishEnvFor(env), LC_ALL: 'C', TZ: 'UTC' }, 'feat/locale');

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('is still running');
    expect(worktreeList(git)).toContain(wt);
  });

  it('never reclaims a worktree a staged-set abort deliberately kept', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const base = git(['rev-parse', 'work']).trim();
    const { wt, record } = orphanWorktree(git, 'feat/kept');
    writeRecord(record, {
      v: 1,
      branch: 'feat/kept',
      wt,
      pid: DEAD_PID,
      identity: 'Wed Aug 26 14:18:10 2026',
      base,
      branch_created: 1,
      keep: 1,
      keep_reason: 'staged set changed before the commit',
    });

    const r = runShip(dir, publishEnvFor(env), 'feat/kept');

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('kept its worktree deliberately');
    // The clobbered index IS the evidence the abort exists to preserve.
    expect(worktreeList(git)).toContain(wt);
    expect(existsSync(wt)).toBe(true);
  });

  it('leaves an unattributable worktree alone and says so', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const { wt } = orphanWorktree(git, 'feat/norecord'); // no record written

    const r = runShip(dir, publishEnvFor(env), 'feat/norecord');

    expect(r.stderr).toContain('no devkit run record there');
    // No record, no destructive action — and ship still refuses exactly as it did before.
    expect(worktreeList(git)).toContain(wt);
    expect(localBranchExists(git, 'feat/norecord')).toBe(true);
  });

  it('keeps a branch whose commit landed, reclaiming only the worktree', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const base = git(['rev-parse', 'work']).trim();
    const { wt, record } = orphanWorktree(git, 'feat/landed');
    writeRecord(record, {
      v: 1,
      branch: 'feat/landed',
      wt,
      pid: DEAD_PID,
      identity: 'Wed Aug 26 14:18:10 2026',
      base,
      branch_created: 1,
      mode: 'live',
    });
    execFileSync('git', ['commit', '--no-verify', '-q', '--allow-empty', '-m', 'landed'], {
      cwd: wt,
      env,
    });

    const r = runShip(dir, publishEnvFor(env), 'feat/landed');

    expect(r.stderr).toContain('is still on feat/landed');
    // Work that was committed but never published must survive for the resume path to judge.
    expect(localBranchExists(git, 'feat/landed')).toBe(true);
    expect(worktreeList(git)).not.toContain(wt);
    expect(r.stderr).toContain('a killed ship left behind');
  });

  it('prunes a registration whose directory is gone and deletes its empty branch', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const base = git(['rev-parse', 'work']).trim();
    const { wt, record } = orphanWorktree(git, 'feat/pruned');
    writeRecord(record, {
      v: 1,
      branch: 'feat/pruned',
      wt,
      pid: DEAD_PID,
      identity: 'Wed Aug 26 14:18:10 2026',
      base,
      branch_created: 1,
      mode: 'live',
    });
    rmSync(wt, { recursive: true, force: true }); // a reaped TMPDIR — the record outlives the files

    const r = runShip(dir, publishEnvFor(env), 'feat/pruned');

    expect(r.status, r.stderr).toBe(0);
    expect(worktreeList(git)).not.toContain(wt);
    expect(r.stdout).toContain('https://github.com/acme/app/pull/42');
  });

  it('never deletes a branch the recorded run did not create', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const base = git(['rev-parse', 'work']).trim();
    const { wt, record } = orphanWorktree(git, 'feat/adopted');
    // branch_created=0 is how the resume path records itself: it ATTACHED to somebody else's branch.
    writeRecord(record, {
      v: 1,
      branch: 'feat/adopted',
      wt,
      pid: DEAD_PID,
      identity: 'Wed Aug 26 14:18:10 2026',
      base,
      branch_created: 0,
      mode: 'live',
    });

    runShip(dir, publishEnvFor(env), 'feat/adopted');

    expect(localBranchExists(git, 'feat/adopted')).toBe(true);
    expect(worktreeList(git)).not.toContain(wt);
  });

  it('does not confuse feat/x with feat-x, which share a worktree path', () => {
    // ship-branch.sh names its worktree devkit-ship-${BR//\//-}-$$, so the two branches collide THERE.
    // Ownership therefore comes from the record and the branch ref, never from the path.
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const base = git(['rev-parse', 'work']).trim();
    const { wt, record } = orphanWorktree(git, 'feat/x');
    const pid = spawnSleeper();
    writeRecord(record, {
      v: 1,
      branch: 'feat/x',
      wt,
      pid,
      identity: identityOf(pid),
      base,
      branch_created: 1,
      mode: 'live',
    });

    const r = runShip(dir, publishEnvFor(env), 'feat-x');

    // Shipping feat-x must neither refuse because of feat/x nor touch its live worktree.
    expect(r.stderr).not.toContain('is still running');
    expect(worktreeList(git)).toContain(wt);
    expect(localBranchExists(git, 'feat/x')).toBe(true);
  });

  it('writes a record naming this run inside the worktree it creates', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);

    const r = runShip(dir, { ...env, SHIP_DRY_RUN: '1' }, 'feat/records');

    expect(r.status, r.stderr).toBe(0);
    const wt = /worktree kept at (\S+)/.exec(r.stderr)?.[1];
    expect(wt).toBeTruthy();
    const admin = git(['-C', wt, 'rev-parse', '--absolute-git-dir']).trim();
    const record = execFileSync('cat', [join(admin, 'devkit-ship-run')], { encoding: 'utf8' });
    expect(record).toContain('branch=feat/records');
    expect(record).toContain('branch_created=1');
    expect(record).toContain('mode=dry');
    expect(record).toMatch(/\npid=\d+\n/);
    // Without a start-time identity the reader falls back to presence only, and a recycled pid would
    // then keep an orphan alive forever.
    expect(record).toMatch(/\nidentity=\w/);
    git(['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
    git(['branch', '-D', 'feat/records'], { stdio: 'ignore' });
  });

  it('reaps the whole gate tree when only the CLI process is signalled (sc-2159)', async () => {
    // The only test that drives cli/commands/ship.mts rather than the script directly.
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const gatePidFile = join(dir, '.gate-pid');
    const ready = join(dir, '.gate-ready');
    const hook = join(dir, '.husky/_/pre-commit');
    // The hook publishes its OWN pid: it is a grandchild in the script's process group, and its argv
    // carries nothing a pgrep pattern could match. `ready` is touched only after the pid is on disk,
    // so waitForPath cannot observe a half-written file.
    writeFileSync(
      hook,
      `#!/bin/sh\necho $$ > "${gatePidFile}"\ntouch "${ready}"\nwhile :; do sleep 0.1; done\n`,
    );
    chmodSync(hook, 0o755);

    const cli = spawn(
      process.execPath,
      [
        join(dirname(scriptPath), '../../index.mts'),
        'ship',
        'feat/signalled',
        'ship it',
        'note.txt',
      ],
      {
        cwd: dir,
        stdio: 'ignore',
        env: { ...publishEnvFor(env), SHIP_DRY_RUN: '1' },
      },
    );
    await waitForPath(ready, 60_000);
    const gatePid = Number(readFileSync(gatePidFile, 'utf8').trim());
    expect(gatePid).toBeGreaterThan(0);
    expect(processAlive(gatePid)).toBe(true);

    cli.kill('SIGTERM');
    const [code] = await once(cli, 'exit');

    expect(code).toBe(143);
    expect(processAlive(gatePid)).toBe(false);
    expect(git(['worktree', 'list'])).not.toMatch(/devkit-ship-/);
  }, 120_000);

  it('records nothing and reclaims nothing under SHIP_RESOLVE_ONLY', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    seedScopedFile(dir);
    const base = git(['rev-parse', 'work']).trim();
    const { wt, record } = orphanWorktree(git, 'feat/resolve');
    writeRecord(record, {
      v: 1,
      branch: 'feat/resolve',
      wt,
      pid: DEAD_PID,
      identity: 'Wed Aug 26 14:18:10 2026',
      base,
      branch_created: 1,
      mode: 'live',
    });

    spawnSync('/bin/bash', [scriptPath, 'feat/resolve', 'ship it', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1', SHIP_RESOLVE_ONLY: '1' },
    });

    // The resolve seam promises no side effects; reclaiming would be one.
    expect(worktreeList(git)).toContain(wt);
    expect(localBranchExists(git, 'feat/resolve')).toBe(true);
  });
});
