import { execFileSync, type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeSelection, type Selection } from '../lib/components.mts';
import { buildFullHook } from '../lib/husky/husky-block.mts';
import { CLI, rootRegistry } from './_helpers.mts';

const { cleanup, mkTmp } = rootRegistry();
afterEach(cleanup);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'review@example.test',
  GIT_AUTHOR_NAME: 'Review Test',
  GIT_COMMITTER_EMAIL: 'review@example.test',
  GIT_COMMITTER_NAME: 'Review Test',
  GIT_OPTIONAL_LOCKS: '0',
};
const REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], {
  encoding: 'utf8',
}).trim();
const EMPTY_SELECTION: Selection = normalizeSelection({
  biome: false,
  tsconfig: false,
  skills: false,
  agents: false,
  searchSteering: false,
  agentHooks: false,
  husky: true,
  structure: false,
  fallow: false,
  searchCode: false,
  lineGrowth: false,
  agentTargets: [],
  guards: [],
});

interface Fixture {
  parent: string;
  root: string;
  env: NodeJS.ProcessEnv;
  base: string;
}

interface RepositoryEvidence {
  head: string;
  indexHash: string;
  status: Buffer;
  refs: Buffer;
  branches: Buffer;
  remotes: Buffer;
  worktrees: Buffer;
}

function gitBuffer(root: string, ...args: string[]): Buffer {
  return execFileSync(REAL_GIT, ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    env: GIT_ENV,
  });
}

function git(root: string, ...args: string[]): string {
  return gitBuffer(root, ...args)
    .toString('utf8')
    .trim();
}

function write(root: string, relativePath: string, contents: string, executable = false): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, executable ? 0o755 : 0o644);
}

function hookWith(action: string): string {
  return buildFullHook(EMPTY_SELECTION).replace('\nexit 0\n', () => `\n${action}\nexit 0\n`);
}

function updateInferredBase(root: string): string {
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/main', head);
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  return head;
}

function fixture(action = "printf 'REVIEW_HOOK_RAN\\n'"): Fixture {
  const parent = realpathSync(mkTmp('devkit-review-command-'));
  const root = join(parent, 'trusted target');
  const home = join(parent, 'home');
  const cache = join(parent, 'cache');
  const temp = join(parent, 'runtime');
  mkdirSync(root);
  mkdirSync(home);
  mkdirSync(cache);
  mkdirSync(temp);
  execFileSync(REAL_GIT, ['init', '-q', root], { env: GIT_ENV });
  git(root, 'branch', '-M', 'main');
  git(root, 'config', 'user.name', 'Review Test');
  git(root, 'config', 'user.email', 'review@example.test');
  git(root, 'config', 'core.hooksPath', '.husky/_');
  git(root, 'remote', 'add', 'origin', 'https://example.invalid/never-fetch.git');

  write(root, '.gitignore', '.devkit/review-runs/\nignored.txt\n');
  write(root, 'package.json', '{"name":"review-fixture","private":true,"type":"module"}\n');
  write(root, 'committed.txt', 'base committed\n');
  write(root, 'staged.txt', 'base staged\n');
  write(root, 'unstaged.txt', 'base unstaged\n');
  write(root, 'deleted.txt', 'delete me\n');
  write(root, 'surrounding.txt', 'unchanged surrounding file\n');
  write(
    root,
    '.devkit/config.json',
    `${JSON.stringify(
      {
        stack: 'generic',
        standalone: false,
        overlay: false,
        components: EMPTY_SELECTION,
        review: { enabled: true, guards: [], decisionsDir: 'docs/decisions' },
      },
      null,
      2,
    )}\n`,
  );
  write(root, '.husky/pre-commit', hookWith(action), true);
  write(
    root,
    '.husky/_/pre-commit',
    '#!/bin/sh\nexec sh "$(dirname -- "$0")/../pre-commit" "$@"\n',
    true,
  );
  write(root, '.husky/_/h', '#!/bin/sh\nexit 0\n', true);
  execFileSync('/bin/sh', ['-n', join(root, '.husky/pre-commit')]);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  const base = updateInferredBase(root);
  return {
    parent,
    root,
    base,
    env: {
      ...process.env,
      DEVKIT_NO_TELEMETRY: '1',
      // Pinned high, and pinned SEPARATELY from SHIP_COMMIT_TIMEOUT. The setup ceiling defaults to
      // SHIP_COMMIT_TIMEOUT, so without this every fixture would bound two `git worktree add`
      // checkouts plus dependency and asset materialization at 15s — spurious 124s on a loaded CI
      // box — and the timeout test below, which drops SHIP_COMMIT_TIMEOUT to 1s to exercise the GATE
      // CHAIN's ceiling, would trip the setup guard before the gates ever launched.
      DEVKIT_PREFLIGHT_TIMEOUT: '600',
      HOME: home,
      SHIP_COMMIT_TIMEOUT: '15',
      TMPDIR: temp,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: join(parent, 'xdg-config'),
    },
  };
}

