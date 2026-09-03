import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { recordShip } from '../lib/ship/reconcile-manifest-write.mts';
import { relIntentPath } from '../lib/ship/ship-intent.mts';
import {
  assertInterruptedGateKeepsWorktree,
  testExecFileSync as execFileSync,
  processAlive,
  testSpawnSync as spawnSync,
} from './_helpers.mts';
import { bodyUpdateRepo } from './_ship-branch-fixture.mts';

// `devkit ship --pr <branch>` (re-push): adds the current changes to an EXISTING PR's branch as a
// new commit on top of origin/<branch> (copy-not-patch), fast-forward push (never --force). Hermetic
// — bare local origin, no gh/network; the headline assert is that the new commit sits on the fetched
// PR-branch tip with the current file content.

const scriptPath = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
const shipIntentPath = fileURLToPath(new URL('../lib/ship/ship-intent.mts', import.meta.url));
const GENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const BR_RE = /BR=(.*)/;
const REPO_RE = /REPO=(.*)/;
const WT_RE = /worktree kept at (.+?)\. Remove/;
const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function run(args, dir, env = {}, opts = {}) {
  return spawnSync('/bin/bash', [scriptPath, ...args], {
    cwd: dir,
    input: 'body\n',
    encoding: 'utf8',
    env: { ...process.env, ...GENV, ...env },
    ...opts,
  });
}

