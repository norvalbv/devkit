import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  buildAndRun,
  localBranchExists,
  remoteBranchExists,
  reviewerTimeoutEnv,
  scriptPath,
  seedBaseRepo,
  seedShipRepo,
} from './_ship-branch-fixture.mts';

describe('ship-branch.sh — --dry-gates', () => {
  it('supports the same committed --from-branch source snapshot without keeping a branch', () => {
    const { dir, env, git, bare } = seedBaseRepo({
      hookBody: 'test "$(git diff --cached --name-only)" = note.txt',
    });

    const r = spawnSync(
      '/bin/bash',
      [
        scriptPath,
        'feat/dry-gates-branch',
        'ship it',
        '--dry-gates',
        '--base',
        'studio',
        '--from-branch',
      ],
      { cwd: dir, input: '', encoding: 'utf8', env },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(localBranchExists(git, 'feat/dry-gates-branch')).toBe(false);
    expect(remoteBranchExists(bare, 'feat/dry-gates-branch')).toBe(false);
  });

  it('rehearses the exact fetched base and explicit path brief without leaving a commit or branch', () => {
    const { dir, env, git, bare, studioTip } = seedBaseRepo({
      hookBody: `
[ "\${DEVKIT_RUN_MODE:-}" = dry-gates ] || exit 0
test "$DEVKIT_RUN_MODE" = dry-gates || exit 91
test "$DEVKIT_REVIEW_GUARDS" = comments || exit 92
test "$DEVKIT_SHIP_BASE_SHA" = "$EXPECTED_BASE" || exit 93
test "$(git diff --cached --name-only)" = note.txt || exit 94
test "$(cat note.txt)" = finalized || exit 95
test -f coverage/coverage-summary.json || exit 96
test -z "$(git symbolic-ref -q --short HEAD)" || exit 97
printf 'DRY_GATES_HOOK_OK\n'
`,
    });
    const headBefore = git(['rev-parse', 'HEAD']).trim();
    mkdirSync(join(dir, 'coverage'), { recursive: true });
    writeFileSync(join(dir, 'coverage', 'coverage-summary.json'), '{}\n');
    writeFileSync(join(dir, 'unrelated.txt'), 'parallel work\n');

    const r = spawnSync(
      '/bin/bash',
      [
        scriptPath,
        'feat/dry-gates',
        'ship it',
        '--dry-gates',
        '--base',
        'studio',
        '--',
        'note.txt',
      ],
      {
        cwd: dir,
        input: '',
        encoding: 'utf8',
        env: { ...env, EXPECTED_BASE: studioTip },
      },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/dry gates.*decision.*domain.*completeness/is);
    expect(r.stderr).not.toContain('DRY: committed locally');
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(localBranchExists(git, 'feat/dry-gates')).toBe(false);
    expect(remoteBranchExists(bare, 'feat/dry-gates')).toBe(false);
    const gateLog = /full output: (.+)/.exec(r.stderr)?.[1];
    expect(gateLog).toBeTruthy();
    expect(realpathSync(dirname(gateLog))).toBe(realpathSync(join(dir, '.devkit')));
    expect(basename(gateLog)).toMatch(/^last-ship-gates-.+\.log$/);
    expect(readFileSync(gateLog, 'utf8')).toContain('DRY_GATES_HOOK_OK');
  });

  it('returns the hook failure and still removes its ephemeral branch', () => {
    const { dir, env, git } = seedShipRepo({ hookBody: 'echo DRY_GATES_BLOCKED >&2\nexit 1' });
    writeFileSync(join(dir, 'note.txt'), 'blocked\n');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/dry-gates-blocked', 'ship it', '--dry-gates', '--', 'note.txt'],
      { cwd: dir, input: '', encoding: 'utf8', env },
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('DRY_GATES_BLOCKED');
    expect(localBranchExists(git, 'feat/dry-gates-blocked')).toBe(false);
  });

  it('removes a locked detached worktree without ever creating a branch', () => {
    const { dir, env, git } = seedShipRepo({
      hookBody: `
test -z "$(git symbolic-ref -q --short HEAD)" || exit 97
git worktree lock --reason test .
echo DRY_GATES_LOCKED_OK`,
    });
    writeFileSync(join(dir, 'note.txt'), 'blocked\n');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/dry-gates-locked', 'ship it', '--dry-gates', '--', 'note.txt'],
      { cwd: dir, input: '', encoding: 'utf8', env },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('DRY_GATES_LOCKED_OK');
    expect(localBranchExists(git, 'feat/dry-gates-locked')).toBe(false);
    const linked = git(['worktree', 'list', '--porcelain'])
      .split('\n\n')
      .map((block) => /^worktree (.+)$/m.exec(block)?.[1])
      .find((path) => path && realpathSync(path) !== realpathSync(dir));
    expect(linked).toBeUndefined();
  });

  it('allocates distinct proof logs for repeated same-branch rehearsals', () => {
    const { dir, env } = seedShipRepo();
    writeFileSync(join(dir, 'note.txt'), 'concurrent\n');

    const run = () =>
      spawnSync(
        '/bin/bash',
        [scriptPath, 'feat/dry-gates-shared', 'ship it', '--dry-gates', '--', 'note.txt'],
        { cwd: dir, input: '', encoding: 'utf8', env },
      );

    const results = [run(), run()];
    for (const result of results) expect(result.status, result.stderr).toBe(0);
    const logs = results.map((result) => /full output: (.+)/.exec(result.stderr)?.[1]);
    expect(logs[0]).toBeTruthy();
    expect(logs[1]).toBeTruthy();
    expect(logs[0]).not.toBe(logs[1]);
  });
});

// The marker the generated review fragment prints before the fleet runs (ai-guard-fragments.mts).
const REVIEWER_GATE_LINE = 'echo "🔍 Reviewer gate (headless domain judges)..."';

function linkedWorktrees(git, dir) {
  return git(['worktree', 'list', '--porcelain'])
    .split('\n\n')
    .map((block) => /^worktree (.+)$/m.exec(block)?.[1])
    .filter((path) => path && realpathSync(path) !== realpathSync(dir));
}

/** A `node` shim that records each judge-preflight invocation, then runs the real node. */
function preflightSpyEnv(dir, env) {
  const bin = join(dir, 'preflight-spy-bin');
  const calls = join(dir, 'preflight-calls.log');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'node'),
    [
      '#!/bin/bash',
      'if [[ $1 == */preflight/judge.* ]]; then echo judge >> "$PREFLIGHT_CALLS"; fi',
      'exec "$REAL_NODE" "$@"',
    ].join('\n'),
  );
  chmodSync(join(bin, 'node'), 0o755);
  return {
    env: {
      ...env,
      PATH: `${bin}:${env.PATH ?? ''}`,
      REAL_NODE: process.execPath,
      PREFLIGHT_CALLS: calls,
    },
    ran: () => existsSync(calls),
  };
}

