/** Resume cases where the gate chain widened the commit's SCOPE, or the commit DELETED briefed paths
 *  (sc-2089). Sibling of ship-branch-resume.test.mts; ship-branch.test.mts has no headroom left. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  testExecFileSync as execFileSync,
  findModernBash,
  testSpawnSync as spawnSync,
} from './_helpers.mts';
import {
  createScopedPreservedCommit,
  GIT_ENV,
  installHook,
  localBranchExists,
  mintGateAddsRecord,
  publishEnvFor,
  remoteBranchExists,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

/** The path a real ratchet gate stages into the commit it is gating. */
const BASELINE = '.devkit/baselines/size-lines.json';
/** Its sibling, used for the heal-DELETE half of what a ratchet gate does. */
const FANOUT = '.devkit/baselines/fanout.json';
const MODERN_BASH = findModernBash();

/** guard-size lowering its baseline, in miniature: stage an unbriefed file into the pending commit,
 *  then leak a pipe-holding child so the supervisor returns 124 after the commit has landed. */
const RATCHET_HOOK = [
  'echo run >> "$TEST_HOOK_COUNT"',
  'mkdir -p .devkit/baselines',
  `printf '{"files":{"note.txt":1}}' > ${BASELINE}`,
  `git add -f -- ${BASELINE}`,
  'sleep 30 &',
].join('\n');

/** Mint the receipt ship would have written, skipping a real gate ceiling — valid wherever the
 *  variable under test is the SCOPE check, not the timeout. Same shortcut as the sibling suite. */
function preserve(dir, env, git, branch, spec, gateAdds = []) {
  const preserved = createScopedPreservedCommit({ dir, env, git, branch, ...spec });
  git(['update-ref', `refs/devkit/ship-receipts/${branch}`, preserved]);
  if (gateAdds.length > 0) mintGateAddsRecord(dir, env, git, branch, gateAdds);
  return preserved;
}

function retryShip(dir, publishEnv, branch, paths, shell = '/bin/bash') {
  return spawnSync(shell, [scriptPath, branch, 'ship it', '--', ...paths], {
    cwd: dir,
    input: 'pr body\n',
    encoding: 'utf8',
    env: publishEnv,
  });
}

function bareSha(bare, ref) {
  return execFileSync('git', ['-C', bare, 'rev-parse', ref], {
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  }).trim();
}