function runAsync(args, dir, env = {}) {
  const child = spawn('/bin/bash', [scriptPath, ...args], {
    cwd: dir,
    env: { ...process.env, ...GENV, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, completed };
}

describe('reship — interrupted gate handoff', () => {
  it('keeps the worktree alive until an interrupted gate is fully reaped', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'reship-signal-bare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const { dir } = repo(bare);
    const env = { ...process.env, ...GENV };
    const git = (args) =>
      execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' }).trim();
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    git(['config', 'core.hooksPath', '.husky/_']);
    git(['push', '-q', 'origin', 'HEAD:pr-open']);
    writeFileSync(join(dir, 'note.txt'), 'hi\n');

    await assertInterruptedGateKeepsWorktree({
      dir,
      env,
      script: scriptPath,
      args: ['pr-open', 't', '--pr', '--', 'note.txt'],
      listWorktrees: () => git(['worktree', 'list']),
    });
  });
});

/** A repo with `origin` set (GitHub-shaped by default) on branch `work`. */
function repo(origin = 'git@github.com:acme/app.git') {
  const dir = mkdtempSync(join(tmpdir(), 'reship-'));
  dirs.push(dir);
  const g = (a) =>
    execFileSync('git', ['-C', dir, ...a], { env: { ...process.env, ...GENV }, stdio: 'ignore' });
  g(['init', '-q', '-b', 'work']);
  g(['config', 'user.email', 'a@b.c']);
  g(['config', 'user.name', 'a']);
  g(['commit', '-q', '--allow-empty', '-m', 'base']);
  g(['remote', 'add', 'origin', origin]);
  return { dir, g };
}

/** Existing PR off an old base plus a caller snapshot already resolved on today's main. The raw
 * origin stays GitHub-shaped for PR identity checks; url.insteadOf keeps every fetch/push hermetic. */
function rewriteRepo({ extraPath = false, rename = false, objectFormat = 'sha1' } = {}) {
  const bare = mkdtempSync(join(tmpdir(), 'reship-rewrite-bare-'));
  const dir = mkdtempSync(join(tmpdir(), 'reship-rewrite-wt-'));
  const stubBin = mkdtempSync(join(tmpdir(), 'reship-rewrite-bin-'));
  const ghLog = join(stubBin, 'gh.log');
  const ghBody = join(stubBin, 'gh.body');
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).trim();
  dirs.push(bare, dir, stubBin);
  const env = { ...process.env, ...GENV };
  const g = (a, o = {}) =>
    execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o }).trim();
  const objectFormatArgs = objectFormat === 'sha256' ? ['--object-format=sha256'] : [];
  execFileSync('git', ['init', '-q', '--bare', ...objectFormatArgs, bare], { env });
  g(['init', '-q', '-b', 'main', ...objectFormatArgs]);
  g(['config', 'user.email', 'a@b.c']);
  g(['config', 'user.name', 'a']);
  g(['config', 'commit.gpgsign', 'false']);
  g(['remote', 'add', 'origin', 'git@github.com:acme/app.git']);
  g(['config', `url.${bare}.insteadOf`, 'git@github.com:acme/app.git']);
  mkdirSync(join(dir, '.husky/_'), { recursive: true });
  writeFileSync(join(dir, '.husky/.keep'), '');
  writeFileSync(join(dir, '.gitignore'), '.devkit/\n');
  writeFileSync(join(dir, 'conflict.txt'), 'base\n');
  if (rename) writeFileSync(join(dir, 'old.txt'), 'old\n');
  g(['add', '.gitignore', '.husky/.keep', 'conflict.txt', ...(rename ? ['old.txt'] : [])]);
  g(['commit', '-q', '-m', 'base']);
  g(['push', '-q', 'origin', 'main']);

  g(['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(dir, 'conflict.txt'), 'feature\n');
  if (extraPath) writeFileSync(join(dir, 'extra.txt'), 'feature extra\n');
  if (rename) {
    rmSync(join(dir, 'old.txt'));
    writeFileSync(join(dir, 'new.txt'), 'renamed\n');
  }
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'feature']);
  g(['push', '-q', 'origin', 'HEAD:feat/pr']);
  const oldPrTip = g(['rev-parse', 'HEAD']);

  g(['checkout', '-q', 'main']);
  writeFileSync(join(dir, 'conflict.txt'), 'main\n');
  g(['add', 'conflict.txt']);
  g(['commit', '-q', '-m', 'main moves']);
  g(['push', '-q', 'origin', 'main']);
  const mainTip = g(['rev-parse', 'HEAD']);

  // Equivalent to the completed local rebase in sc-2323: main is the ancestor and the caller has
  // already resolved the conflict. devkit's job is publication, not this history edit.
  g(['checkout', '-q', '-b', 'prepared']);
  writeFileSync(join(dir, 'conflict.txt'), 'main + feature\n');
  if (extraPath) writeFileSync(join(dir, 'extra.txt'), 'feature extra\n');
  if (rename) {
    rmSync(join(dir, 'old.txt'));
    writeFileSync(join(dir, 'new.txt'), 'renamed\n');
  }
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'resolved feature']);
  writeFileSync(join(dir, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
  g(['config', 'core.hooksPath', '.husky/_']);

  writeFileSync(
    join(stubBin, 'gh'),
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$GH_LOG"',
      'if [ "$1" = pr ] && [ "$2" = edit ]; then',
      '  if [ "${GH_EDIT_KILL_PARENT:-0}" -eq 1 ]; then kill -9 "$PPID"; exit 9; fi',
      '  cat > "$GH_BODY"',
      '  if [ -n "${GH_EDIT_PAUSE_MARKER:-}" ]; then',
      '    : > "$GH_EDIT_PAUSE_MARKER"',
      '    while [ ! -e "$GH_EDIT_PAUSE_RELEASE" ]; do sleep 0.02; done',
      '  fi',
      '  if [ -n "${GH_INTENT_LOCK:-}" ]; then',
      '    mkdir -p "$GH_INTENT_LOCK"',
      '    printf \'%s:held\' "$PPID" > "$GH_INTENT_LOCK/holder"',
      '  fi',
      '  exit "${GH_EDIT_STATUS:-0}"',
      'fi',
      'case " $* " in',
      "  *' --json url '*) printf '%s\\n' 'https://github.com/acme/app/pull/7'; exit 0 ;;",
      'esac',
      `printf '7\\tOPEN\\t%s\\t%s\\tacme/app\\tmain\\t${mainTip}\\thttps://github.com/acme/app/pull/7\\n' "\${PR_HEAD_REF_NAME:-feat/pr}" "\${PR_HEAD_OID:-${oldPrTip}}"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(stubBin, 'gh'), 0o755);
  writeFileSync(
    join(stubBin, 'git'),
    [
      '#!/bin/sh',
      'if [ "${KILL_BEFORE_REWRITE_PUSH:-0}" -eq 1 ]; then',
      '  case " $* " in',
      '    *" push --force-with-lease="*)',
      '      ship_pid=$(ps -o ppid= -p "$PPID" | tr -d " ")',
      '      kill -9 "$ship_pid"',
      '      exit 9',
      '      ;;',
      '  esac',
      'fi',
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(stubBin, 'git'), 0o755);
  return {
    bare,
    dir,
    env: { PATH: `${stubBin}:${process.env.PATH}`, GH_LOG: ghLog, GH_BODY: ghBody },
    g,
    mainTip,
    oldPrTip,
    stubBin,
    ghLog,
    ghBody,
  };
}

describe('reship — resolve + arg guards', () => {
  it('resolve seam prints BR + REPO from a GitHub origin (before any fetch)', () => {
    const { dir } = repo('git@github.com-personal:acme/app.git');
    const r = run(['feat/open', 'title', '--pr', '--', 'a.ts'], dir, { SHIP_RESOLVE_ONLY: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(BR_RE.exec(r.stdout)?.[1]).toBe('feat/open');
    expect(REPO_RE.exec(r.stdout)?.[1]).toBe('acme/app');
  });
  // Regression: every other test here spells it `<branch> <title> --pr`, so the form the help text
  // and this script's own header actually DOCUMENT — `ship --pr <branch> "<title>"` — was never
  // exercised. It bound BR="--pr" and TITLE=<branch>, then died at the remote check with
  // `no remote branch origin/--pr to re-push to`, which reads as a branch problem rather than an
  // arg-order one. ship.mts forwards argv verbatim, so the flag arrives wherever the caller put it.
  it('resolve seam accepts the DOCUMENTED leading --pr form (BR is the branch, not the flag)', () => {
    const { dir } = repo();
    const r = run(['--pr', 'feat/open', 'title', '--', 'a.ts'], dir, { SHIP_RESOLVE_ONLY: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(BR_RE.exec(r.stdout)?.[1]).toBe('feat/open');
    expect(r.stderr).not.toMatch(/origin\/--pr/);
  });

  it('leading and trailing --pr resolve identically', () => {
    const { dir } = repo();
    const opts = { SHIP_RESOLVE_ONLY: '1' };
    const leading = run(['--pr', 'feat/open', 'title', '--', 'a.ts'], dir, opts);
    const trailing = run(['feat/open', 'title', '--pr', '--', 'a.ts'], dir, opts);
    expect(leading.status, leading.stderr).toBe(0);
    expect(trailing.status, trailing.stderr).toBe(0);
    expect(leading.stdout).toBe(trailing.stdout);
  });

  // Only the FIRST positional is stripped. A trailing `--pr` is dropped by the parse loop, so a
  // second one must not silently eat the title.
  it('a leading --pr does not consume the title', () => {
    const { dir } = repo();
    const r = run(['--pr', 'feat/open', 'my title', '--', 'a.ts'], dir, { SHIP_RESOLVE_ONLY: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(BR_RE.exec(r.stdout)?.[1]).toBe('feat/open');
  });

  it('rejects no paths', () => {
    const { dir } = repo();
    expect(run(['feat/open', 't', '--pr', '--'], dir).status).not.toBe(0);
  });

  it('rejects a bare --pr with no branch', () => {
    const { dir } = repo();
    expect(run(['--pr'], dir).status).not.toBe(0);
  });
  it('rejects a directory path', () => {
    const { dir } = repo();
    mkdirSync(join(dir, 'sub'));
    const r = run(['feat/open', 't', '--pr', '--', 'sub'], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/directory path not allowed/);
    expect(r.stderr).toMatch(/list its tracked files: git ls-files -- "sub"/);
  });
  it('fails clearly when the PR branch does not exist on the remote', () => {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const { dir } = repo(bare); // bare origin, no feat/open branch on it
    writeFileSync(join(dir, 'a.ts'), 'x\n');
    const r = run(['feat/open', 't', '--pr', '--', 'a.ts'], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no remote branch origin\/feat\/open/);
  });
});

describe('reship — re-push commits onto the PR-branch tip', () => {
  it('dry-run stacks the current content as a new commit on origin/<branch>', () => {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky'), { recursive: true });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'work'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', bare],
    ])
      g(a, { stdio: 'ignore' });
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    writeFileSync(join(dir, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
    // First ship: push a.ts=v1 to origin/feat/pr.
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    const prTip = g(['rev-parse', 'origin/feat/pr']).trim();
    // Now the agent edits a.ts in the working tree and re-pushes.
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, { SHIP_DRY_RUN: '1' });
    const wt = WT_RE.exec(r.stderr)?.[1];
    expect(r.status, r.stderr).toBe(0);
    expect(wt, 'dry-run should keep + name the worktree').toBeTruthy();

    const gwt = (a) => execFileSync('git', ['-C', wt, ...a], { env, encoding: 'utf8' }).trim();
    expect(gwt(['show', 'HEAD:a.ts'])).toBe('v2'); // the new commit carries the current content
    expect(gwt(['rev-parse', 'HEAD~1'])).toBe(prTip); // parented on the PR-branch tip (a real ff)
    g(['worktree', 'remove', '--force', wt], { stdio: 'ignore' });

    // --body-file: same grammar as new-ship — the file wins over stdin, and pairing it with --body
    // refuses instead of silently preferring one.
    writeFileSync(join(dir, 'a.ts'), 'v3\n');
    writeFileSync(join(dir, 'body.md'), 'authored once\n');
    const rf = run(['feat/pr', 'add v3', '--pr', '--body-file', 'body.md', '--', 'a.ts'], dir, {
      SHIP_DRY_RUN: '1',
    });
    expect(rf.status, rf.stderr).toBe(0);
    const wt2 = WT_RE.exec(rf.stderr)?.[1];
    expect(
      execFileSync('git', ['-C', wt2, 'log', '-1', '--format=%b'], {
        env,
        encoding: 'utf8',
      }).trim(),
    ).toBe('authored once');
    g(['worktree', 'remove', '--force', wt2], { stdio: 'ignore' });

    const both = run(
      ['feat/pr', 'x', '--pr', '--body', 'a', '--body-file', 'body.md', '--', 'a.ts'],
      dir,
      { SHIP_DRY_RUN: '1' },
    );
    expect(both.status).not.toBe(0);
    expect(both.stderr).toContain('mutually exclusive');
  });
});

describe('reship — explicit bodies refresh the existing PR (sc-2414)', () => {
  it('updates the resolved PR with the exact --body-file bytes after the real push', () => {
    const { dir, env, ghLog, ghBody } = bodyUpdateRepo();
    const body = 'final red/green proof\n\ntrailing newline preserved\n';
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    writeFileSync(join(dir, 'body.md'), body);

    const r = run(
      ['feat/pr', 'add v2', '--pr', '--body-file', 'body.md', '--no-qavis-publish', '--', 'a.ts'],
      dir,
      env,
    );

    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(ghBody), 'gh pr edit should receive a body').toBe(true);
    expect(readFileSync(ghBody, 'utf8')).toBe(body);
    expect(readFileSync(ghLog, 'utf8')).toContain(
      'pr edit https://github.com/acme/app/pull/7 --repo acme/app --body-file -',
    );
  });

  it('an explicit empty --body clears the PR description', () => {
    const { dir, env, ghBody } = bodyUpdateRepo();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = run(
      ['feat/pr', 'add v2', '--pr', '--body', '', '--no-qavis-publish', '--', 'a.ts'],
      dir,
      env,
    );

    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(ghBody), 'an explicit empty body is still an update').toBe(true);
    expect(readFileSync(ghBody)).toHaveLength(0);
  });

  it('preserves the PR description when neither body flag is supplied, including piped commit text', () => {
    const { dir, env, ghLog, ghBody } = bodyUpdateRepo();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = run(['feat/pr', 'add v2', '--pr', '--no-qavis-publish', '--', 'a.ts'], dir, env, {
      input: 'legacy piped commit body\n',
    });

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(ghLog, 'utf8')).not.toContain('pr edit');
    expect(existsSync(ghBody)).toBe(false);
  });

  it('keeps SHIP_DRY_RUN side-effect free when an explicit body has no commit delta', () => {
    const { dir, env, ghLog, ghBody } = bodyUpdateRepo();

    const r = run(
      ['feat/pr', 'preview only', '--pr', '--body', 'must not publish', '--', 'a.ts'],
      dir,
      { ...env, SHIP_DRY_RUN: '1' },
    );

    expect(r.status).not.toBe(0);
    expect(existsSync(ghBody)).toBe(false);
    expect(existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '').not.toContain('pr edit');
  });

  it('refuses explicit PR-body publication before gates when intent cannot be recorded', () => {
    const { bare, dir, env, g, ghLog, ghBody } = bodyUpdateRepo({
      hookBody: ': > "$UNRECORDED_GATE_MARKER"\nexit 0',
    });
    const before = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    const gateMarker = join(dir, 'unrecorded-gate-ran');
    writeFileSync(join(dir, '.gitignore'), ''); // force the best-effort intent writer to decline
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = run(
      ['feat/pr', 'unrecorded body', '--pr', '--body', 'must not publish', '--', 'a.ts'],
      dir,
      { ...env, UNRECORDED_GATE_MARKER: gateMarker },
    );

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('requires a recorded invocation');
    expect(r.stderr).toContain('devkit doctor --fix');
    expect(r.stderr).toContain('no gates, push, or PR edit attempted');
    expect(existsSync(gateMarker)).toBe(false);
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).toBe(before);
    expect(existsSync(ghBody)).toBe(false);
    expect(existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '').not.toContain('pr edit');
  });

  it('refuses an older publisher superseded while its gates were running', async () => {
    const hookBody = [
      'if [ -n "${GATE_PAUSE_MARKER:-}" ]; then',
      '  : > "$GATE_PAUSE_MARKER"',
      '  while [ ! -e "$GATE_PAUSE_RELEASE" ]; do sleep 0.02; done',
      'fi',
      'exit 0',
    ].join('\n');
    const { bare, dir, env, g, ghBody } = bodyUpdateRepo({ hookBody });
    const before = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    const oldPaused = join(dir, 'old-gates-paused');
    const oldRelease = join(dir, 'old-gates-release');
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const oldRun = runAsync(
      [
        'feat/pr',
        'old publication',
        '--pr',
        '--body',
        'old body',
        '--no-qavis-publish',
        '--',
        'a.ts',
      ],
      dir,
      { ...env, GATE_PAUSE_MARKER: oldPaused, GATE_PAUSE_RELEASE: oldRelease },
    );
    // A busy machine can take far longer than 5s to reach the hook, and the old deadline branch
    // released the publisher BEFORE the superseding write below — so the run under test finished
    // unsuperseded and `not.toBe(0)` failed on a scheduling artifact rather than a real defect.
    const oldDeadline = Date.now() + 60000;
    while (!existsSync(oldPaused) && oldRun.child.exitCode === null && Date.now() < oldDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (!existsSync(oldPaused)) {
      writeFileSync(oldRelease, 'deadline elapsed\n');
      const early = await oldRun.completed;
      expect.fail(`old publisher never parked in its gates: ${early.stderr}`);
    }
    // Parked, not finished: a publisher that already exited cannot observe the supersession, and
    // asserting against it below would report a refusal failure that never had a window to occur.
    expect(oldRun.child.exitCode, 'old publisher exited before it could be superseded').toBeNull();

    const superseding = spawnSync(
      'node',
      [
        shipIntentPath,
        'write',
        '--root',
        dir,
        '--branch',
        'feat/pr',
        '--mode',
        'reship',
        '--title',
        'new publication',
        '--update-pr-body',
        '--',
        'a.ts',
      ],
      { env: { ...process.env, ...GENV }, input: 'new body', encoding: 'utf8' },
    );
    writeFileSync(oldRelease, 'go\n');
    const oldResult = await oldRun.completed;
    expect(superseding.status, superseding.stderr).toBe(0);
    expect(oldResult.status).not.toBe(0);
    expect(oldResult.stderr).toContain('intent was superseded while gates ran; nothing pushed');
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).toBe(before);
    expect(existsSync(ghBody)).toBe(false);
  });

  it('replays the body-update intent after a blocked attempt resumes', () => {
    const { dir, env, ghBody } = bodyUpdateRepo({ hookBody: 'exit 1' });
    const body = 'recorded final proof\n';
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    writeFileSync(join(dir, 'body.md'), body);
    const blocked = run(
      ['feat/pr', 'add v2', '--pr', '--body-file', 'body.md', '--no-qavis-publish', '--', 'a.ts'],
      dir,
      env,
    );
    expect(blocked.status).not.toBe(0);
    expect(existsSync(ghBody)).toBe(false);

    writeFileSync(join(dir, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
    const resumed = run(['--resume', 'feat/pr'], dir, env, { input: '' });

    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readFileSync(ghBody, 'utf8')).toBe(body);
  });

  it('finishes the recorded body update when a lost push response resumes with no commit delta', () => {
    const { bare, dir, env, g, ghBody } = bodyUpdateRepo();
    const before = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    const body = 'publish this after recovery\n';
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const lostResponse = run(
      ['feat/pr', 'add v2', '--pr', '--body', body, '--no-qavis-publish', '--', 'a.ts'],
      dir,
      { ...env, FAIL_AFTER_PUSH: '1' },
    );
    const accepted = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    expect(lostResponse.status).not.toBe(0);
    expect(accepted).not.toBe(before);
    expect(existsSync(ghBody)).toBe(false);

    const resumed = run(['--resume', 'feat/pr'], dir, env, { input: '' });

    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readFileSync(ghBody, 'utf8')).toBe(body);
  });

  it('keeps the body intent when the publisher dies between push and PR edit', () => {
    const { bare, dir, env, g, ghBody } = bodyUpdateRepo();
    const before = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    const body = 'survive the metadata crash\n';
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const interrupted = run(
      ['feat/pr', 'add v2', '--pr', '--body', body, '--no-qavis-publish', '--', 'a.ts'],
      dir,
      { ...env, GH_EDIT_KILL_PARENT: '1' },
    );
    const accepted = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    expect(interrupted.status).not.toBe(0);
    expect(accepted).not.toBe(before);
    expect(existsSync(ghBody)).toBe(false);

    const preview = run(['--resume', 'feat/pr'], dir, { ...env, SHIP_DRY_RUN: '1' }, { input: '' });
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stderr).toContain('kept its intent for a real run');
    expect(existsSync(ghBody)).toBe(false);

    const resumed = run(['--resume', 'feat/pr'], dir, env, { input: '' });

    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readFileSync(ghBody, 'utf8')).toBe(body);
  });

  it('reports a manual-only partial success when PR editing fails after the push', () => {
    const { bare, dir, env, g, ghBody } = bodyUpdateRepo();
    const before = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = run(
      ['feat/pr', 'add v2', '--pr', '--body', 'new proof', '--no-qavis-publish', '--', 'a.ts'],
      dir,
      { ...env, GH_EDIT_STATUS: '9' },
    );
    const after = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);

    expect(r.status).not.toBe(0);
    expect(after).not.toBe(before); // the push already landed and is never misreported as rolled back
    expect(readFileSync(ghBody, 'utf8')).toBe('new proof');
    expect(r.stderr).toContain('PR body was not updated');
    expect(r.stderr).toContain('the commit is already on origin/feat/pr');
    expect(r.stderr).not.toContain('devkit ship --resume');
  });

  it('does not report success when the published body intent cannot be retired', () => {
    const { dir, env, ghBody } = bodyUpdateRepo();
    const intentLock = join(dir, `${relIntentPath('feat/pr')}.lock`);
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = run(
      [
        'feat/pr',
        'add v2',
        '--pr',
        '--body',
        'published proof',
        '--no-qavis-publish',
        '--',
        'a.ts',
      ],
      dir,
      { ...env, GH_INTENT_LOCK: intentLock },
    );

    expect(r.status).not.toBe(0);
    expect(readFileSync(ghBody, 'utf8')).toBe('published proof');
    expect(r.stderr).toContain('spent intent stayed locked');
    expect(r.stderr).toContain('do NOT resume it');
  });

  it('does not report success when the pushed body update cannot resolve its PR target', () => {
    const { bare, dir, env, g } = bodyUpdateRepo();
    const before = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = run(
      ['feat/pr', 'add v2', '--pr', '--body', 'new proof', '--no-qavis-publish', '--', 'a.ts'],
      dir,
      { ...env, GH_VIEW_STATUS: '7' },
    );
    const after = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);

    expect(r.status).not.toBe(0);
    expect(after).not.toBe(before);
    expect(r.stderr).toContain('PR body was not updated');
    expect(r.stderr).toContain('could not resolve the open PR');
  });
});

// `--ready` closes the open-draft → iterate → mark-ready loop without leaving devkit. It runs LAST,
// after the push and the reconcile record are durable, so a gh failure can never cost landed work.
describe('reship — --ready marks the PR ready for review', () => {
  it('re-pushes and calls gh pr ready with the resolved PR number', () => {
    const { bare, dir, env, g, ghLog } = bodyUpdateRepo();
    const before = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = run(
      ['feat/pr', 'add v2', '--pr', '--ready', '--no-qavis-publish', '--', 'a.ts'],
      dir,
      env,
    );

    expect(r.status, r.stderr).toBe(0);
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).not.toBe(before); // push landed
    // Resolved from the PR URL gh view returned, not the branch name.
    expect(readFileSync(ghLog, 'utf8')).toMatch(/^pr ready 7 --repo acme\/app$/m);
    expect(r.stdout).toContain('https://github.com/acme/app/pull/7');
  });

  // Without --ready nothing may touch the PR's draft state.
  it('does not call gh pr ready when the flag is absent', () => {
    const { dir, env, ghLog } = bodyUpdateRepo();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = run(['feat/pr', 'add v2', '--pr', '--no-qavis-publish', '--', 'a.ts'], dir, env);

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(ghLog, 'utf8')).not.toContain('pr ready');
  });

  // The commit is already remote when the flip runs. A failure must be LOUD and non-zero (the
  // requested state change did not happen) yet must never be reported as a lost push.
  it('surfaces a failed flip with a copy-pasteable remedy, without unwinding the push', () => {
    const { bare, dir, env, g } = bodyUpdateRepo();
    const before = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = run(
      ['feat/pr', 'add v2', '--pr', '--ready', '--no-qavis-publish', '--', 'a.ts'],
      dir,
      {
        ...env,
        GH_READY_STATUS: '3',
      },
    );

    expect(r.status).not.toBe(0);
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).not.toBe(before); // push KEPT
    expect(r.stderr).toContain('marking the PR ready FAILED');
    expect(r.stderr).toContain('the commit IS on origin/feat/pr');
    expect(r.stderr).toMatch(/gh pr ready '7' --repo 'acme\/app'/);
    expect(r.stdout).toContain('https://github.com/acme/app/pull/7'); // the PR URL is still the truth
  });

  // No resolvable PR means --ready had nothing to act on. Reporting plain success there would claim
  // a state change that never happened.
  it('refuses to report success when --ready cannot resolve the PR', () => {
    const { dir, env } = bodyUpdateRepo();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = run(
      ['feat/pr', 'add v2', '--pr', '--ready', '--no-qavis-publish', '--', 'a.ts'],
      dir,
      {
        ...env,
        GH_VIEW_STATUS: '7', // gh pr view fails → no PR_URL
      },
    );

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--ready could not resolve the PR');
    expect(r.stderr).toMatch(/gh pr ready 'feat\/pr'/);
  });

  it('still marks the PR ready on a body-only run that exits before the normal tail', () => {
    const { dir, env, ghLog, ghBody } = bodyUpdateRepo();
    // a.ts is left byte-identical to origin/feat/pr → no delta, so only the body can change.
    const r = run(
      [
        'feat/pr',
        'same content',
        '--pr',
        '--body',
        'fresh body',
        '--ready',
        '--no-qavis-publish',
        '--',
        'a.ts',
      ],
      dir,
      env,
    );

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(ghBody, 'utf8')).toBe('fresh body'); // the body-only path did run
    expect(readFileSync(ghLog, 'utf8')).toMatch(/^pr ready 7 --repo acme\/app$/m);
  });

  it('converges when the same --ready command is re-run after a transient flip failure', () => {
    const { bare, dir, env, g, ghLog } = bodyUpdateRepo();
    const before = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    const argv = ['feat/pr', 'add v2', '--pr', '--ready', '--no-qavis-publish', '--', 'a.ts'];

    const first = run(argv, dir, { ...env, GH_READY_STATUS: '3' }); // push lands, flip fails
    expect(first.status).not.toBe(0);
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).not.toBe(before);

    const retry = run(argv, dir, env); // same command; now there is no delta left to push
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).toContain('marked the PR ready');
    expect(readFileSync(ghLog, 'utf8')).toMatch(/^pr ready 7 --repo acme\/app$/m);
  });

  it('rejects --draft, naming gh pr ready --undo', () => {
    const { dir } = repo();
    const r = run(['feat/open', 't', '--pr', '--draft', '--', 'a.ts'], dir, {
      SHIP_RESOLVE_ONLY: '1',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--draft applies to a NEW ship');
    expect(r.stderr).toContain('gh pr ready --undo feat/open');
    expect(r.stderr).not.toContain('unknown flag');
  });
});

describe('reship --base — replace a conflicted PR from a caller-prepared snapshot (sc-2323)', () => {
  it('gates one replacement commit on the current PR base instead of appending resolved bytes to stale ancestry', () => {
    const { bare, dir, env, g, mainTip } = rewriteRepo();
    mkdirSync(join(dir, '.devkit'), { recursive: true });
    writeFileSync(
      join(dir, '.devkit/reconcile-manifest.json'),
      `${JSON.stringify({
        version: 1,
        branches: {
          'feat/pr': {
            prNumber: 7,
            repo: 'acme/app',
            baseRef: 'old-base',
            baseSha: '0'.repeat(40),
            shippedAt: '2020-01-01T00:00:00.000Z',
            paths: [
              { path: 'conflict.txt', blobSha: '1'.repeat(40), mode: '100644', op: 'modify' },
              { path: 'stale.txt', blobSha: '2'.repeat(40), mode: '100644', op: 'modify' },
            ],
          },
        },
      })}\n`,
    );
    const r = run(
      ['feat/pr', 'publish resolved PR', '--pr', '--base', 'main', '--', 'conflict.txt'],
      dir,
      env,
    );
    expect(r.status, r.stderr).toBe(0);
    const replacement = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    expect(g(['--git-dir', bare, 'rev-parse', `${replacement}^`])).toBe(mainTip);
    expect(g(['--git-dir', bare, 'show', `${replacement}:conflict.txt`])).toBe('main + feature');
    // Main is the replacement commit's ancestor, so Git has no conflict left to resolve.
    expect(g(['--git-dir', bare, 'merge-base', '--is-ancestor', mainTip, replacement])).toBe('');
    expect(g(['for-each-ref', '--format=%(refname)', 'refs/devkit/reship-rewrite'])).toBe('');
    const manifest = JSON.parse(readFileSync(join(dir, '.devkit/reconcile-manifest.json'), 'utf8'));
    expect(manifest.branches['feat/pr']).toMatchObject({
      prNumber: 7,
      repo: 'acme/app',
      baseRef: 'main',
      baseSha: mainTip,
    });
    expect(manifest.branches['feat/pr'].paths).toHaveLength(1);
    expect(manifest.branches['feat/pr'].paths[0]).toMatchObject({ path: 'conflict.txt' });
  });

  it('resumes a retained body update when a rewrite publisher dies after reconcile', () => {
    const { bare, dir, env, g, oldPrTip, ghBody } = rewriteRepo();
    const body = 'rewrite proof survives publication death\n';
    const gateRanOnResume = join(dir, 'gate-ran-on-resume');
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      [
        '#!/bin/sh',
        'if [ -n "${GATE_RESUME_MARKER:-}" ]; then : > "$GATE_RESUME_MARKER"; exit 97; fi',
        "printf 'gate-owned\\n' > gate-baseline.txt",
        'git add gate-baseline.txt',
        '',
      ].join('\n'),
    );

    const interrupted = run(
      [
        'feat/pr',
        'publish resolved PR',
        '--pr',
        '--base',
        'main',
        '--body',
        body,
        '--no-qavis-publish',
        '--',
        'conflict.txt',
      ],
      dir,
      { ...env, GH_EDIT_KILL_PARENT: '1' },
    );
    const accepted = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    expect(interrupted.status).not.toBe(0);
    expect(accepted).not.toBe(oldPrTip);
    expect(existsSync(ghBody)).toBe(false);

    const manifestBeforePreview = readFileSync(
      join(dir, '.devkit/reconcile-manifest.json'),
      'utf8',
    );
    const preview = run(
      ['--resume', 'feat/pr'],
      dir,
      { ...env, PR_HEAD_OID: accepted, SHIP_DRY_RUN: '1', GATE_RESUME_MARKER: gateRanOnResume },
      { input: '' },
    );
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stderr).toContain('skipped reconcile + the recorded PR-body update');
    expect(existsSync(ghBody)).toBe(false);
    expect(readFileSync(join(dir, '.devkit/reconcile-manifest.json'), 'utf8')).toBe(
      manifestBeforePreview,
    );
    expect(existsSync(gateRanOnResume), 'dry recovery must not rerun gates').toBe(false);

    const manifestLock = join(dir, '.devkit/reconcile-manifest.json.lock');
    mkdirSync(manifestLock, { recursive: true });
    writeFileSync(join(manifestLock, 'holder'), `${process.pid}:test-holder`);
    const reconcileBlocked = run(
      ['--resume', 'feat/pr'],
      dir,
      { ...env, PR_HEAD_OID: accepted, GATE_RESUME_MARKER: gateRanOnResume },
      { input: '' },
    );
    expect(reconcileBlocked.status).not.toBe(0);
    expect(reconcileBlocked.stderr).toContain('kept the exact gated receipt and intent');
    expect(existsSync(gateRanOnResume), 'blocked recovery must not rerun gates').toBe(false);
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).toBe(accepted);
    rmSync(manifestLock, { recursive: true, force: true });

    writeFileSync(join(dir, 'conflict.txt'), 'changed after publication\n');
    const drifted = run(
      ['--resume', 'feat/pr'],
      dir,
      { ...env, PR_HEAD_OID: accepted, GATE_RESUME_MARKER: gateRanOnResume },
      { input: '' },
    );
    expect(drifted.status).not.toBe(0);
    expect(drifted.stderr).toContain('rewrite brief omits paths from the existing PR');
    expect(existsSync(gateRanOnResume), 'drifted recovery must refuse before gates').toBe(false);
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).toBe(accepted);
    writeFileSync(join(dir, 'conflict.txt'), 'main + feature\n');

    const resumed = run(
      ['--resume', 'feat/pr'],
      dir,
      { ...env, PR_HEAD_OID: accepted, GATE_RESUME_MARKER: gateRanOnResume },
      { input: '' },
    );

    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readFileSync(ghBody, 'utf8')).toBe(body);
    expect(existsSync(gateRanOnResume), 'resume must reuse the gated receipt').toBe(false);
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).toBe(accepted);
  });

  it.each(['sha1', 'sha256'])(
    'prunes unpublished rewrite proof in %s repositories when a pre-push crash resumes',
    (objectFormat) => {
      const { bare, dir, env, g, oldPrTip } = rewriteRepo({ objectFormat });
      const interrupted = run(
        [
          'feat/pr',
          'publication',
          '--pr',
          '--base',
          'main',
          '--body',
          'proof body',
          '--no-qavis-publish',
          '--',
          'conflict.txt',
        ],
        dir,
        { ...env, KILL_BEFORE_REWRITE_PUSH: '1' },
      );
      expect(interrupted.status).not.toBe(0);
      expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).toBe(oldPrTip);
      const proofRefs = () =>
        g([
          'for-each-ref',
          '--format=%(refname)',
          'refs/devkit/reship-body-receipts/feat/pr/',
          'refs/devkit/reship-body-payloads/feat/pr/',
        ]);
      expect(proofRefs()).not.toBe('');

      writeFileSync(join(dir, '.husky/_/pre-commit'), '#!/bin/sh\nexit 1\n');
      chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
      const resumed = run(['--resume', 'feat/pr'], dir, env, { input: '' });

      expect(resumed.status).not.toBe(0);
      expect(proofRefs()).toBe('');
      expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).toBe(oldPrTip);
    },
  );

  it('does not reuse a receipt for a byte-different body with the same Git message', () => {
    const { bare, dir, env, g, ghBody } = rewriteRepo();
    const interrupted = run(
      [
        'feat/pr',
        'publication',
        '--pr',
        '--base',
        'main',
        '--body',
        'line\nnext',
        '--no-qavis-publish',
        '--',
        'conflict.txt',
      ],
      dir,
      { ...env, GH_EDIT_KILL_PARENT: '1' },
    );
    const accepted = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    expect(interrupted.status).not.toBe(0);
    expect(
      g([
        'for-each-ref',
        '--format=%(refname)',
        `refs/devkit/reship-body-receipts/feat/pr/${accepted}`,
      ]),
    ).toBe(`refs/devkit/reship-body-receipts/feat/pr/${accepted}`);
    expect(
      g([
        'for-each-ref',
        '--format=%(refname)',
        `refs/devkit/reship-body-payloads/feat/pr/${accepted}`,
      ]),
    ).toBe(`refs/devkit/reship-body-payloads/feat/pr/${accepted}`);

    const gateLog = join(dir, 'superseding-gate.log');
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      `#!/bin/sh\nprintf 'ran\\n' >> '${gateLog}'\nexit 1\n`,
    );
    const fresh = run(
      [
        'feat/pr',
        'publication',
        '--pr',
        '--base',
        'main',
        '--body',
        'line  \nnext',
        '--no-qavis-publish',
        '--',
        'conflict.txt',
      ],
      dir,
      { ...env, PR_HEAD_OID: accepted },
    );
    expect(fresh.status).not.toBe(0);
    expect(existsSync(gateLog), fresh.stderr).toBe(true);

    const resumed = run(
      ['--resume', 'feat/pr'],
      dir,
      { ...env, PR_HEAD_OID: accepted },
      { input: '' },
    );
    expect(resumed.status).not.toBe(0);
    expect(readFileSync(gateLog, 'utf8')).toBe('ran\nran\n');
    expect(existsSync(ghBody)).toBe(false);
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).toBe(accepted);
    expect(
      g([
        'for-each-ref',
        '--format=%(refname)',
        `refs/devkit/reship-body-receipts/feat/pr/${accepted}`,
      ]),
    ).toBe(`refs/devkit/reship-body-receipts/feat/pr/${accepted}`);
  });

  it('does not share a gated receipt with a sibling PR at the same commit', () => {
    const { bare, dir, env, g, ghBody } = rewriteRepo();
    const interrupted = run(
      [
        'feat/pr',
        'publication',
        '--pr',
        '--base',
        'main',
        '--body',
        'same body',
        '--no-qavis-publish',
        '--',
        'conflict.txt',
      ],
      dir,
      { ...env, GH_EDIT_KILL_PARENT: '1' },
    );
    const accepted = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    expect(interrupted.status).not.toBe(0);
    g(['push', '-q', 'origin', `${accepted}:refs/heads/feat/other`]);

    const gateLog = join(dir, 'sibling-branch-gate.log');
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      `#!/bin/sh\nprintf 'other-ran\\n' >> '${gateLog}'\nexit 1\n`,
    );
    const otherEnv = { ...env, PR_HEAD_REF_NAME: 'feat/other', PR_HEAD_OID: accepted };
    const fresh = run(
      [
        'feat/other',
        'publication',
        '--pr',
        '--base',
        'main',
        '--body',
        'same body',
        '--no-qavis-publish',
        '--',
        'conflict.txt',
      ],
      dir,
      otherEnv,
    );
    expect(fresh.status).not.toBe(0);
    const resumed = run(['--resume', 'feat/other'], dir, otherEnv, { input: '' });
    expect(resumed.status).not.toBe(0);
    expect(readFileSync(gateLog, 'utf8')).toBe('other-ran\nother-ran\n');
    expect(existsSync(ghBody)).toBe(false);
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/other'])).toBe(accepted);
    expect(
      g([
        'for-each-ref',
        '--format=%(refname)',
        `refs/devkit/reship-body-receipts/feat/other/${accepted}`,
      ]),
    ).toBe('');
  });

  it('serializes recovery publication against a fresh intent that starts concurrently', async () => {
    const { bare, dir, env, g, ghBody } = rewriteRepo();
    const interrupted = run(
      [
        'feat/pr',
        'old publication',
        '--pr',
        '--base',
        'main',
        '--body',
        'old body',
        '--no-qavis-publish',
        '--',
        'conflict.txt',
      ],
      dir,
      { ...env, GH_EDIT_KILL_PARENT: '1' },
    );
    const accepted = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    expect(interrupted.status).not.toBe(0);

    const paused = join(dir, 'recovery-paused');
    const release = join(dir, 'recovery-release');

    const gateLog = join(dir, 'concurrent-fresh-gate.log');
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      `#!/bin/sh\nprintf 'fresh-ran\\n' >> '${gateLog}'\nexit 1\n`,
    );
    const recovery = runAsync(['--resume', 'feat/pr'], dir, {
      ...env,
      PR_HEAD_OID: accepted,
      GH_EDIT_PAUSE_MARKER: paused,
      GH_EDIT_PAUSE_RELEASE: release,
    });
    const pauseDeadline = Date.now() + 5000;
    while (!existsSync(paused) && recovery.child.exitCode === null && Date.now() < pauseDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (!existsSync(paused)) {
      // Never leave a late-arriving gh edit parked after this diagnostic path has decided to fail.
      // The release is harmless before the marker and guarantees the child can report its stderr.
      writeFileSync(release, 'deadline elapsed\n');
      const early = await recovery.completed;
      expect(existsSync(paused), early.stderr).toBe(true);
    }

    const fresh = runAsync(
      [
        'feat/pr',
        'new publication',
        '--pr',
        '--base',
        'main',
        '--body',
        'new body',
        '--no-qavis-publish',
        '--',
        'conflict.txt',
      ],
      dir,
      { ...env, PR_HEAD_OID: accepted },
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const gateRanBeforeRelease = existsSync(gateLog);
    const freshExitedBeforeRelease = fresh.child.exitCode !== null;
    writeFileSync(release, 'go\n');
    const recovered = await recovery.completed;
    const superseding = await fresh.completed;
    expect(gateRanBeforeRelease, 'fresh invocation must wait before replacing the intent').toBe(
      false,
    );
    expect(freshExitedBeforeRelease, superseding.stderr).toBe(false);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(readFileSync(ghBody, 'utf8')).toBe('old body');
    expect(superseding.status).not.toBe(0);
    expect(readFileSync(gateLog, 'utf8')).toBe('fresh-ran\n');
    expect(g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'])).toBe(accepted);
  });

  it('refuses before gates when the brief omits any path changed by the old PR', () => {
    const { dir, env } = rewriteRepo({ extraPath: true });
    const r = run(
      ['feat/pr', 'incomplete rewrite', '--pr', '--base', 'main', '--', './conflict.txt'],
      dir,
      { ...env, SHIP_DRY_RUN: '1' },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('rewrite brief omits paths from the existing PR');
    expect(r.stderr).toContain('extra.txt');
    expect(r.stderr).not.toMatch(/\n  conflict\.txt/);
    expect(r.stderr).not.toContain('GATE_RAN');
  });

  it('requires both halves of an old-PR rename', () => {
    const { dir, env } = rewriteRepo({ rename: true });
    const r = run(
      ['feat/pr', 'incomplete rename', '--pr', '--base', 'main', '--', 'conflict.txt', 'new.txt'],
      dir,
      { ...env, SHIP_DRY_RUN: '1' },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('rewrite brief omits paths from the existing PR');
    expect(r.stderr).toContain('old.txt');
  });

  it('does not turn a sparse or unmaterialized caller path into a deletion', () => {
    const { dir, env, g } = rewriteRepo();
    g(['update-index', '--skip-worktree', 'conflict.txt']);
    rmSync(join(dir, 'conflict.txt'));
    const r = run(
      ['feat/pr', 'unsafe sparse rewrite', '--pr', '--base', 'main', '--', 'conflict.txt'],
      dir,
      { ...env, SHIP_DRY_RUN: '1' },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('absent but not deleted (sparse or unmaterialized)');
  });

  it('refuses a dangling symlink that reconcile cannot represent', () => {
    const { dir, env } = rewriteRepo();
    rmSync(join(dir, 'conflict.txt'));
    symlinkSync('missing-target', join(dir, 'conflict.txt'));
    const r = run(
      ['feat/pr', 'unsafe symlink rewrite', '--pr', '--base', 'main', '--', 'conflict.txt'],
      dir,
      { ...env, SHIP_DRY_RUN: '1' },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('dangling symlinks are not representable in reconcile');
  });

  it('uses an exact expected-OID lease and never overwrites a PR head that advances during gates', () => {
    const { bare, dir, env, g, oldPrTip, stubBin } = rewriteRepo();
    const raceCommit = g(['commit-tree', `${oldPrTip}^{tree}`, '-p', oldPrTip], {
      input: 'concurrent update\n',
    });
    g(['push', '-q', 'origin', `${raceCommit}:refs/heads/race`]);
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      `#!/bin/sh\ngit --git-dir='${bare}' update-ref refs/heads/feat/pr '${raceCommit}'\nexit 0\n`,
    );
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
    const r = run(
      ['feat/pr', 'lease race', '--pr', '--base', 'main', '--', 'conflict.txt'],
      dir,
      env,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('expected-OID lease rejected');
    expect(
      execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr'], {
        env: { ...process.env, ...GENV },
        encoding: 'utf8',
      }).trim(),
    ).toBe(raceCommit);
    // The test gh binary remains the only stub involved; push itself was real Git against the bare.
    expect(readFileSync(join(stubBin, 'gh'), 'utf8')).toContain(oldPrTip);
  });
});

// Regression (sc-1183): a briefed path can be TRACKED on the PR branch yet sit under a gitignored
// dir (a tracked dist/ build artifact is the case that bit us). The staging loop's `git add` STAGES
// it but exits nonzero with "The following paths are ignored", and set -euo pipefail aborted the
// whole re-push before gates/commit/push. `git add -f` on the caller-explicit path fixes it — same
// failure mode as husky-block-exec.test.mts's force-added dist/ re-stage.
describe('reship — tracked file under a gitignored directory', () => {
  it('re-ships a tracked-but-gitignored dist/ file without aborting on the ignore diagnostic', () => {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky'), { recursive: true });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'work'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', bare],
    ])
      g(a, { stdio: 'ignore' });
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    writeFileSync(join(dir, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);

    // .gitignore ignores dist/, but dist/out.mjs is FORCE-ADDED so it is tracked on the PR-branch tip
    // — the exact "tracked file beneath an ignored directory" shape from the report.
    writeFileSync(join(dir, '.gitignore'), 'dist/\n');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist/out.mjs'), 'v1\n');
    g(['add', '.gitignore'], { stdio: 'ignore' });
    g(['add', '-f', 'dist/out.mjs'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    const prTip = g(['rev-parse', 'origin/feat/pr']).trim();

    // The agent edits the tracked-but-ignored artifact and re-pushes onto the open PR.
    writeFileSync(join(dir, 'dist/out.mjs'), 'v2\n');

    const r = run(['feat/pr', 'add v2', '--pr', '--', 'dist/out.mjs'], dir, { SHIP_DRY_RUN: '1' });
    const wt = WT_RE.exec(r.stderr)?.[1];
    try {
      expect(r.status, r.stderr).toBe(0); // did NOT abort on the ignore diagnostic
      expect(r.stderr).not.toMatch(/paths are ignored|ignored by/); // -f suppressed git's refusal
      expect(wt, 'dry-run should keep + name the worktree').toBeTruthy();
      const gwt = (a) => execFileSync('git', ['-C', wt, ...a], { env, encoding: 'utf8' }).trim();
      expect(gwt(['show', 'HEAD:dist/out.mjs'])).toBe('v2'); // the new content is committed...
      expect(gwt(['rev-parse', 'HEAD~1'])).toBe(prTip); // ...parented on the PR-branch tip
    } finally {
      if (wt) g(['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
    }
  });
});

describe('reship — merges the re-pushed paths into the branch reconcile entry', () => {
  it('on a real push, extends branches[$BR] with this commit content (tip blob) + new paths', () => {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky'), { recursive: true });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'work'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], // GitHub-shaped so REPO resolves
    ])
      g(a, { stdio: 'ignore' });
    g(['remote', 'set-url', 'origin', bare], { stdio: 'ignore' }); // ...but push/fetch the local bare
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    writeFileSync(join(dir, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);

    // First ship: a.ts=v1 on origin/feat/pr, and seed its manifest entry (what the initial `devkit ship` does).
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    const prTip = g(['rev-parse', 'HEAD']).trim();
    expect(
      recordShip(
        {
          root: dir,
          branch: 'feat/pr',
          repo: 'acme/app',
          baseRef: 'work',
          baseSha: prTip,
          pr: '7',
        },
        ['a.ts'],
      ),
    ).toBe(0);

    // The agent edits a.ts and adds b.ts, then `devkit ship --pr feat/pr`.
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    writeFileSync(join(dir, 'b.ts'), 'B\n');

    // Stub `gh` (clears reship's `command -v gh` check + the final `gh pr view`); keep node on PATH.
    const stubBin = mkdtempSync(join(tmpdir(), 'reship-bin-'));
    dirs.push(stubBin);
    writeFileSync(join(stubBin, 'gh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(stubBin, 'gh'), 0o755);

    const r = run(['feat/pr', 'add v2 + b', '--pr', '--', 'a.ts', 'b.ts'], dir, {
      PATH: `${stubBin}:${process.env.PATH}`,
    });
    expect(r.status, r.stderr).toBe(0);

    const m = JSON.parse(readFileSync(join(dir, '.devkit', 'reconcile-manifest.json'), 'utf8'));
    const e = m.branches['feat/pr'];
    const by = Object.fromEntries(e.paths.map((p) => [p.path, p]));
    expect(e.paths).toHaveLength(2);
    expect(by['a.ts'].blobSha).toBe(g(['hash-object', '--', 'a.ts']).trim()); // the v2 TIP blob, not v1
    expect(by['b.ts']).toMatchObject({ op: 'add' });
    // PR metadata preserved from the seeded (initial-ship) entry.
    expect(e.prNumber).toBe(7);
    expect(e.repo).toBe('acme/app');
    expect(e.baseRef).toBe('work');
  });
});

describe('reship — untracked gate configs are linked into the re-ship worktree', () => {
  it('links an untracked guard.config.json so the gate sees it (not defaults), with a notice', () => {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'work'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', bare],
    ])
      g(a, { stdio: 'ignore' });
    // Hook cwd = the worktree, so it proves the untracked config was linked in.
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      '#!/bin/sh\n[ -e guard.config.json ] && echo CONFIG_SEEN || echo CONFIG_MISSING\nexit 0\n',
    );
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
    // Seed the open PR branch, then edit + re-push with an untracked guard.config.json present.
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    writeFileSync(join(dir, 'guard.config.json'), '{"scanRoots":["src"]}\n'); // untracked

    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, { SHIP_DRY_RUN: '1' });
    const wt = WT_RE.exec(r.stderr)?.[1];
    try {
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/guard\.config\.json .*commit it/);
      expect(readFileSync(join(dir, '.devkit/last-ship-gates-feat-pr.log'), 'utf8')).toMatch(
        /CONFIG_SEEN/,
      );
    } finally {
      if (wt) g(['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
    }
  });
});

// DK-5: reship's worktree is cut from the fetched PR-branch tip — in-chain gates (fallow) need that
// SAME commit to scope their own audit, not their own main-autodetect.
describe('reship — exports DEVKIT_SHIP_BASE_SHA (DK-5)', () => {
  it('is the fetched PR-branch tip, not a stale local ref', () => {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'work'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', bare],
    ])
      g(a, { stdio: 'ignore' });
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      '#!/bin/sh\necho "HOOK_BASE=$DEVKIT_SHIP_BASE_SHA"\necho "HOOK_SRC=$DEVKIT_SHIP_SOURCE_HEAD"\nexit 0\n',
    );
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    const prTip = execFileSync('git', ['-C', bare, 'rev-parse', 'feat/pr'], {
      env,
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, { SHIP_DRY_RUN: '1' });
    const wt = WT_RE.exec(r.stderr)?.[1];
    try {
      expect(r.status, r.stderr).toBe(0);
      const log = readFileSync(join(dir, '.devkit/last-ship-gates-feat-pr.log'), 'utf8');
      expect(log).toContain(`HOOK_BASE=${prTip}`);
      // sc-2480: the caller's own HEAD travels alongside the base, so guard-review can name the
      // paths that moved between them. Here it is the local tip, NOT the fetched PR tip.
      expect(log).toContain(`HOOK_SRC=${g(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}`);
    } finally {
      if (wt) g(['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
    }
  });
});

// A PR branch based on a NON-default branch (frink ships release branches this way: PR base 0.0.9,
// origin/HEAD -> main). reship must cut its worktree from the fetched PR-branch tip; anything that
// reached for origin/HEAD instead would parent the commit on main and lose the base branch's history.
describe('reship — PR branch based on a non-default branch', () => {
  it('parents the new commit on the PR-branch tip, not on origin/HEAD (main)', () => {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', bare],
      ['push', '-q', 'origin', 'main'],
    ])
      g(a, { stdio: 'ignore' });
    writeFileSync(join(dir, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
    // origin/HEAD -> main, so a wrong implementation has something plausible to grab.
    g(['remote', 'set-head', 'origin', 'main'], { stdio: 'ignore' });
    const mainTip = g(['rev-parse', 'main']).trim();

    // Release branch off main, then the PR branch off the RELEASE branch (never off main).
    g(['checkout', '-q', '-b', 'rel/0.0.9'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'rel.ts'), 'release-only\n');
    g(['add', 'rel.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'release-only change'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'rel/0.0.9'], { stdio: 'ignore' });
    const relTip = g(['rev-parse', 'rel/0.0.9']).trim();

    g(['checkout', '-q', '-b', 'feat/pr'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'feat/pr'], { stdio: 'ignore' });
    const prTip = g(['rev-parse', 'feat/pr']).trim();

    // The agent edits a.ts and re-ships onto the open PR.
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, { SHIP_DRY_RUN: '1' });
    const wt = WT_RE.exec(r.stderr)?.[1];
    try {
      expect(r.status, r.stderr).toBe(0);
      const gwt = (a) => execFileSync('git', ['-C', wt, ...a], { env, encoding: 'utf8' }).trim();
      expect(gwt(['rev-parse', 'HEAD~1'])).toBe(prTip); // parented on the PR tip...
      expect(gwt(['rev-parse', 'HEAD~1'])).not.toBe(mainTip); // ...not on origin/HEAD
      expect(gwt(['show', 'HEAD:a.ts'])).toBe('v2');
      // The release branch's own commit survives — proof the base branch's history was not dropped.
      expect(gwt(['show', 'HEAD:rel.ts'])).toBe('release-only');
      expect(gwt(['merge-base', '--is-ancestor', relTip, 'HEAD']) === '').toBe(true);
    } finally {
      if (wt) g(['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
    }
  });
});

// A gate chain runs for MINUTES inside the ship worktree, so another process can move that worktree's
// HEAD before git finalises the commit — git then aborts with `cannot lock ref 'HEAD'` AFTER every gate
// passed. (Real cause: fallow < 3.4.2 registered its audit base-snapshot as a worktree and its cleanup
// was not scoped to its own entry.) This must be attributed, not swallowed into blocked_gate "unknown".
describe('reship — HEAD clobbered mid-commit is attributed, not reported as "unknown"', () => {
  it('classifies the ref-lock failure and names the cause on stderr', () => {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', bare],
      ['push', '-q', 'origin', 'main'],
    ])
      g(a, { stdio: 'ignore' });
    const mainTip = g(['rev-parse', 'main']).trim();
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    // The clobber, reproduced: the gate chain PASSES (exit 0) but leaves the worktree's detached HEAD
    // pointing somewhere else, exactly as an out-of-scope worktree cleanup would. git's finalize
    // ref-update is a compare-and-swap, so the commit then dies with `cannot lock ref 'HEAD'`.
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      `#!/bin/sh\necho "gate: all clear"\ngit update-ref --no-deref HEAD ${mainTip}\nexit 0\n`,
    );
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);

    const events = join(mkdtempSync(join(tmpdir(), 'reship-tel-')), 'gate-events.jsonl');
    dirs.push(events);
    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, {
      SHIP_DRY_RUN: '1',
      DEVKIT_GATE_EVENTS: events,
    });

    expect(r.status).not.toBe(0); // nothing was committed, nothing pushed
    expect(r.stderr).toMatch(/cannot lock ref 'HEAD'/); // git's own fatal reached the operator
    expect(r.stderr).toMatch(/HEAD was moved by ANOTHER process mid-commit/); // ...with the diagnosis
    expect(r.stderr).toMatch(/fallow/); // ...and the known cause to check

    const result = readFileSync(events, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.type === 'ship_result');
    expect(result.blocked_gate).toBe('worktree_head_clobbered'); // NOT "unknown"
    expect(result.timed_out).toBe(false);
  });

  it('still attributes the clobber when a fail-open reviewer line sits in the same log', () => {
    // guard-review INCONCLUSIVE is fail-OPEN (exit 2 — the chain continues), so it can coexist with a
    // later clobber. Grepping the gate arms first would blame the reviewer for a failure it did not
    // cause; this locks the ordering of the attribution chain.
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', bare],
      ['push', '-q', 'origin', 'main'],
    ])
      g(a, { stdio: 'ignore' });
    const mainTip = g(['rev-parse', 'main']).trim();
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      `#!/bin/sh\necho "guard-review: api-security-reviewer INCONCLUSIVE"\ngit update-ref --no-deref HEAD ${mainTip}\nexit 0\n`,
    );
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);

    const events = join(mkdtempSync(join(tmpdir(), 'reship-tel-')), 'gate-events.jsonl');
    dirs.push(events);
    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, {
      SHIP_DRY_RUN: '1',
      DEVKIT_GATE_EVENTS: events,
    });
    expect(r.status).not.toBe(0);
    const result = readFileSync(events, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.type === 'ship_result');
    expect(result.blocked_gate).toBe('worktree_head_clobbered'); // not "review"
  });

  it('does NOT claim a clobber when a GATE merely prints the same git error and fails', () => {
    // The captured log folds hook output in with git's own (`2>&1 | tee`), so the phrase alone proves
    // nothing — and devkit's suite emits this exact string, so a gate running the tests would forge it.
    // Here a gate PRINTS the fatal and exits non-zero WITHOUT touching HEAD. Attributing that to a
    // clobber would tell the operator "every gate PASSED, re-running is safe" about a real gate block.
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', bare],
      ['push', '-q', 'origin', 'main'],
    ])
      g(a, { stdio: 'ignore' });
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    // Prints the fatal verbatim (as a nested ship's test output would), then blocks. HEAD never moves.
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      '#!/bin/sh\n' +
        'echo "✗ deterministic gates failed"\n' +
        'echo "fatal: cannot lock ref \'HEAD\': is at 1111111111111111111111111111111111111111 but expected 2222222222222222222222222222222222222222"\n' +
        'exit 1\n',
    );
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);

    const events = join(mkdtempSync(join(tmpdir(), 'reship-tel-')), 'gate-events.jsonl');
    dirs.push(events);
    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, {
      SHIP_DRY_RUN: '1',
      DEVKIT_GATE_EVENTS: events,
    });

    expect(r.status).not.toBe(0);
    const result = readFileSync(events, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.type === 'ship_result');
    expect(result.blocked_gate).toBe('deterministic'); // the real cause, NOT the forged phrase
    expect(r.stderr).not.toMatch(/HEAD was moved by ANOTHER process mid-commit/); // no false all-clear
  });
});