describe('ship-branch.sh — --dry-gates --with-reviewers', () => {
  it('selects the reviewer gate on the exact staging, never the completeness judge, and keeps nothing', () => {
    const { dir, env, git, bare, studioTip } = seedBaseRepo({
      hookBody: `
[ "\${DEVKIT_RUN_MODE:-}" = dry-gates ] || exit 0
test "$DEVKIT_REVIEW_GUARDS" = comments,review || exit 81
test "\${DEVKIT_SHIP_DRY_REVIEWERS:-}" = 1 || exit 82
test "$DEVKIT_SHIP_BASE_SHA" = "$EXPECTED_BASE" || exit 83
test "$(git diff --cached --name-only)" = note.txt || exit 84
test -z "\${DEVKIT_COMMIT_MSG_FILE:-}" || exit 85
case "$DEVKIT_REVIEW_PROGRESS" in *-dry-*) ;; *) exit 86 ;; esac
test "$DEVKIT_REVIEW_PROGRESS" != "$SHIP_ROOT/.devkit/review-progress-feat-dry-review.json" || exit 87
${REVIEWER_GATE_LINE}
printf 'DRY_REVIEW_HOOK_OK\\n'
`,
    });
    // A caller that already exported a message file (a parent ship, a hand-run hook) must not arm the
    // parallel completeness judge: the rehearsal has no commit message of its own to judge.
    const strayMsg = join(dir, 'stray-msg.txt');
    writeFileSync(strayMsg, 'feat: stray\n');
    const headBefore = git(['rev-parse', 'HEAD']).trim();

    const r = spawnSync(
      '/bin/bash',
      // Flag order is free: the modifier may precede the mode it modifies.
      [
        scriptPath,
        'feat/dry-review',
        'ship it',
        '--with-reviewers',
        '--dry-gates',
        '--base',
        'studio',
        '--',
        'note.txt',
      ],
      {
        cwd: dir,
        input: '',
        encoding: 'utf8',
        env: {
          ...env,
          EXPECTED_BASE: studioTip,
          SHIP_ROOT: realpathSync(dir),
          DEVKIT_COMMIT_MSG_FILE: strayMsg,
        },
      },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/dry gates.*domain reviewers/is);
    expect(r.stderr).toMatch(/Skipping decision, Qavis, completeness/);
    expect(r.stderr).toMatch(/dry gates \+ reviewers passed/);
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(localBranchExists(git, 'feat/dry-review')).toBe(false);
    expect(remoteBranchExists(bare, 'feat/dry-review')).toBe(false);
    expect(git(['for-each-ref', 'refs/devkit/']).trim()).toBe('');
    expect(linkedWorktrees(git, dir)).toEqual([]);
    const gateLog = /full output: (.+)/.exec(r.stderr)?.[1];
    expect(readFileSync(gateLog, 'utf8')).toContain('DRY_REVIEW_HOOK_OK');
  });

  it('a plain --dry-gates ignores a reviewer allowlist leaked in from the caller environment', () => {
    const { dir, env, git } = seedShipRepo({
      hookBody: `
[ "\${DEVKIT_RUN_MODE:-}" = dry-gates ] || exit 0
test "$DEVKIT_REVIEW_GUARDS" = comments || exit 91
test -z "\${DEVKIT_SHIP_DRY_REVIEWERS:-}" || exit 92`,
    });
    writeFileSync(join(dir, 'note.txt'), 'plain\n');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/dry-leak', 'ship it', '--dry-gates', '--', 'note.txt'],
      {
        cwd: dir,
        input: '',
        encoding: 'utf8',
        env: { ...env, DEVKIT_REVIEW_GUARDS: 'comments,review', DEVKIT_SHIP_DRY_REVIEWERS: '1' },
      },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/reviewers passed/);
    expect(localBranchExists(git, 'feat/dry-leak')).toBe(false);
  });

  it('never claims reviewers passed when the installed hook has no reviewer gate', () => {
    // A consumer that did not select the review component gets a hook with no guard-review block, so
    // the allowlist selects nothing. A green line naming reviewers would be a false clearance.
    const { dir, env, git } = seedShipRepo({ hookBody: 'exit 0' });
    writeFileSync(join(dir, 'note.txt'), 'no reviewers installed\n');

    const r = spawnSync(
      '/bin/bash',
      [
        scriptPath,
        'feat/dry-no-review',
        'ship it',
        '--dry-gates',
        '--with-reviewers',
        '--',
        'note.txt',
      ],
      { cwd: dir, input: '', encoding: 'utf8', env },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/reviewers passed/);
    expect(r.stderr).toMatch(/no reviewer gate ran/i);
    expect(localBranchExists(git, 'feat/dry-no-review')).toBe(false);
  });

  it('reports judge reachability only when reviewers will actually run', () => {
    const plain = seedShipRepo();
    writeFileSync(join(plain.dir, 'note.txt'), 'x\n');
    const plainSpy = preflightSpyEnv(plain.dir, plain.env);
    const a = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/dry-preflight-off', 't', '--dry-gates', '--', 'note.txt'],
      { cwd: plain.dir, input: '', encoding: 'utf8', env: plainSpy.env },
    );
    expect(a.status, a.stderr).toBe(0);
    expect(plainSpy.ran()).toBe(false);

    const withReviewers = seedShipRepo();
    writeFileSync(join(withReviewers.dir, 'note.txt'), 'x\n');
    const spy = preflightSpyEnv(withReviewers.dir, withReviewers.env);
    const b = spawnSync(
      '/bin/bash',
      [
        scriptPath,
        'feat/dry-preflight-on',
        't',
        '--dry-gates',
        '--with-reviewers',
        '--',
        'note.txt',
      ],
      { cwd: withReviewers.dir, input: '', encoding: 'utf8', env: spy.env },
    );
    expect(b.status, b.stderr).toBe(0);
    expect(spy.ran()).toBe(true);
  });

  for (const rc of [1, 3]) {
    it(`propagates a reviewer block (exit ${rc}) unchanged and still removes the worktree`, () => {
      const { dir, env, git } = seedShipRepo({
        hookBody: `${REVIEWER_GATE_LINE}\necho DRY_REVIEW_BLOCKED >&2\nexit ${rc}`,
      });
      writeFileSync(join(dir, 'note.txt'), 'blocked\n');

      const r = spawnSync(
        '/bin/bash',
        [
          scriptPath,
          'feat/dry-review-blocked',
          'ship it',
          '--dry-gates',
          '--with-reviewers',
          '--',
          'note.txt',
        ],
        { cwd: dir, input: '', encoding: 'utf8', env },
      );

      expect(r.status).toBe(rc);
      expect(r.stderr).toContain('DRY_REVIEW_BLOCKED');
      expect(r.stderr).not.toMatch(/reviewers passed/);
      // No invocation was recorded, so advertising --resume would point at a refusal.
      expect(r.stderr).not.toMatch(/devkit ship --resume/);
      expect(localBranchExists(git, 'feat/dry-review-blocked')).toBe(false);
      expect(git(['for-each-ref', 'refs/devkit/']).trim()).toBe('');
      expect(linkedWorktrees(git, dir)).toEqual([]);
    });
  }

  it('a timeout mid-reviewer names the unfinished reviewer, mints no receipt, and keeps nothing', () => {
    const { dir, env, git } = seedShipRepo();
    writeFileSync(join(dir, 'note.txt'), 'slow\n');

    const r = spawnSync(
      '/bin/bash',
      [
        scriptPath,
        'feat/dry-review-timeout',
        't',
        '--dry-gates',
        '--with-reviewers',
        '--',
        'note.txt',
      ],
      {
        cwd: dir,
        input: '',
        encoding: 'utf8',
        env: { ...reviewerTimeoutEnv(dir, env), SHIP_COMMIT_TIMEOUT: '15' },
      },
    );

    expect(r.status, r.stderr).toBe(124);
    expect(r.stderr).toMatch(/unfinished.*commit-guard/);
    expect(r.stderr).not.toMatch(/devkit ship --resume/);
    expect(localBranchExists(git, 'feat/dry-review-timeout')).toBe(false);
    expect(git(['for-each-ref', 'refs/devkit/']).trim()).toBe('');
    expect(linkedWorktrees(git, dir)).toEqual([]);
  });

  it('refuses --with-reviewers without --dry-gates before creating anything', () => {
    const { dir, env, git } = seedShipRepo({ hookBody: 'echo GATE_RAN; exit 0' });
    writeFileSync(join(dir, 'note.txt'), 'x\n');
    const refsBefore = git(['for-each-ref']).trim();

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/review-no-dry', 't', '--with-reviewers', '--', 'note.txt'],
      { cwd: dir, input: '', encoding: 'utf8', env },
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--with-reviewers requires --dry-gates');
    expect(r.stderr).not.toContain('GATE_RAN');
    expect(git(['for-each-ref']).trim()).toBe(refsBefore);
    expect(linkedWorktrees(git, dir)).toEqual([]);
  });

  it('refuses --with-reviewers under --resume', () => {
    const { dir, env } = seedShipRepo();
    const r = spawnSync('/bin/bash', [scriptPath, '--resume', 'feat/x', '--with-reviewers'], {
      cwd: dir,
      input: '',
      encoding: 'utf8',
      env,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--with-reviewers cannot be combined with --resume');
  });

  it('rejects --with-reviewers in a positional slot, naming the ordering rule', () => {
    const r = buildAndRun('main', 'git@github.com:acme/app.git', {
      argv: ['--with-reviewers', 'feat/x', 'title', '--', 'dummy-path'],
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/must come FIRST, before any flag/);
  });
});