describe('ship-branch.sh — resume past a gate-widened scope', () => {
  // The whole point, end to end through the REAL recorder: no ref is hand-minted, so this pins
  // ship_record_gate_adds, the blob ref, and the tolerance that reads it as one chain.
  it('records what its gates staged, then resumes and publishes the preserved commit', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    installHook(dir, RATCHET_HOOK);
    const { hookCount, publishEnv } = publishEnvFor(dir, env);
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const argv = [scriptPath, 'feat/gate-widened', 'ship it', '--', 'note.txt'];

    const first = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      timeout: 45_000,
      env: { ...publishEnv, SHIP_COMMIT_TIMEOUT: '15' },
    });

    expect(first.status, first.stderr).toBe(124);
    // Pair every 124 with OUR banner: testSpawnSync also returns 124 at its own deadline.
    expect(first.stderr).toMatch(/gate chain hit the 15s ceiling \(exit 124\)/);
    const preserved = git(['rev-parse', 'feat/gate-widened']).trim();
    // The precondition: the gate really did widen the commit past the brief.
    expect(
      git(['diff', '--name-only', `${preserved}^`, preserved])
        .trim()
        .split('\n')
        .sort(),
    ).toEqual([BASELINE, 'note.txt']);
    // ...and the record names exactly the gate's half of it, NUL-terminated like `git diff -z`.
    const record = git(['cat-file', 'blob', 'refs/devkit/ship-gate-adds/feat/gate-widened']);
    expect(record).toBe(`${BASELINE}\0`);
    // The caller's tree never saw those bytes — the gate wrote them inside the ephemeral worktree.
    expect(existsSync(join(dir, BASELINE))).toBe(false);

    const retry = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: publishEnv,
    });

    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).toContain('gate receipt verified');
    expect(retry.stderr).not.toContain('outside the requested scope');
    expect(remoteBranchExists(bare, 'feat/gate-widened')).toBe(true);
    expect(bareSha(bare, 'feat/gate-widened')).toBe(preserved); // the EXACT gated OID
    expect(readFileSync(hookCount, 'utf8').trim().split('\n')).toHaveLength(1); // gates never re-ran
    // Both private refs are retired together once the work is on the remote.
    expect(localBranchExists(git, 'refs/devkit/ship-gate-adds/feat/gate-widened')).toBe(false);
    expect(localBranchExists(git, 'refs/devkit/ship-receipts/feat/gate-widened')).toBe(false);
  });

  // Why the record is keyed on PROVENANCE: a path the caller briefed itself is absent from it, so
  // narrowing the brief on a retry cannot smuggle that change into the PR.
  it('refuses a NARROWED retry even when the dropped path looks like a gate artifact', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    preserve(dir, env, git, 'feat/narrowed', {
      briefed: { 'note.txt': 'hi\n', [BASELINE]: '{"files":{}}' },
    }); // no record: the operator briefed the baseline, so no gate authored it

    const retry = retryShip(dir, publishEnv, 'feat/narrowed', ['note.txt']);

    expect(retry.status, retry.stderr).toBe(1);
    expect(retry.stderr).toContain('cannot safely resume it: its commit changes paths outside');
    expect(retry.stderr).toContain(`unbriefed paths (1): ${BASELINE}`);
    expect(remoteBranchExists(bare, 'feat/narrowed')).toBe(false);
  });

  // The refusal had no positive coverage at all before this — only a `not.toContain` in the sibling.
  it('refuses a genuinely out-of-scope path and NAMES it', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    preserve(dir, env, git, 'feat/out-of-scope', {
      briefed: { 'note.txt': 'hi\n', 'unrelated.txt': 'not yours\n' },
    });

    const retry = retryShip(dir, publishEnv, 'feat/out-of-scope', ['note.txt']);

    expect(retry.status, retry.stderr).toBe(1);
    expect(retry.stderr).toContain('unbriefed paths (1): unrelated.txt');
    expect(retry.stderr).toContain('a retry that narrows the scope cannot resume');
    expect(remoteBranchExists(bare, 'feat/out-of-scope')).toBe(false);
  });

  // Regression guard for the emptiness test. Filtering the set it reads would refuse this — a
  // manual baseline burn-down is a legitimate ship whose ONLY briefed path is a gate artifact name.
  it('resumes a brief that consists solely of a path gates normally own', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    const preserved = preserve(dir, env, git, 'feat/baseline-only', {
      briefed: { [BASELINE]: '{"files":{"note.txt":1}}' },
    });

    const retry = retryShip(dir, publishEnv, 'feat/baseline-only', [BASELINE]);

    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).not.toContain('no scoped changes');
    expect(bareSha(bare, 'feat/baseline-only')).toBe(preserved);
  });

  // The gate wrote those bytes inside a worktree that no longer exists, so the caller's copy can
  // NEVER match. Re-adding from $ROOT would refuse a correct commit with an unactionable reason.
  it('keeps the commit’s gate-written bytes when the retry briefs that path too', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    const preserved = preserve(
      dir,
      env,
      git,
      'feat/briefed-gate-path',
      {
        tracked: { [BASELINE]: '{"files":{}}' }, // $ROOT keeps THIS, the pre-gate content
        briefed: { 'note.txt': 'hi\n' },
        gateAuthored: { [BASELINE]: '{"files":{"note.txt":1}}' },
      },
      [BASELINE],
    );

    const retry = retryShip(dir, publishEnv, 'feat/briefed-gate-path', ['note.txt', BASELINE]);

    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).not.toContain('no longer match its commit');
    expect(bareSha(bare, 'feat/briefed-gate-path')).toBe(preserved);
    // The published blob is the gate's, not the caller's stale one.
    expect(git(['show', `${preserved}:${BASELINE}`])).toContain('"note.txt":1');
  });
});