describe('reship — repo path with a space (linked-worktree COMMIT_EDITMSG carries the space)', () => {
  // A linked-worktree commit hands the commit-msg hook the ABSOLUTE $GIT_DIR/COMMIT_EDITMSG path; under
  // a spaced repo root that path contains the space. Devkit forwards it as one intact arg (every ship
  // path is quoted) — the crash that motivated this was a CONSUMER commit-msg hook re-forwarding $1
  // UNQUOTED. (A) proves reship survives a spaced root; (B) proves the failure hint fires on the split.
  function mkRepo(spaced = true) {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    // spaced → the repo root's parent component contains a space (the crash trigger); else space-free.
    const parent = mkdtempSync(join(tmpdir(), spaced ? 'reship space ' : 'reship-nospace-'));
    dirs.push(parent);
    const dir = join(parent, 'repo');
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'work'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', bare],
    ])
      g(a, { stdio: 'ignore' });
    writeFileSync(join(dir, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
    // First ship: a.ts=v1 on origin/feat/pr, then edit v2 for the re-ship.
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    return { dir, g };
  }

  // Install the commit-msg hook AFTER first-ship setup so it fires only on the re-ship commit.
  const commitMsg = (dir, body) => {
    writeFileSync(join(dir, '.husky/_/commit-msg'), body);
    chmodSync(join(dir, '.husky/_/commit-msg'), 0o755);
  };

  it('A: re-ships through a correctly-quoted commit-msg hook (path arrives intact, with its space)', () => {
    const { dir, g } = mkRepo();
    const recDir = mkdtempSync(join(tmpdir(), 'reship-rec-')); // space-FREE record path (no redirect-quoting subtlety)
    dirs.push(recDir);
    const rec = join(recDir, 'arg');
    commitMsg(dir, `#!/bin/sh\nprintf '%s\\n' "$1" > ${JSON.stringify(rec)}\n`);

    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, { SHIP_DRY_RUN: '1' });
    const wt = WT_RE.exec(r.stderr)?.[1];
    expect(r.status, r.stderr).toBe(0); // reship completes despite the spaced $ROOT
    const arg1 = readFileSync(rec, 'utf8').trimEnd();
    expect(arg1).toMatch(/COMMIT_EDITMSG$/); // git handed the hook the message-file path...
    expect(arg1).toContain(' '); // ...as ONE arg still carrying the space (no split before the hook)
    if (wt) g(['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
  });

  it('B: names the space cause when a commit-msg hook forwards $1 unquoted (reproduces the crash)', () => {
    const { dir } = mkRepo();
    // The consumer bug, reproduced: `set -- --edit $1` with an UNQUOTED $1 splits a spaced path into
    // >2 args; echo "$*" keeps the COMMIT_EDITMSG tail in the output (the signature the hint gates on),
    // then exit non-zero fails the commit. Robust to any number of spaces in the temp path.
    commitMsg(
      dir,
      '#!/bin/sh\nset -- --edit $1\n[ "$#" -eq 2 ] && exit 0\necho "Unknown argument: $*"\nexit 9\n',
    );

    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, { SHIP_DRY_RUN: '1' });
    expect(r.status).not.toBe(0); // the split failed the commit
    expect(r.stderr).toMatch(/repo path has a space/); // the diagnostic fired (space + COMMIT_EDITMSG in log)
    // reship's cleanup trap already reclaimed the ephemeral worktree on the failed commit.
  });

  it('C: stays silent on a spaced-path commit failure WITHOUT the COMMIT_EDITMSG signature', () => {
    // Locks the LOG half of the AND-gate. A normal gate rejection under a spaced path (this repo
    // self-dogfoods at one) must not be mis-blamed on an unquoted commit-msg hook. Regressing the gate
    // to space-only would keep test B green but silently reintroduce this false positive.
    const { dir } = mkRepo(true);
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      '#!/bin/sh\necho "gate: blocked (no signature here)"\nexit 1\n', // fails BEFORE git writes COMMIT_EDITMSG
    );
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);

    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, { SHIP_DRY_RUN: '1' });
    expect(r.status).not.toBe(0); // the gate failed the commit
    expect(r.stderr).not.toMatch(/repo path has a space/); // …but the split diagnostic stays silent
  });

  it('D: stays silent on a space-FREE path even when COMMIT_EDITMSG is in the log', () => {
    // Locks the SPACE half of the AND-gate. A hook surfacing COMMIT_EDITMSG at a normal (space-free)
    // path is not the spaced-path split, so the space-specific advice must not fire.
    const { dir } = mkRepo(false);
    expect(dir).not.toContain(' '); // premise: the OS temp dir is space-free (as every other test assumes)
    writeFileSync(
      join(dir, '.husky/_/commit-msg'),
      '#!/bin/sh\necho "hook read $PWD/.git/COMMIT_EDITMSG"\nexit 1\n', // COMMIT_EDITMSG in log, but no split
    );
    chmodSync(join(dir, '.husky/_/commit-msg'), 0o755);

    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, { SHIP_DRY_RUN: '1' });
    expect(r.status).not.toBe(0); // the hook failed the commit
    expect(r.stderr).not.toMatch(/repo path has a space/); // no space → no hint, despite COMMIT_EDITMSG in log
  });
});

