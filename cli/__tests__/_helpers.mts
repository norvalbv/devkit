/**
 * Shared test fixtures for the CLI suites. `_`-prefixed so vitest's *.test.mjs glob never picks
 * it up as a suite. Collapses the tmp-repo + subprocess-runner + cleanup boilerplate that every
 * subprocess-style CLI test repeated verbatim.
 */
import {
  execFileSync as nodeExecFileSync,
  spawnSync as nodeSpawnSync,
  spawn,
} from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the devkit CLI entry (cli/index.mjs). */
export const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mts');
const TEST_SUBPROCESS = fileURLToPath(new URL('./test-subprocess.mts', import.meta.url));
export const TEST_SUBPROCESS_TIMEOUT_MS = 90_000;
/** Exported alongside the deadline so test-subprocess.test.mts can pin the resolved outer budget. */
export const TEST_SUBPROCESS_CLEANUP_MS = 30_000;
const EPHEMERAL_SHIP_WORKTREE_RE = /devkit-(?:re)?ship-/;

function commandCall(
  command: string,
  argsOrOptions: readonly string[] | Record<string, unknown> | undefined,
  maybeOptions: Record<string, unknown> | undefined,
) {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
  const options = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) ?? {};
  const requestedTimeout = options.timeout;
  const timeoutMs =
    typeof requestedTimeout === 'number' && requestedTimeout > 0
      ? requestedTimeout
      : TEST_SUBPROCESS_TIMEOUT_MS;
  return { command, args, options, timeoutMs };
}

/** Exported for `test-subprocess.test.mts`: the shell-handling contract below is invisible to a
 *  behavioural test on any checkout whose path has no spaces, which is every CI runner. */
export function supervisedCommand(
  command: string,
  argsOrOptions: readonly string[] | Record<string, unknown> | undefined,
  maybeOptions: Record<string, unknown> | undefined,
  groupOnly = false,
) {
  const call = commandCall(command, argsOrOptions, maybeOptions);
  // `shell` describes how the SUPERVISED command should run, never the supervisor invocation.
  // Forwarding it to the outer call makes Node join that argv into one unquoted shell string, so
  // TEST_SUBPROCESS's own path splits on the first space in the repo location — a checkout under
  // `.../Personal and learning/devkit` died with `Cannot find module '/Users/benji/Desktop/Personal'`
  // while CI, whose paths have no spaces, stayed green. Wrap the inner command instead.
  // `shell: true` is node's "pick the platform default"; any other truthy value names the shell.
  const { shell, ...options } = call.options;
  const shellPath = shell === true ? '/bin/sh' : String(shell);
  const supervised = shell
    ? [shellPath, '-c', [call.command, ...call.args].join(' ')]
    : [call.command, ...call.args];
  return {
    args: [
      TEST_SUBPROCESS,
      ...(groupOnly ? ['--group-only'] : []),
      String(call.timeoutMs),
      '--',
      ...supervised,
    ],
    options: {
      ...options,
      timeout: call.timeoutMs + TEST_SUBPROCESS_CLEANUP_MS,
    },
  };
}

/**
 * Synchronous test subprocess with a killable child-process boundary. Vitest's testTimeout cannot
 * interrupt Node while spawnSync blocks, so the runner owns the command's complete process tree and
 * returns 124 after a bounded cleanup instead of letting one broken fixture wedge the whole suite.
 */
export const testSpawnSync = ((
  command: string,
  argsOrOptions?: readonly string[] | Record<string, unknown>,
  maybeOptions?: Record<string, unknown>,
) => {
  const supervised = supervisedCommand(command, argsOrOptions, maybeOptions);
  return nodeSpawnSync(process.execPath, supervised.args, supervised.options);
}) as typeof nodeSpawnSync;

/** Exec-style counterpart to testSpawnSync. It retains execFileSync's return/throw contract while
 * routing short leaf commands through the supervisor's process-group kill path. */
export const testExecFileSync = ((
  command: string,
  argsOrOptions?: readonly string[] | Record<string, unknown>,
  maybeOptions?: Record<string, unknown>,
) => {
  const supervised = supervisedCommand(command, argsOrOptions, maybeOptions, true);
  return nodeExecFileSync(process.execPath, supervised.args, supervised.options);
}) as typeof nodeExecFileSync;