describe('ship-branch.sh — resume a commit that deleted briefed paths', () => {
  // `git add` FATALS on a pathspec matching nothing, and set -e turned that into a dead resume for
  // EVERY ship that removes a file — with or without a gate-widened scope.
  it('resumes when the preserved commit deleted one of the briefed paths', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    const preserved = preserve(dir, env, git, 'feat/deleted-path', {
      tracked: { 'gone.txt': 'bye\n' },
      briefed: { 'note.txt': 'hi\n' },
      deleted: ['gone.txt'],
    });

    const retry = retryShip(dir, publishEnv, 'feat/deleted-path', ['note.txt', 'gone.txt']);

    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).not.toContain('did not match any files');
    expect(bareSha(bare, 'feat/deleted-path')).toBe(preserved);
  });

  // With every briefed path filtered out, a bare `git add -A --` would stage the WHOLE worktree and
  // refuse with a bogus drift list. The add has to be skipped outright.
  it('resumes when the commit deleted EVERY briefed path, without staging the worktree', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    const preserved = preserve(dir, env, git, 'feat/all-deleted', {
      tracked: { 'gone-a.txt': 'a\n', 'gone-b.txt': 'b\n' },
      deleted: ['gone-a.txt', 'gone-b.txt'],
    });
    // A file the ship was never briefed on, sitting in the caller's tree the whole time.
    writeFileSync(join(dir, 'bystander.txt'), 'not mine\n');

    const retry = retryShip(dir, publishEnv, 'feat/all-deleted', ['gone-a.txt', 'gone-b.txt']);

    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).not.toContain('no longer match its commit');
    expect(bareSha(bare, 'feat/all-deleted')).toBe(preserved);
    expect(git(['ls-tree', '--name-only', preserved]).trim()).not.toContain('bystander.txt');
  });

  // The filter must not swallow a RESURRECTED path: it matches again, stays in the add set, and the
  // tree comparison must still catch that the caller's tree no longer describes the commit.
  it('still refuses when a deleted briefed path has been re-created since the commit', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    preserve(dir, env, git, 'feat/resurrected', {
      tracked: { 'gone.txt': 'bye\n' },
      briefed: { 'note.txt': 'hi\n' },
      deleted: ['gone.txt'],
    });
    writeFileSync(join(dir, 'gone.txt'), 'back again\n');

    const retry = retryShip(dir, publishEnv, 'feat/resurrected', ['note.txt', 'gone.txt']);

    expect(retry.status, retry.stderr).toBe(1);
    expect(retry.stderr).toContain('the current scoped files no longer match its commit');
    expect(retry.stderr).toContain('gone.txt');
    expect(remoteBranchExists(bare, 'feat/resurrected')).toBe(false);
  });

  // A receipt minted before the record existed must keep today's strict behaviour rather than
  // silently inheriting a tolerance nothing recorded.
  it('falls back to the strict comparison when no gate-adds record exists', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    preserve(dir, env, git, 'feat/no-record', {
      briefed: { 'note.txt': 'hi\n' },
      gateAuthored: { [BASELINE]: '{"files":{"note.txt":1}}' },
    }); // receipt only — no record, exactly like an older devkit's preserved commit

    const retry = retryShip(dir, publishEnv, 'feat/no-record', ['note.txt']);

    expect(retry.status, retry.stderr).toBe(1);
    expect(retry.stderr).toContain('its commit changes paths outside the requested scope');
    expect(remoteBranchExists(bare, 'feat/no-record')).toBe(false);
  });

  // "${arr[@]}" on an EMPTY array aborts under set -u in 4.4+ and is empty in 3.2. Every other case
  // here runs on macOS's 3.2 and so proves nothing about CI's shell.
  (MODERN_BASH ? it : it.skip)(
    `skips the add on bash >= 4 without an unbound-array abort${
      MODERN_BASH ? '' : ' (skipped: no bash >= 4)'
    }`,
    () => {
      const { dir, env, git, bare } = seedShipRepoLocalRemote();
      const { publishEnv } = publishEnvFor(dir, env);
      const preserved = preserve(dir, env, git, 'feat/all-deleted-bash4', {
        tracked: { 'gone-a.txt': 'a\n', 'gone-b.txt': 'b\n' },
        deleted: ['gone-a.txt', 'gone-b.txt'],
      });

      const retry = retryShip(
        dir,
        publishEnv,
        'feat/all-deleted-bash4',
        ['gone-a.txt', 'gone-b.txt'],
        MODERN_BASH,
      );

      expect(retry.status, retry.stderr).toBe(0);
      expect(retry.stderr).not.toMatch(/unbound variable/);
      expect(bareSha(bare, 'feat/all-deleted-bash4')).toBe(preserved);
    },
  );

  // Same dialect split, other half: the gate-adds exclude list is expanded with ${arr[@]+"${arr[@]}"}
  // on EVERY resume, including the overwhelmingly common one where no gate wrote anything.
  (MODERN_BASH ? it : it.skip)(
    `expands an empty gate-adds exclude list on bash >= 4${
      MODERN_BASH ? '' : ' (skipped: no bash >= 4)'
    }`,
    () => {
      const { dir, env, git, bare } = seedShipRepoLocalRemote();
      const { publishEnv } = publishEnvFor(dir, env);
      const preserved = preserve(dir, env, git, 'feat/no-gate-adds-bash4', {
        briefed: { 'note.txt': 'hi\n' },
      });

      const retry = retryShip(
        dir,
        publishEnv,
        'feat/no-gate-adds-bash4',
        ['note.txt'],
        MODERN_BASH,
      );

      expect(retry.status, retry.stderr).toBe(0);
      expect(retry.stderr).not.toMatch(/unbound variable/);
      expect(bareSha(bare, 'feat/no-gate-adds-bash4')).toBe(preserved);
    },
  );
});

