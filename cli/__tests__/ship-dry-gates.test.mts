import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  buildAndRun,
  dropWorktree,
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

describe('ship — decision-smell advisory before the gate chain', () => {
  const BIG = `${Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n')}\n`;
  const SMELL = 'decision smell (regex only, not a verdict): legacy-deletion — old.ts';
  const DECISIONS_HOOK = '# devkit:guard-decisions\necho GATE_START >&2';
  const reshipPath = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
  const count = (text: string) => text.split(SMELL).length - 1;

  /** Commits a 150-line file, deletes it, and ships the deletion: the legacy-deletion smell. */
  function shipDeletion(
    hookBody: string,
    args: string[],
    env: Record<string, string> = {},
    prepare: (dir: string) => void = () => {},
  ) {
    const seeded = seedShipRepo({ hookBody });
    prepare(seeded.dir);
    writeFileSync(join(seeded.dir, 'old.ts'), BIG);
    seeded.git(['add', 'old.ts']);
    seeded.git(['commit', '-q', '--no-verify', '-m', 'old module']);
    rmSync(join(seeded.dir, 'old.ts'));
    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/smell', 'drop old', ...args, '--', 'old.ts'],
      {
        cwd: seeded.dir,
        input: 'b\n',
        encoding: 'utf8',
        env: { ...seeded.env, GUARD_NO_LOG: '', GUARD_DECISION_NO_LLM: '', ...env },
      },
    );
    return { ...seeded, r };
  }

  it('a rehearsal names the smell before the chain and again last, keeping the exit code', () => {
    const { r, git } = shipDeletion(DECISIONS_HOOK, ['--dry-gates']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr.indexOf(SMELL)).toBeGreaterThan(-1);
    expect(r.stderr.indexOf(SMELL)).toBeLessThan(r.stderr.indexOf('GATE_START'));
    expect(r.stderr.lastIndexOf(SMELL)).toBeGreaterThan(r.stderr.indexOf('GATE_START'));
    expect(localBranchExists(git, 'feat/smell')).toBe(false);
  });

  it('a real ship prints it before the chain, once, when the decisions gate rules', () => {
    const { r, git } = shipDeletion(
      `${DECISIONS_HOOK}\necho 'decision-gate: judge cleared as ROUTINE' >&2`,
      [],
      { SHIP_DRY_RUN: '1' },
    );
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr.indexOf(SMELL)).toBeLessThan(r.stderr.indexOf('GATE_START'));
    expect(count(r.stderr)).toBe(1);
  });

  it("reads an overlay's git-excluded config, which reaches the gate worktree only once linked", () => {
    const { r } = shipDeletion(DECISIONS_HOOK, ['--dry-gates'], {}, (dir) => {
      writeFileSync(join(dir, 'guard.config.json'), '{"decisionsDir": ".devkit/decisions"}\n');
      writeFileSync(join(dir, '.git/info/exclude'), 'guard.config.json\n.devkit/decisions/\n');
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('If it blocks: .devkit/decisions is git-ignored here');
    expect(r.stderr).not.toContain("pass the record's path");
  });

  it('is silent under GUARD_NO_LOG and when the hook has no decisions gate', () => {
    const bypassed = shipDeletion(DECISIONS_HOOK, ['--dry-gates'], { GUARD_NO_LOG: '1' });
    const noGate = shipDeletion('echo GATE_START >&2', ['--dry-gates']);
    for (const { r } of [bypassed, noGate]) {
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).not.toContain('decision smell');
    }
  });

  it('a --pr re-ship prints it before the chain too', () => {
    const { dir, env, git } = seedShipRepo({ hookBody: DECISIONS_HOOK });
    const bare = join(dir, '.origin.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    git(['remote', 'set-url', 'origin', bare]);
    writeFileSync(join(dir, 'old.ts'), BIG);
    git(['add', 'old.ts']);
    git(['commit', '-q', '--no-verify', '-m', 'old module']);
    git(['push', '-q', 'origin', 'HEAD:work', 'HEAD:feat/pr']);
    git(['fetch', '-q', 'origin']);
    rmSync(join(dir, 'old.ts'));
    const r = spawnSync('/bin/bash', [reshipPath, 'feat/pr', 'drop old', '--pr', '--', 'old.ts'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1', GUARD_NO_LOG: '', GUARD_DECISION_NO_LLM: '' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr.indexOf(SMELL)).toBeGreaterThan(-1);
    expect(r.stderr.indexOf(SMELL)).toBeLessThan(r.stderr.indexOf('GATE_START'));
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

/** A `node` shim that records each judge-preflight invocation's args. With `remedy`, the preflight
 *  prints it as a dark judge's family move instead of running; otherwise the real node runs. */
function preflightSpyEnv(dir, env, remedy?: string) {
  const bin = join(dir, 'preflight-spy-bin');
  const calls = join(dir, 'preflight-calls.log');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'node'),
    [
      '#!/bin/bash',
      'if [[ $1 == */preflight/judge.* ]]; then',
      '  echo "${*:2}" >> "$PREFLIGHT_CALLS"',
      remedy === undefined ? '' : `  echo ${remedy}; exit 0`,
      'fi',
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
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []),
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
    expect(r.stderr).toMatch(/Skipping decision, completeness/);
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

  it('reports judge reachability on every rehearsal, informational only when no judge runs', () => {
    const plain = seedShipRepo();
    writeFileSync(join(plain.dir, 'note.txt'), 'x\n');
    const plainSpy = preflightSpyEnv(plain.dir, plain.env);
    const a = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/dry-preflight-plain', 't', '--dry-gates', '--', 'note.txt'],
      { cwd: plain.dir, input: '', encoding: 'utf8', env: plainSpy.env },
    );
    expect(a.status, a.stderr).toBe(0);
    expect(plainSpy.calls()).toEqual([`${realpathSync(plain.dir)} --informational`]);

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
    expect(spy.calls()).toEqual([realpathSync(withReviewers.dir)]);
  });

  it('a green plain rehearsal ends with the dark judge family move, and still exits 0', () => {
    const { dir, env } = seedShipRepo();
    writeFileSync(join(dir, 'note.txt'), 'x\n');
    const spy = preflightSpyEnv(dir, env, 'DARK_JUDGE_REMEDY');
    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/dry-dark', 't', '--dry-gates', '--', 'note.txt'],
      {
        cwd: dir,
        input: '',
        encoding: 'utf8',
        env: spy.env,
      },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('DARK_JUDGE_REMEDY');
    const tail = r.stderr.trimEnd().split('\n').slice(-2).join('\n');
    expect(tail).toContain('Ship dry gates passed');
    expect(tail).toContain("found a dark judge — the real ship's uncached judges will fail closed");
    expect(tail).toContain('DARK_JUDGE_REMEDY');
  });

  it('a reachable judge — credit-backed included — adds nothing to the rehearsal tail', () => {
    const { dir, env } = seedShipRepo();
    writeFileSync(join(dir, 'note.txt'), 'x\n');
    const spy = preflightSpyEnv(dir, env, '');
    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/dry-lit', 't', '--dry-gates', '--', 'note.txt'],
      {
        cwd: dir,
        input: '',
        encoding: 'utf8',
        env: spy.env,
      },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(spy.calls()).toHaveLength(1);
    expect(r.stderr).not.toContain('dark judge');
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

  // Wiring, not units: the preflight's remedy must survive from ship_judge_preflight to the commit tail.
  it('a deterministic block ends with the dark-judge family move the preflight printed', () => {
    const { dir, env } = seedShipRepo({
      hookBody: `echo '✗ deterministic gates failed: guard-fanout' >&2\nexit 1`,
    });
    writeFileSync(join(dir, 'note.txt'), 'blocked\n');
    const spy = preflightSpyEnv(dir, env, 'DARK_JUDGE_REMEDY');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/dark-judge', 't', '--dry-gates', '--with-reviewers', '--', 'note.txt'],
      { cwd: dir, input: '', encoding: 'utf8', env: spy.env },
    );

    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('DARK_JUDGE_REMEDY');
    const tail = r.stderr.trimEnd().split('\n').slice(-10).join('\n');
    expect(tail).toContain('found a dark judge');
    expect(tail).toContain('DARK_JUDGE_REMEDY');
  });

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