// Regression (sc-1199): a reviewer REJECTION used to hang the re-ship forever. The gate exits 1 in
// seconds, so the commit ceiling never fires — but a child the gate leaked still holds the capture
// pipe's write-end, the reader never sees EOF, and the whole run wedges. Because it never returned,
// the EXIT trap never ran and the ephemeral worktree stayed checked out, which is what blocked the
// operator from re-shipping the CORRECTED snapshot. The fix reaps the leaked group once the leader
// exits; this test is the shape of the original report, end to end.
describe('reship — a rejecting gate that leaks a pipe-holder is reaped', () => {
  it('reports the rejection, kills the leaked child, and reclaims the worktree', () => {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky'), { recursive: true });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'work'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', bare],
    ])
      g(a, { stdio: 'ignore' });
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    // The gate: leak a long-lived child onto the commit's stdio (what a `claude` judge subprocess
    // does when the reviewer that spawned it exits first), print a verdict, reject.
    const leakPidFile = join(dir, 'leaked.pid');
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      [
        '#!/bin/sh',
        'sleep 120 &',
        'echo "$!" > "$LEAK_PID_FILE"',
        'echo "guard-review: conventions-reviewer FAILED — staged snapshot rejected"',
        'exit 1',
        '',
      ].join('\n'),
    );
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);

    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first', '--no-verify'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const started = Date.now();
    // SHIP_COMMIT_TIMEOUT far out on purpose: the ceiling must not be what ends this run. The
    // spawnSync timeout is the test's own backstop so a regression fails loudly instead of hanging.
    const r = run(
      ['feat/pr', 'add v2', '--pr', '--', 'a.ts'],
      dir,
      { SHIP_COMMIT_TIMEOUT: '600', LEAK_PID_FILE: leakPidFile },
      { timeout: 90_000 },
    );
    const elapsed = Date.now() - started;
    const leaked = Number(readFileSync(leakPidFile, 'utf8').trim());

    try {
      expect(r.status, r.stderr).toBe(1); // the reviewer's rejection, NOT a timeout status
      expect(r.stderr).not.toMatch(/hit the .*ceiling/); // and not the timeout banner either
      expect(elapsed).toBeLessThan(45_000); // pre-fix: hangs until the leaked child exits (120s)
      expect(processAlive(leaked), 'gate-leaked child should be reaped').toBe(false);
      // The verdict still reached the operator — reaping the gate must not cost them the reason.
      expect(readFileSync(join(dir, '.devkit/last-ship-gates-feat-pr.log'), 'utf8')).toMatch(
        /conventions-reviewer FAILED/,
      );
      // The ephemeral worktree is gone, so the corrected snapshot can be re-shipped immediately.
      expect(g(['worktree', 'list', '--porcelain'])).not.toMatch(/devkit-reship-/);
    } finally {
      try {
        process.kill(leaked, 'SIGKILL'); // never strand a 120s sleeper in CI
      } catch {
        /* already reaped — the passing case */
      }
    }
  }, 120_000);
});