describe('ship-branch.sh — resume scope edge cases', () => {
  // A ratchet gate heal-DELETES baselines too (git-index.mts:100), so an ACMR-only recorder would
  // record nothing and the resume would refuse. End to end, so the real recorder is under test.
  it('records a baseline the gate DELETED, and resumes on it', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    mkdirSync(join(dir, '.devkit/baselines'), { recursive: true });
    writeFileSync(join(dir, FANOUT), '{"folders":{}}');
    git(['add', '-A', '--', FANOUT], { stdio: 'ignore' });
    git(['commit', '-q', '--no-verify', '-m', 'seed fanout baseline'], { stdio: 'ignore' });
    installHook(
      dir,
      [
        'echo run >> "$TEST_HOOK_COUNT"',
        `rm -f ${FANOUT}`,
        `git add -A -- ${FANOUT}`,
        'sleep 30 &',
      ].join('\n'),
    );
    const { hookCount, publishEnv } = publishEnvFor(dir, env);
    const argv = [scriptPath, 'feat/gate-deleted', 'ship it', '--', 'note.txt'];

    const first = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      timeout: 45_000,
      env: { ...publishEnv, SHIP_COMMIT_TIMEOUT: '15' },
    });

    expect(first.status, first.stderr).toBe(124);
    expect(first.stderr).toMatch(/gate chain hit the 15s ceiling \(exit 124\)/);
    const preserved = git(['rev-parse', 'feat/gate-deleted']).trim();
    // The precondition: the commit really does carry an unbriefed DELETION the gate made.
    expect(git(['diff', '--name-only', '--diff-filter=D', `${preserved}^`, preserved]).trim()).toBe(
      FANOUT,
    );
    expect(git(['cat-file', 'blob', 'refs/devkit/ship-gate-adds/feat/gate-deleted'])).toBe(
      `${FANOUT}\0`,
    );
    // The caller's tree still has the baseline — the gate removed it only inside the worktree.
    expect(existsSync(join(dir, FANOUT))).toBe(true);

    const retry = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: publishEnv,
    });

    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).not.toContain('outside the requested scope');
    expect(bareSha(bare, 'feat/gate-deleted')).toBe(preserved);
    expect(readFileSync(hookCount, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  // Without `literal`, a record entry's glob matches its neighbours, the add-filter skips a
  // caller-owned path as commit-authoritative, and a DRIFTED tree passes the comparison.
  it('does not let a record entry’s glob characters swallow a neighbouring briefed path', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    preserve(
      dir,
      env,
      git,
      'feat/glob-record',
      {
        briefed: { 'star_name.txt': 'gated\n' },
        gateAuthored: { 'star*name.txt': 'gate\n' },
      },
      ['star*name.txt'],
    );
    // The caller's copy drifts after the commit — the tree comparison must still catch it.
    writeFileSync(join(dir, 'star_name.txt'), 'drifted\n');

    const retry = retryShip(dir, publishEnv, 'feat/glob-record', ['star_name.txt']);

    expect(retry.status, retry.stderr).toBe(1);
    expect(retry.stderr).toContain('the current scoped files no longer match its commit');
    expect(remoteBranchExists(bare, 'feat/glob-record')).toBe(false);
  });

  // Paths with spaces reach six new call sites unquoted-by-accident would break: the recorder's two
  // diffs, both exclude expansions, both add-filter probes, and the hint.
  it('handles briefed and gate-authored paths containing spaces', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    const preserved = preserve(
      dir,
      env,
      git,
      'feat/spaced-paths',
      {
        briefed: { 'my notes.txt': 'hi\n' },
        gateAuthored: { 'gate report.json': '{"a":1}' },
      },
      ['gate report.json'],
    );

    const retry = retryShip(dir, publishEnv, 'feat/spaced-paths', ['my notes.txt']);

    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).not.toContain('outside the requested scope');
    expect(bareSha(bare, 'feat/spaced-paths')).toBe(preserved);
  });

  it('root-anchors gate-authored exclusions when ship is invoked from a subdirectory', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const preserved = preserve(
      dir,
      env,
      git,
      'feat/subdir-scope',
      {
        briefed: { 'sub/note.txt': 'hi\n' },
        gateAuthored: { 'sub/gate.txt': 'gate\n' },
      },
      ['sub/gate.txt'],
    );

    const retry = retryShip(join(dir, 'sub'), publishEnv, 'feat/subdir-scope', ['sub/note.txt']);

    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).not.toContain('outside the requested scope');
    expect(bareSha(bare, 'feat/subdir-scope')).toBe(preserved);
  });

  // The hint caps at 5 and appends the remainder. An off-by-one here reads as a miscount of how much
  // work the operator has to brief, on the one line telling them what to do next.
  it('caps the unbriefed-path hint at five and counts the remainder', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    const extra = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [`extra-${i}.txt`, `body ${i}\n`]),
    );
    preserve(dir, env, git, 'feat/many-unbriefed', {
      briefed: { 'note.txt': 'hi\n', ...extra },
    });

    const retry = retryShip(dir, publishEnv, 'feat/many-unbriefed', ['note.txt']);

    expect(retry.status, retry.stderr).toBe(1);
    expect(retry.stderr).toMatch(
      /unbriefed paths \(7\): extra-0\.txt extra-1\.txt extra-2\.txt extra-3\.txt extra-4\.txt \(\+2 more\)/,
    );
    expect(remoteBranchExists(bare, 'feat/many-unbriefed')).toBe(false);
  });

  // The deletion filter keys on "matches nothing ANYWHERE", not "absent from the commit": a briefed
  // path still in the caller's tree is real work this commit does not carry.
  it('still refuses when a briefed path exists in the tree but not in the commit', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    preserve(dir, env, git, 'feat/absent-from-commit', {
      briefed: { 'note.txt': 'hi\n' },
    });
    writeFileSync(join(dir, 'later.txt'), 'work the commit never saw\n');

    const retry = retryShip(dir, publishEnv, 'feat/absent-from-commit', ['note.txt', 'later.txt']);

    expect(retry.status, retry.stderr).toBe(1);
    expect(retry.stderr).toContain('the current scoped files no longer match its commit');
    expect(retry.stderr).toContain('later.txt');
    expect(remoteBranchExists(bare, 'feat/absent-from-commit')).toBe(false);
  });

  // ...whereas a pathspec matching nothing anywhere contributes nothing to either tree. Pre-fix it
  // exited 128 on `fatal: pathspec ... did not match any files`; pinned so resuming stays deliberate.
  it('resumes when a briefed pathspec matches nothing in the commit or the tree', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    const preserved = preserve(dir, env, git, 'feat/nonexistent-path', {
      briefed: { 'note.txt': 'hi\n' },
    });

    const retry = retryShip(dir, publishEnv, 'feat/nonexistent-path', ['note.txt', 'typoo.txt']);

    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).not.toContain('did not match any files');
    expect(bareSha(bare, 'feat/nonexistent-path')).toBe(preserved);
  });
});