/** Whether a PID still refers to a live process. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolve when a fixture path appears, or fail with a path-specific timeout. */
export function waitForPath(path: string, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = (): void => {
      if (existsSync(path)) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`timed out waiting for ${path}`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

/** Exercise the public-shell-only signal path and assert cleanup waits for the gate hook to exit. */
export async function assertInterruptedGateKeepsWorktree({
  dir,
  env,
  script,
  args,
  listWorktrees,
}) {
  const ready = join(dir, '.signal-hook-ready');
  const result = join(dir, '.signal-hook-result');
  const hook = join(dir, '.husky/_/pre-commit');
  writeFileSync(
    hook,
    [
      '#!/bin/sh',
      'echo ready > "$SIGNAL_HOOK_READY"',
      'trap \'if [ -d "$PWD" ]; then echo present > "$SIGNAL_HOOK_RESULT"; else echo deleted > "$SIGNAL_HOOK_RESULT"; fi; exit 143\' TERM',
      'while :; do sleep 0.1; done',
    ].join('\n'),
  );
  chmodSync(hook, 0o755);

  const child = spawn('/bin/bash', [script, ...args], {
    cwd: dir,
    stdio: 'ignore',
    env: {
      ...env,
      SHIP_DRY_RUN: '1',
      SHIP_COMMIT_TIMEOUT: '3',
      SIGNAL_HOOK_READY: ready,
      SIGNAL_HOOK_RESULT: result,
    },
  });
  await waitForPath(ready, 15_000);
  if (!child.kill('SIGTERM')) throw new Error('could not signal ship shell');
  const [code, signal] = await once(child, 'exit');
  await waitForPath(result, 15_000);

  if (code !== 143 || signal !== null) throw new Error(`unexpected ship exit: ${code}/${signal}`);
  if (readFileSync(result, 'utf8').trim() !== 'present') {
    throw new Error('gate worktree was removed before the interrupted hook exited');
  }
  if (EPHEMERAL_SHIP_WORKTREE_RE.test(listWorktrees())) {
    throw new Error('interrupted ship left an ephemeral worktree behind');
  }
}

/** Whether at least one command is available on PATH, without interpolating names into shell code. */
export function hasAnyCommand(...commands) {
  return commands.some(
    (command) =>
      testSpawnSync('bash', ['-c', 'command -v "$1"', 'devkit-test', command], {
        stdio: 'ignore',
      }).status === 0,
  );
}

// macOS ships bash 3.2 as /bin/bash, which exercises neither dialect split devkit's shell depends on
// (trap-interrupted `wait`, and "${arr[@]}" on an empty array under set -u). null when only 3.2.
export function findModernBash() {
  for (const candidate of ['bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash']) {
    const probe = testSpawnSync(candidate, ['-c', 'printf %s "${BASH_VERSINFO[0]}"'], {
      encoding: 'utf8',
    });
    if (probe.status === 0 && Number(probe.stdout) >= 4) return candidate;
  }
  return null;
}

const FIXTURE_PKG = { name: 'fx', version: '0.0.0', type: 'module' };

/**
 * Self-cleaning tmp-repo fixtures for one suite:
 *   const { tmpRepo, devkit, cleanup } = tmpRepos('clean-');
 *   afterEach(cleanup);
 *
 * `tmpRepo(pkg?)` makes a fresh tmp dir seeded with a fixture package.json (pass `pkg` for a
 * custom manifest); `devkit(root, ...args)` runs the CLI in it; `cleanup()` rm's every dir made.
 *
 * @param {string} prefix mkdtemp prefix (a per-suite tag, e.g. 'clean-')
 */
export function tmpRepos(prefix) {
  let roots = [];
  const tmpRepo = (pkg = FIXTURE_PKG) => {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    return root;
  };
  const devkit = (root, ...args) =>
    testSpawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });
  const cleanup = () => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots = [];
  };
  return { tmpRepo, devkit, cleanup };
}

/** Parse a consumer repo's written `.devkit/config.json`. */
export const readConfig = (root) =>
  JSON.parse(readFileSync(join(root, '.devkit/config.json'), 'utf8'));

/**
 * A tmp-dir registry for suites that build their OWN repo shapes (overlay/standalone/monorepo) and
 * so can't use `tmpRepos`, but still share cleanup. `mkTmp(prefix)` makes + tracks a tmp dir; the
 * suite fills it however it likes; `cleanup()` rm's them all. Pair with `afterEach(cleanup)`.
 */
export function rootRegistry() {
  const roots = [];
  const mkTmp = (prefix) => {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  };
  const cleanup = () => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  };
  return { mkTmp, cleanup };
}

/**
 * Seed a per-session edits ledger for the agents-hooks suites (session-edits-lib.sh). Creates a
 * fixture-LOCAL tmpdir (pass it as TMPDIR to the hook so real machine state never leaks in) and
 * writes `devkit-session-edits/<REPO_KEY>-<sid>` with the given repo-relative paths. REPO_KEY is
 * computed exactly the way the lib does (`pwd -P | cksum`) so the hook resolves the same file.
 * Pass `paths: null` to create the isolated tmpdir WITHOUT a ledger (the no-edits session shape).
 *
 * @param {string} root fixture repo root
 * @param {string} sid session_id the hook payload will carry
 * @param {string[]|null} paths repo-relative edited paths (null → no ledger)
 * @returns {string} the tmpdir to pass as the hook's TMPDIR env
 */
export function seedSessionLedger(root, sid, paths) {
  const tmp = join(root, '.test-tmpdir');
  mkdirSync(join(tmp, 'devkit-session-edits'), { recursive: true });
  if (paths !== null) {
    writeFileSync(
      join(tmp, 'devkit-session-edits', `${repoKey(root)}-${sid}`),
      `${paths.join('\n')}\n`,
    );
  }
  return tmp;
}

/** REPO_KEY exactly as session-edits-lib.sh computes it (`pwd -P | cksum`, first field). */
export const repoKey = (root) =>
  testSpawnSync('bash', ['-c', 'pwd -P | cksum | cut -d" " -f1'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim();

/**
 * Fixtures for the structure-baseline suites: a self-cleaning tmp repo + a `write(root, rel, content)`
 * helper that mkdir-ps the parent. `const { tmpRepo, write, cleanup } = structFixtures('struct-')`.
 *
 * @param {string} prefix mkdtemp prefix
 */
export function structFixtures(prefix) {
  const { mkTmp, cleanup } = rootRegistry();
  const write = (root, rel, content = 'export {};\n') => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  return { tmpRepo: () => mkTmp(prefix), write, cleanup };
}