function addCommittedChange(target: Fixture): void {
  git(target.root, 'switch', '-qc', 'feature/review-smoke');
  write(target.root, 'committed.txt', 'committed branch change\n');
  git(target.root, 'add', 'committed.txt');
  git(target.root, 'commit', '-qm', 'feature change');
}

function runReview(
  target: Fixture,
  args: string[] = [],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI, 'review', ...args], {
    cwd: options.cwd ?? target.root,
    encoding: 'utf8',
    env: options.env ?? target.env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 180_000,
  });
}

function repositoryEvidence(root: string): RepositoryEvidence {
  const indexPath = git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
  return {
    head: git(root, 'rev-parse', 'HEAD'),
    indexHash: createHash('sha256').update(readFileSync(indexPath)).digest('hex'),
    status: gitBuffer(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    refs: gitBuffer(
      root,
      'for-each-ref',
      '--sort=refname',
      '--format=%(refname)%00%(objectname)%00',
    ),
    branches: gitBuffer(root, 'branch', '--format=%(refname)%00%(objectname)%00'),
    remotes: gitBuffer(root, 'remote', '-v'),
    worktrees: gitBuffer(root, 'worktree', 'list', '--porcelain', '-z'),
  };
}

function logs(root: string): string[] {
  const directory = join(root, '.devkit', 'review-runs');
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

/**
 * The contents of the one run log that appeared since `before`. Never index logs() directly: a test
 * that invokes review twice produces two logs, and RUN_ID (`<branch>-<UTC-seconds>-$$-$RANDOM`)
 * only sorts chronologically while the runs land in different seconds.
 */
function newLogSince(root: string, before: readonly string[]): string {
  const fresh = logs(root).filter((name) => !before.includes(name));
  expect(fresh, `expected exactly one new run log, got ${fresh.join(', ')}`).toHaveLength(1);
  return readFileSync(join(root, '.devkit/review-runs', fresh[0] as string), 'utf8');
}

function combinedOutput(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (!processAlive(pid)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return !processAlive(pid);
}

async function terminatePublicCliAtMarker(
  target: Fixture,
  options: {
    executable?: string;
    marker: string;
    pidPattern: RegExp;
    reviewEnvironment?: NodeJS.ProcessEnv;
  },
): Promise<{
  code: number | null;
  managedPid: number | null;
  output: string;
  signalLatencyMs: number | null;
  signal: NodeJS.Signals | null;
}> {
  const child = spawn(options.executable ?? process.execPath, [CLI, 'review'], {
    cwd: target.root,
    env: options.reviewEnvironment ?? { ...target.env, SHIP_COMMIT_TIMEOUT: '60' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let managedPid: number | null = null;
  let output = '';
  let signalSent = false;
  let signalSentAt: number | null = null;
  let timeout: NodeJS.Timeout | undefined;
  let timeoutPhase: 'waiting for marker' | 'waiting for signal cleanup' | null = null;
  const armTimeout = (milliseconds: number, phase: NonNullable<typeof timeoutPhase>): void => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeoutPhase = phase;
      child.kill('SIGTERM');
    }, milliseconds);
  };
  const inspect = (chunk: Buffer): void => {
    output += chunk.toString('utf8');
    const match = options.pidPattern.exec(output);
    if (match) managedPid = Number(match[1]);
    if (!signalSent && output.includes(options.marker) && managedPid !== null) {
      signalSent = true;
      signalSentAt = Date.now();
      child.kill('SIGTERM');
      armTimeout(60_000, 'waiting for signal cleanup');
    }
  };
  child.stdout?.on('data', inspect);
  child.stderr?.on('data', inspect);
  // Full-suite contention can make authenticated snapshot preparation itself exceed 75s. Bound
  // marker discovery separately so it never consumes the window intended to validate cleanup.
  armTimeout(180_000, 'waiting for marker');
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveClose, rejectClose) => {
    child.once('error', rejectClose);
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  if (timeoutPhase) throw new Error(`public CLI timed out ${timeoutPhase}:\n${output}`);
  return {
    ...result,
    managedPid,
    output,
    signalLatencyMs: signalSentAt === null ? null : Date.now() - signalSentAt,
  };
}

describe('devkit review source CLI', () => {
  // sc-1442: a review run has no commit message — the driver synthesizes the reviewed range's
  // subjects (oldest first) into DEVKIT_COMMIT_MSG_FILE, and a caller-injected stale path must be
  // scrubbed, never forwarded to the gates.
  it('synthesizes range subjects as the intent file, ignoring a caller-injected stale path (sc-1442)', () => {
    const action = `
test -n "\${DEVKIT_COMMIT_MSG_FILE:-}" || exit 81
test "$DEVKIT_COMMIT_MSG_FILE" != "/nope" || exit 82
test "$(head -n 1 "$DEVKIT_COMMIT_MSG_FILE")" = "feature change" || exit 83
printf 'REVIEW_INTENT_OK\\n'
`;
    const target = fixture(action);
    addCommittedChange(target);
    const result = runReview(target, [], {
      env: { ...target.env, DEVKIT_COMMIT_MSG_FILE: '/nope' },
    });
    expect(result.status, combinedOutput(result)).toBe(0);
    expect(combinedOutput(result)).toContain('REVIEW_INTENT_OK');
  });

  it('an empty reviewed range leaves the intent var unset and the review completes (sc-1442)', () => {
    const action = `
test -z "\${DEVKIT_COMMIT_MSG_FILE:-}" || exit 84
printf 'REVIEW_NO_INTENT_OK\\n'
`;
    const target = fixture(action);
    // Staged-only work: no commits past the merge base, so `git log` yields nothing.
    write(target.root, 'staged.txt', 'staged local change\n');
    git(target.root, 'add', 'staged.txt');
    const result = runReview(target);
    expect(result.status, combinedOutput(result)).toBe(0);
    expect(combinedOutput(result)).toContain('REVIEW_NO_INTENT_OK');
  });

  it('reviews the complete merge-base-to-final snapshot without changing the target checkout', () => {
    const action = `
test "$(cat committed.txt)" = "committed branch change" || exit 71
test "$(cat staged.txt)" = "staged local change" || exit 72
test "$(cat unstaged.txt)" = "unstaged local change" || exit 73
test ! -e deleted.txt || exit 74
test "$(cat untracked.txt)" = "untracked local change" || exit 75
test "$(cat surrounding.txt)" = "unchanged surrounding file" || exit 76
test ! -e ignored.txt || exit 77
test "$(git rev-parse HEAD)" = "$DEVKIT_REVIEW_MERGE_BASE" || exit 78
for path in committed.txt staged.txt unstaged.txt deleted.txt untracked.txt; do
  git diff --cached --name-only --diff-filter=ACDMRTUXB | grep -F -x "$path" >/dev/null || exit 79
done
git diff --cached --name-status | grep -E '^D[[:space:]]+deleted\\.txt$' >/dev/null || exit 80
printf 'REVIEW_SNAPSHOT_OK\\n'
`;
    const target = fixture(action);
    addCommittedChange(target);
    write(target.root, 'staged.txt', 'staged local change\n');
    git(target.root, 'add', 'staged.txt');
    write(target.root, 'unstaged.txt', 'unstaged local change\n');
    rmSync(join(target.root, 'deleted.txt'));
    write(target.root, 'untracked.txt', 'untracked local change\n');
    write(target.root, 'ignored.txt', 'must not be reviewed\n');
    const before = repositoryEvidence(target.root);
    const targetBytes = new Map(
      ['committed.txt', 'staged.txt', 'unstaged.txt', 'untracked.txt', 'ignored.txt'].map(
        (path) => [path, readFileSync(join(target.root, path))],
      ),
    );

    const result = runReview(target);

    expect(result.status, combinedOutput(result)).toBe(0);
    expect(combinedOutput(result)).toContain('REVIEW_SNAPSHOT_OK');
    expect(combinedOutput(result)).toContain('base=origin/HEAD');
    expect(combinedOutput(result)).toContain(`merge-base=${target.base}`);
    expect(repositoryEvidence(target.root)).toEqual(before);
    for (const [path, bytes] of targetBytes) {
      expect(readFileSync(join(target.root, path))).toEqual(bytes);
    }
    expect(existsSync(join(target.root, 'deleted.txt'))).toBe(false);
    expect(logs(target.root)).toHaveLength(1);
    const log = readFileSync(
      join(target.root, '.devkit/review-runs', logs(target.root)[0] as string),
      'utf8',
    );
    expect(log).toContain('REVIEW_SNAPSHOT_OK');
    expect(log).toContain('result=passed exit=0 phase=verdict');
  }, 240_000);

  it('validates setup before a clean success and never runs the hook for no changes', () => {
    const target = fixture("echo 'CLEAN_HOOK_MUST_NOT_RUN' >&2; exit 91");

    const beforeClean = logs(target.root);
    const clean = runReview(target);

    expect(clean.status, combinedOutput(clean)).toBe(0);
    expect(combinedOutput(clean)).toContain('nothing to review');
    expect(combinedOutput(clean)).not.toContain('CLEAN_HOOK_MUST_NOT_RUN');
    // A no-op is recorded as its own outcome, never as a pass.
    expect(newLogSince(target.root, beforeClean)).toContain(
      'result=skipped exit=0 phase=nothing-to-review',
    );

    write(target.root, '.husky/pre-commit', '#!/bin/sh\nexit 0\n', true);
    git(target.root, 'add', '.husky/pre-commit');
    git(target.root, 'commit', '-qm', 'commit invalid setup');
    updateInferredBase(target.root);
    const beforeInvalid = logs(target.root);
    const invalid = runReview(target);

    expect(invalid.status).toBe(1);
    expect(combinedOutput(invalid)).toMatch(/gate block differs.*devkit doctor --fix/i);
    expect(newLogSince(target.root, beforeInvalid)).toContain(
      'result=failed exit=1 phase=setup-capture',
    );
  }, 240_000);

  /**
   * A P1 report claimed a drifted core.hooksPath exits 0 with an unreviewed diff — the persisted log
   * being nothing but its own header made a setup abort look like a legitimate short run. The drift
   * is routine (any husky-running install re-claims core.hooksPath). Two properties are pinned here:
   * the setup failure is fail-closed, and the log says so rather than ending mid-sentence.
   */
  it('fails a review whose core.hooksPath drifted, and records why in the run log', () => {
    const target = fixture("printf 'DRIFT_HOOK_MUST_NOT_RUN\\n'");
    addCommittedChange(target);
    git(target.root, 'config', 'core.hooksPath', '.git/hooks');

    const before = logs(target.root);
    const result = runReview(target);

    expect(result.status, combinedOutput(result)).toBe(1);
    expect(combinedOutput(result)).toMatch(
      /core\.hooksPath is "\.git\/hooks", expected \.husky\/_.*doctor --fix/,
    );
    expect(combinedOutput(result)).not.toContain('DRIFT_HOOK_MUST_NOT_RUN');

    const log = newLogSince(target.root, before);
    expect(log).toContain('result=failed exit=1 phase=setup-capture');
    expect(log).not.toContain('✓');
  }, 240_000);

  it('supports explicit targets and bases, prefers origin/HEAD, and never fetches', () => {
    const target = fixture("printf 'BASE_SELECTION_OK\\n'");
    addCommittedChange(target);
    const bin = join(target.parent, 'bin');
    const fetchSentinel = join(target.parent, 'fetch-was-called');
    mkdirSync(bin);
    write(
      target.parent,
      'bin/git',
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = fetch ]; then
    : > ${JSON.stringify(fetchSentinel)}
    exit 97
  fi
done
exec ${JSON.stringify(REAL_GIT)} "$@"
`,
      true,
    );
    const env = { ...target.env, PATH: `${bin}:${target.env.PATH ?? ''}` };

    const inferred = runReview(target, ['--target', target.root], {
      cwd: target.parent,
      env,
    });
    const explicit = runReview(target, ['--target', target.root, '--base', 'main'], {
      cwd: target.parent,
      env,
    });

    expect(inferred.status, combinedOutput(inferred)).toBe(0);
    expect(combinedOutput(inferred)).toContain('base=origin/HEAD');
    expect(combinedOutput(inferred)).toContain(`merge-base=${target.base}`);
    expect(explicit.status, combinedOutput(explicit)).toBe(0);
    expect(combinedOutput(explicit)).toContain('base=main');
    expect(existsSync(fetchSentinel)).toBe(false);
    expect(logs(target.root)).toHaveLength(2);
    expect(new Set(logs(target.root)).size).toBe(2);
  }, 400_000);

  it('normalizes an arbitrary gate rejection to exit 1 and preserves the target', () => {
    const target = fixture("echo 'FIXTURE_GATE_REJECTED' >&2; exit 9");
    addCommittedChange(target);
    const before = repositoryEvidence(target.root);

    const result = runReview(target);

    expect(result.status).toBe(1);
    expect(combinedOutput(result)).toContain('FIXTURE_GATE_REJECTED');
    expect(combinedOutput(result)).toContain('gate exit 9; command exit 1');
    expect(repositoryEvidence(target.root)).toEqual(before);
  }, 240_000);

  it('rejects formatter mutations in the ephemeral worktree without copying them back', () => {
    const target = fixture(
      "printf 'ephemeral format\\n' > committed.txt; git add -f committed.txt; echo FORMATTER_RAN",
    );
    addCommittedChange(target);
    const before = repositoryEvidence(target.root);
    const targetContents = readFileSync(join(target.root, 'committed.txt'));

    const result = runReview(target);

    expect(result.status).toBe(1);
    expect(combinedOutput(result)).toContain('FORMATTER_RAN');
    expect(combinedOutput(result)).toContain('changed the ephemeral snapshot');
    expect(combinedOutput(result)).toContain('no ephemeral changes were copied back');
    expect(readFileSync(join(target.root, 'committed.txt'))).toEqual(targetContents);
    expect(repositoryEvidence(target.root)).toEqual(before);
  }, 240_000);

  it('preserves timeout exit 124 and removes the temporary review worktrees', () => {
    const target = fixture('echo TIMEOUT_HOOK_STARTED; sleep 30');
    addCommittedChange(target);
    const before = repositoryEvidence(target.root);
    const beforeLogs = logs(target.root);

    const result = runReview(target, [], {
      env: { ...target.env, SHIP_COMMIT_TIMEOUT: '1' },
      timeout: 75_000,
    });

    expect(result.signal, combinedOutput(result)).toBeNull();
    expect(result.status, combinedOutput(result)).toBe(124);
    expect(combinedOutput(result)).toContain('TIMEOUT_HOOK_STARTED');
    expect(combinedOutput(result)).toContain('gate chain hit the 1s ceiling');
    // 124 reaches the terminal block rather than exiting out of the gate region, so phase=verdict.
    expect(newLogSince(target.root, beforeLogs)).toContain('result=timeout exit=124 phase=verdict');
    expect(repositoryEvidence(target.root)).toEqual(before);
    expect(gitBuffer(target.root, 'worktree', 'list', '--porcelain', '-z')).toEqual(
      before.worktrees,
    );
  }, 240_000);

  it('forwards SIGTERM sent only to the public CLI and reaps the complete hook tree', async () => {
    const target = fixture(`
echo SIGNAL_HOOK_STARTED
sleep 30 &
descendant=$!
echo "SIGNAL_DESCENDANT_PID=$descendant"
wait "$descendant"
`);
    addCommittedChange(target);
    const before = repositoryEvidence(target.root);

    const result = await terminatePublicCliAtMarker(target, {
      marker: 'SIGNAL_HOOK_STARTED',
      pidPattern: /SIGNAL_DESCENDANT_PID=(\d+)/,
    });

    expect(result.output).toContain('SIGNAL_HOOK_STARTED');
    expect(result.managedPid).not.toBeNull();
    expect(result.signal).toBeNull();
    expect(result.code, result.output).toBe(143);
    expect(await waitForProcessExit(result.managedPid as number)).toBe(true);
    expect(repositoryEvidence(target.root)).toEqual(before);
    expect(gitBuffer(target.root, 'worktree', 'list', '--porcelain', '-z')).toEqual(
      before.worktrees,
    );
  }, 240_000);

  it('finishes protected cleanup with matching SIGTERM telemetry and CLI status', async () => {
    const target = fixture("printf 'CLEANUP_SIGNAL_HOOK_OK\\n'");
    addCommittedChange(target);
    const bin = join(target.parent, 'cleanup-git-bin');
    mkdirSync(bin);
    write(
      target.parent,
      'cleanup-git-bin/git',
      `#!/bin/sh
case " $* " in
  *" worktree remove "*)
    echo "CLEANUP_REMOVE_STARTED PID=$$" >&2
    sleep 1
    ;;
esac
exec ${JSON.stringify(REAL_GIT)} "$@"
`,
      true,
    );
    const before = repositoryEvidence(target.root);
    const environment = { ...target.env, PATH: `${bin}:${target.env.PATH ?? ''}` };
    delete environment.DEVKIT_NO_TELEMETRY;

    const result = await terminatePublicCliAtMarker(target, {
      marker: 'CLEANUP_REMOVE_STARTED',
      pidPattern: /CLEANUP_REMOVE_STARTED PID=(\d+)/,
      reviewEnvironment: environment,
    });

    expect(result.signal).toBeNull();
    expect(result.code, result.output).toBe(143);
    expect(repositoryEvidence(target.root)).toEqual(before);
    expect(gitBuffer(target.root, 'worktree', 'list', '--porcelain', '-z')).toEqual(
      before.worktrees,
    );
    const telemetry = readFileSync(
      join(environment.HOME as string, '.devkit', 'telemetry', 'gate-events.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const terminal = telemetry.filter(({ type }) => type === 'review_run_result');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ exit_code: 143, run_mode: 'review' });
  }, 240_000);

  it('interrupts a foreground preflight Node helper when only the public CLI gets SIGTERM', async () => {
    const target = fixture();
    const bin = join(target.parent, 'managed-node-bin');
    const cliNode = join(bin, 'node-cli');
    mkdirSync(bin);
    copyFileSync(process.execPath, cliNode);
    chmodSync(cliNode, 0o755);
    expect(execFileSync(cliNode, ['-p', 'process.execPath'], { encoding: 'utf8' }).trim()).toBe(
      cliNode,
    );
    write(
      target.parent,
      'managed-node-bin/node',
      `#!/bin/sh
case "$1:$2" in
  */review/setup-manifest.mts:capture)
    exec ${JSON.stringify(process.execPath)} -e 'console.error("PREFLIGHT_HELPER_STARTED PID=" + process.pid); setInterval(() => {}, 1000)'
    ;;
esac
exec ${JSON.stringify(process.execPath)} "$@"
`,
      true,
    );
    const before = repositoryEvidence(target.root);
    const runtime = join(target.parent, 'runtime');
    const runtimeBefore = readdirSync(runtime);

    const result = await terminatePublicCliAtMarker(target, {
      executable: cliNode,
      marker: 'PREFLIGHT_HELPER_STARTED',
      pidPattern: /PREFLIGHT_HELPER_STARTED PID=(\d+)/,
      reviewEnvironment: { ...target.env, SHIP_COMMIT_TIMEOUT: '60' },
    });

    expect(result.managedPid).not.toBeNull();
    expect(result.signal).toBeNull();
    expect(result.code, result.output).toBe(143);
    expect(result.signalLatencyMs).not.toBeNull();
    expect(result.signalLatencyMs as number).toBeLessThan(20_000);
    expect(await waitForProcessExit(result.managedPid as number)).toBe(true);
    expect(repositoryEvidence(target.root)).toEqual(before);
    expect(gitBuffer(target.root, 'worktree', 'list', '--porcelain', '-z')).toEqual(
      before.worktrees,
    );
    expect(readdirSync(runtime)).toEqual(runtimeBefore);
  }, 240_000);

  /**
   * A P2 report saw a review sit 15+ minutes with a 152-byte run log — the header and nothing else.
   * The gate chain was never the problem: it streams through a FIFO+tee opened before launch. The
   * ~245 lines of setup BEFORE it wrote nothing, so a wedged checkout and a slow one were the same
   * observation. Two properties are pinned: setup narrates itself as it goes, and the narration
   * survives the gate chain (whose capture used to open the log truncating, erasing everything
   * written before it — including the header the report was looking at).
   */
  it('streams setup phases to the run log and keeps them once the gates run', () => {
    const target = fixture();
    addCommittedChange(target);
    const beforeLogs = logs(target.root);

    const startedAt = Date.now();
    const result = runReview(target);
    const elapsedMs = Date.now() - startedAt;

    expect(result.status, combinedOutput(result)).toBe(0);
    // The setup guard must be retired at the gate handover, not waited out. It ignores SIGTERM (it
    // sits in the group it signals), so retiring it with anything catchable makes the handover block
    // until the ceiling elapses on its own — a passing review would take DEVKIT_PREFLIGHT_TIMEOUT
    // (600s here) instead of seconds. Cheap, direct guard against that regression returning.
    expect(elapsedMs, `handover stalled: ${elapsedMs}ms`).toBeLessThan(120_000);
    const log = newLogSince(target.root, beforeLogs);
    // The header is written ~245 lines before the gates launch; a truncating capture erased it.
    expect(log).toContain('devkit review: target=');
    expect(log).toMatch(/phase=setup-capture t=\d+s/);
    expect(log).toMatch(/phase=worktree-final t=\d+s/);
    expect(log).toMatch(/phase=gates t=\d+s/);
    // Gate output still lands in the same log the setup lines are now sharing.
    expect(log).toContain('REVIEW_HOOK_RAN');
    expect(log).toContain('result=passed exit=0 phase=verdict');
    // Every phase line must precede the gate output rather than being flushed at the end.
    expect(log.indexOf('phase=setup-capture')).toBeLessThan(log.indexOf('REVIEW_HOOK_RAN'));
  }, 240_000);

  /**
   * The ceiling that already bounded the gate chain wrapped only the gate command, leaving setup and
   * teardown unbounded — and nothing bounds review-target.sh from outside either. The wedge here is a
   * FOREGROUND child, which is the only case that distinguishes a working guard from a placebo: bash
   * defers a trapped signal until the running foreground command returns, so a pid-targeted kill
   * would write a "timed out" banner and then hang anyway. The guard signals the process group.
   */
  it('bounds a wedged foreground setup step, attributes it, and still removes the worktrees', () => {
    const target = fixture();
    const bin = join(target.parent, 'managed-node-bin');
    const cliNode = join(bin, 'node-cli');
    mkdirSync(bin);
    copyFileSync(process.execPath, cliNode);
    chmodSync(cliNode, 0o755);
    // Wedges asset materialization: late enough that both ephemeral worktrees already exist, so a
    // guard that killed too hard would strand them checked out in the target's worktree list.
    write(
      target.parent,
      'managed-node-bin/node',
      `#!/bin/sh
case "$1:$2" in
  */review/asset-runtime.mts:materialize)
    exec ${JSON.stringify(process.execPath)} -e 'console.error("ASSET_WEDGE_STARTED"); setInterval(() => {}, 1000)'
    ;;
esac
exec ${JSON.stringify(process.execPath)} "$@"
`,
      true,
    );
    addCommittedChange(target);
    const before = repositoryEvidence(target.root);
    const beforeLogs = logs(target.root);

    const result = spawnSync(cliNode, [CLI, 'review'], {
      cwd: target.root,
      encoding: 'utf8',
      // Generous enough that setup reliably REACHES the wedge before the ceiling fires — the wedge
      // is infinite, so the guard still fires deterministically, just attributed to the phase we
      // meant to test. A tight ceiling would race parallel test load and name an earlier phase.
      env: { ...target.env, DEVKIT_PREFLIGHT_TIMEOUT: '30' },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 150_000,
    });

    expect(result.signal, combinedOutput(result)).toBeNull();
    expect(combinedOutput(result)).toContain('ASSET_WEDGE_STARTED');
    // 124, not 143: the sentinel is what separates a ceiling from a user's Ctrl-C, and it reuses the
    // gate chain's timeout vocabulary rather than inventing a second one.
    expect(result.status, combinedOutput(result)).toBe(124);
    expect(combinedOutput(result)).toContain('hit the 30s ceiling DURING: assets');
    expect(newLogSince(target.root, beforeLogs)).toContain('result=timeout exit=124 phase=assets');
    // A hang guard that leaks ephemeral worktrees is worse than no hang guard.
    expect(repositoryEvidence(target.root)).toEqual(before);
    expect(gitBuffer(target.root, 'worktree', 'list', '--porcelain', '-z')).toEqual(
      before.worktrees,
    );
  }, 240_000);

  /**
   * `0`, `.` and `1.2.3` all make /bin/sleep return or fail immediately, which would fire a spurious
   * ceiling on every run. Rejected loudly rather than defaulted, matching gate-supervisor.mts —
   * a silent fallback would accept here what the gate chain refuses to start on.
   */
  it('rejects a malformed setup ceiling instead of silently defaulting', () => {
    const target = fixture();
    addCommittedChange(target);

    for (const value of ['abc', '0', '0.0', '1.2.3', '-5']) {
      const result = runReview(target, [], {
        env: { ...target.env, DEVKIT_PREFLIGHT_TIMEOUT: value },
      });
      expect(result.status, `${value}: ${combinedOutput(result)}`).toBe(1);
      expect(combinedOutput(result)).toContain(`invalid timeout ${value}`);
    }
  }, 240_000);
});
