import { execFileSync } from 'node:child_process';
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
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFullHook, buildOverlayHook, buildStandaloneHook } from '../lib/husky/husky-block.mts';

// Execute the ASSEMBLED hook under a real `sh -e` with local/global stubs that dispatch per tool
// (exit codes via env knobs) and logs every invocation. The hook now delegates the whole
// deterministic set (prefix cache → guards → structure → aggregation) to the single
// `guard-deterministic` orchestrator, so its internal trichotomy/aggregation is proven in
// gate-engine/deterministic/__tests__/run.test.mjs. THIS harness proves the SHELL contract the
// hook still owns: commit/ship fails fast, review remembers deterministic failure until selected
// diagnostics run, AI gates stay fail-fast, and it all survives dash + a hook path with spaces.

const homes = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop(), { recursive: true, force: true });
});

const ALL_GUARDS = ['size', 'fanout', 'dup', 'clone', 'comments', 'decisions', 'review'];

// Hooks run under whatever /bin/sh the OS ships — dash on Debian/Ubuntu, bash on macOS. The
// fragments are POSIX sh; prove it where dash is installed instead of assuming.
const hasDash = existsSync('/bin/dash');

function runHook(
  env = {},
  selection = { biome: false, guards: ALL_GUARDS },
  {
    shell = 'sh',
    dirPrefix = 'dk-hook-exec-',
    shipMsg = false,
    builder = 'package',
    pkgRel = '',
    missingBins = [],
    missingLocalBins = [],
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), dirPrefix));
  homes.push(home);
  if (shipMsg) {
    // The sc-1442 composed-message temp file a ship exports — its presence arms the parallel
    // completeness prewarm in the review fragment.
    const msgf = join(home, 'ship-msg.txt');
    writeFileSync(msgf, 'feat: thing\n\nbody\n');
    env = { DEVKIT_COMMIT_MSG_FILE: msgf, ...env };
  }
  const bin = join(home, '.bun', 'bin');
  const packageBin = join(home, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(packageBin, { recursive: true });
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nprintf \'%s\\n\' "$HOME/node_modules/.bin"\n');
  chmodSync(join(bin, 'bun'), 0o755);
  const gateStub = `#!/bin/sh
tool="\${0##*/}"
if [ "$tool" = "bunx" ]; then tool="$1"; shift; fi
echo "$tool $*" >> "$HOME/calls.log"
case "$tool" in
  guard-deterministic) exit \${DET_RC:-0};;
  guard-comments) exit \${COMMENTS_RC:-0};;
  guard-decisions) exit \${DEC_RC:-0};;
  guard-review)
    case "$1" in
      completeness)
        # COMP_SLOW_TERM: a judge that does not die the instant it is signalled. It releases the
        # inherited stdout/stderr FIRST (\`exec >/dev/null\`) so this harness measures the HOOK's
        # own return, not the pipe drain — otherwise spawnSync would block on the pipe regardless
        # and a hook that never reaps would still look correct. The trap then delays before
        # recording that it finished winding down, so "hook returned" and "child was reaped" are
        # separable events.
        if [ -n "\${COMP_SLOW_TERM:-}" ]; then
            exec >/dev/null 2>&1
            trap 'sleep 1; echo reaped > "$HOME/comp-reaped"; exit 143' TERM
            echo running > "$HOME/comp-running"
            sleep 30 &
            wait $!
        fi
        exit \${COMP_RC:-0};;
      *) [ -n "\${COMP_SLOW_TERM:-}" ] && sleep 0.1; exit \${REVIEW_RC:-0};;
    esac;;
  *) exit 0;;
esac
`;
  for (const name of [
    'bunx',
    'guard-deterministic',
    'guard-comments',
    'guard-decisions',
    'guard-review',
    'guard-qavis-advisory',
  ]) {
    writeFileSync(join(bin, name), gateStub);
    chmodSync(join(bin, name), 0o755);
    if (name !== 'bunx') {
      writeFileSync(join(packageBin, name), gateStub);
      chmodSync(join(packageBin, name), 0o755);
    }
  }
  for (const name of missingBins) rmSync(join(bin, name), { force: true });
  for (const name of missingLocalBins) rmSync(join(packageBin, name), { force: true });

  // Overlay review always runs its merge-base lint diagnostic after the selected guards. Give the
  // generated helper a minimal packaged-runtime shape and a node stub that records the call.
  const packageRoot = join(home, 'runtime');
  const baselineDir = join(home, 'baseline');
  mkdirSync(join(packageRoot, 'gate-engine', 'review'), { recursive: true });
  mkdirSync(baselineDir);
  writeFileSync(join(packageRoot, 'gate-engine', 'review', 'baseline-gate.mts'), '// test stub\n');
  if (builder === 'overlay') {
    writeFileSync(join(bin, 'node'), '#!/bin/sh\necho "baseline $*" >> "$HOME/calls.log"\n');
    chmodSync(join(bin, 'node'), 0o755);
  }

  if (pkgRel) mkdirSync(join(home, pkgRel), { recursive: true });
  const hookPath = join(home, 'pre-commit');
  const hook =
    builder === 'standalone'
      ? buildStandaloneHook(selection, pkgRel)
      : builder === 'overlay'
        ? buildOverlayHook(selection, '', pkgRel)
        : buildFullHook(selection, pkgRel);
  writeFileSync(hookPath, hook);
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(shell, ['-e', hookPath], {
      env: {
        ...process.env,
        DEVKIT_COMMIT_MSG_FILE: '',
        DEVKIT_REVIEW_BASELINE_DIR: baselineDir,
        DEVKIT_REVIEW_PACKAGE_ROOT: packageRoot,
        HOME: home,
        PATH: '/usr/bin:/bin',
        ...env,
      },
      encoding: 'utf8',
      cwd: home,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    status = e.status;
    stdout = `${e.stdout ?? ''}`;
  }
  let calls = '';
  try {
    calls = readFileSync(join(home, 'calls.log'), 'utf8');
  } catch {
    // hook never reached the stub
  }
  // `home` rides along so a test can assert on markers the stubs dropped there (the reap probe).
  return { status, stdout, calls, home };
}

describe('assembled hook execution (stubbed bins, sh -e)', () => {
  it('package mode blocks when the pinned local bin is missing instead of using a global decoy', () => {
    const r = runHook(
      {},
      { biome: false, guards: ['size'] },
      {
        missingLocalBins: ['guard-deterministic'],
      },
    );
    expect(r.status).toBe(1);
    expect(r.calls).not.toContain('guard-deterministic');
  });

  it('a deterministic failure blocks the hook (exit 1) and the AI gates never run', () => {
    const r = runHook({ DET_RC: '1' });
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-deterministic');
    // Ordinary commit/ship keeps the cost-saving fail-fast policy.
    expect(r.calls).not.toContain('guard-comments');
    expect(r.calls).not.toContain('guard-decisions');
    expect(r.calls).not.toContain('guard-review');
  });

  it('review remembers deterministic failure, runs the selected reviewer, then returns 1', () => {
    const r = runHook({
      DET_RC: '1',
      DEVKIT_RUN_MODE: 'review',
      DEVKIT_REVIEW_GUARDS: 'size,review',
    });
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-deterministic');
    expect(r.calls).toContain('guard-review --gate');
  });

  it('dry-gates remembers deterministic failure, runs comments, and skips expensive gates', () => {
    const r = runHook({
      DET_RC: '1',
      DEVKIT_RUN_MODE: 'dry-gates',
      DEVKIT_REVIEW_GUARDS: 'comments',
    });
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-deterministic');
    expect(r.calls).toContain('guard-comments gate');
    expect(r.calls).not.toContain('guard-decisions');
    expect(r.calls).not.toContain('guard-review');
    expect(r.calls).not.toContain('guard-qavis-advisory');
  });

  it('reviewer-only profile reaches the reviewer and stays green when deterministic selects none', () => {
    const r = runHook({ DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_GUARDS: 'review' });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-deterministic');
    expect(r.calls).toContain('guard-review --gate');
  });

  it('initializes remembered status per block instead of trusting an inherited shell value', () => {
    const r = runHook({
      DEVKIT_RUN_MODE: 'review',
      DEVKIT_REVIEW_GUARDS: 'size,review',
      dk_review_det_failed: '1',
    });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-review --gate');
  });

  it('AI gates remain fail-fast in review mode after a remembered deterministic failure', () => {
    const r = runHook({
      DET_RC: '1',
      COMMENTS_RC: '1',
      DEVKIT_RUN_MODE: 'review',
      DEVKIT_REVIEW_GUARDS: 'size,comments,review',
    });
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-comments gate');
    expect(r.calls).not.toContain('guard-review');
  });

  it('standalone review defers an installed deterministic failure until after the reviewer', () => {
    const r = runHook(
      { DET_RC: '1', DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_GUARDS: 'size,review' },
      undefined,
      { builder: 'standalone' },
    );
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-deterministic');
    expect(r.calls).toContain('guard-review --gate');
  });

  it('standalone review keeps missing global deterministic tooling fail-open', () => {
    const r = runHook(
      { DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_GUARDS: 'size,review' },
      undefined,
      { builder: 'standalone', missingBins: ['guard-deterministic'] },
    );
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('guard-deterministic');
    expect(r.calls).toContain('guard-review --gate');
  });

  it('overlay review runs AI and baseline diagnostics before finalizing deterministic failure', () => {
    const r = runHook(
      { DET_RC: '1', DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_GUARDS: 'size,review' },
      undefined,
      { builder: 'overlay' },
    );
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-review --gate');
    expect(r.calls).toContain('baseline');
    expect(r.calls.indexOf('guard-review --gate')).toBeLessThan(r.calls.indexOf('baseline'));
  });

  it('package-scoped review keeps the remembered status inside its failing subshell', () => {
    const r = runHook(
      { DET_RC: '1', DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_GUARDS: 'size,review' },
      undefined,
      { pkgRel: 'pkg/a' },
    );
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-review --gate');
  });

  it('a clean deterministic run lets the AI gates run', () => {
    const r = runHook({ DET_RC: '0' });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-deterministic');
    expect(r.calls).toContain('guard-comments gate');
    expect(r.calls).toContain('guard-decisions');
    expect(r.calls).toContain('guard-review');
  });

  it('review mode runs only AI gates in the explicit review allowlist', () => {
    const r = runHook({ DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_GUARDS: 'decisions' });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-deterministic');
    expect(r.calls).toContain('guard-decisions');
    expect(r.calls).not.toContain('guard-review');
  });

  it('trims review allowlist entries consistently with the deterministic parser', () => {
    const r = runHook({
      DEVKIT_RUN_MODE: 'review',
      DEVKIT_REVIEW_GUARDS: ' decisions , review ',
    });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-decisions');
    expect(r.calls).toContain('guard-review');
  });

  it('passes the resolved structure command through to the orchestrator', () => {
    const r = runHook(
      { DET_RC: '0' },
      {
        biome: false,
        guards: ALL_GUARDS,
        structureCmd: 'guard-structure gate',
      },
    );
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-deterministic --hook');
    expect(r.calls).toContain('--structure guard-structure gate');
  });

  it('guard-review exit 3 (strict fail-closed) blocks with the outage remedy, not a violation banner', () => {
    const r = runHook({ REVIEW_RC: '3' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('strict ship mode failed closed');
    expect(r.stdout).toContain('judge CLI auth/quota named above');
    expect(r.stdout).not.toMatch(/check [`]?claude/i);
    expect(r.stdout).not.toContain('escalation-confirmed');
  });

  it('guard-review exit 2 (non-strict inconclusive) fails open', () => {
    expect(runHook({ REVIEW_RC: '2' }).status).toBe(0);
  });

  it('guard-decisions exit 3 (strict fail-closed) blocks with the outage remedy', () => {
    const r = runHook({ DEC_RC: '3' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('strict ship mode failed closed');
    expect(r.stdout).not.toContain('Record the decision target');
  });

  it('guard-comments blocks before later AI gates on an unresolved finding', () => {
    const r = runHook({ COMMENTS_RC: '1' });
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-comments gate');
    expect(r.calls).not.toContain('guard-decisions');
    expect(r.calls).not.toContain('guard-review');
  });

  it('guard-comments distinguishes fail-open outage from strict/unreadable evidence', () => {
    const r = runHook({ COMMENTS_RC: '2' });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-decisions');
    expect(r.calls).toContain('guard-review');
    expect(runHook({ COMMENTS_RC: '3' }).status).toBe(1);
    expect(runHook({ COMMENTS_RC: '4' }).status).toBe(1);
  });
});

describe('parallel completeness prewarm (ship message file present)', () => {
  it('no DEVKIT_COMMIT_MSG_FILE → completeness never launched (interactive commits unchanged)', () => {
    const r = runHook();
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-review --gate');
    expect(r.calls).not.toContain('guard-review completeness');
  });

  it('with the ship message file, completeness runs alongside the fleet and a clean pair passes', () => {
    const r = runHook({}, undefined, { shipMsg: true });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-review completeness --gate');
    expect(r.calls).toContain('guard-review --gate');
  });

  it('a confident completeness FAIL (exit 1) blocks the commit at pre-commit', () => {
    const r = runHook({ COMP_RC: '1' }, undefined, { shipMsg: true });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Confirmed completeness gap');
  });

  it('completeness exit 3 (strict outage) fails closed with the remedy banner', () => {
    const r = runHook({ COMP_RC: '3' }, undefined, { shipMsg: true });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('strict ship mode failed closed');
    expect(r.stdout).toContain('Follow the judge CLI remedy printed above');
    expect(r.stdout).not.toMatch(/check [`]?claude/i);
  });

  it('completeness exit 4 (unreadable staged content) blocks and names the cause', () => {
    const r = runHook({ COMP_RC: '4' }, undefined, { shipMsg: true });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('NOT a gate rejection');
  });

  it('completeness exit 2 fails open', () => {
    expect(runHook({ COMP_RC: '2' }, undefined, { shipMsg: true }).status).toBe(0);
  });

  it('a fleet FAIL blocks as the fleet, never as the parallel completeness verdict', () => {
    const r = runHook({ REVIEW_RC: '1', COMP_RC: '1' }, undefined, { shipMsg: true });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('escalation-confirmed');
    expect(r.stdout).not.toContain('Confirmed completeness gap');
  });

  it('review mode does NOT prewarm — it exports the same env for its reviewer intent file', () => {
    const r = runHook({ DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_GUARDS: 'review' }, undefined, {
      shipMsg: true,
    });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-review --gate');
    expect(r.calls).not.toContain('guard-review completeness');
  });

  it('a message-file path that does not exist arms nothing (the -f guard, not just -n)', () => {
    const r = runHook({ DEVKIT_COMMIT_MSG_FILE: '/nonexistent/dk-msg.txt' });
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('guard-review completeness');
  });

  // The reap contract: the judge inherits git's stdout/stderr, so a hook that returns while a
  // signalled child is still winding down leaves the ship's capture reader on a pipe nobody will
  // close — commit-with-gate-capture.sh's R3 hang. Signalling alone is not enough; the harness
  // stub releases the pipe first so this asserts the HOOK waited, not that the pipe drained.
  it('a killed completeness judge is REAPED before the hook returns, not merely signalled', () => {
    const r = runHook({ REVIEW_RC: '1', COMP_SLOW_TERM: '1' }, undefined, { shipMsg: true });
    expect(r.status).toBe(1); // still the fleet's verdict
    expect(existsSync(join(r.home, 'comp-running'))).toBe(true); // the judge really did start
    // Written only by the TERM handler, after a delay: present iff the hook waited for it.
    expect(existsSync(join(r.home, 'comp-reaped'))).toBe(true);
  });

  it('the fleet failing CLOSED (exit 3) also kills and reaps — every block path, not just exit 1', () => {
    const r = runHook({ REVIEW_RC: '3', COMP_SLOW_TERM: '1' }, undefined, { shipMsg: true });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('strict ship mode failed closed');
    expect(existsSync(join(r.home, 'comp-reaped'))).toBe(true);
  });
});

describe('biome-format re-stage step (real git)', () => {
  // The re-stage step runs `git add` on files it just re-read from `git diff --cached` — for a
  // release commit that force-added a gitignored `dist/` (`git add -f dist`), a plain `git add`
  // on those same paths refuses ("ignored by gitignore", non-zero exit), and `sh -e` aborts the
  // whole hook. Needs a REAL git repo (unlike the other tests here, which stub every external
  // call): `git diff --cached` / `git add` are real git, not something bunx dispatches.
  function initRepo() {
    const repo = mkdtempSync(join(tmpdir(), 'dk-hook-git-'));
    homes.push(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'a'], { cwd: repo });
    writeFileSync(join(repo, '.gitignore'), 'dist\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    return repo;
  }

  function runInRepo(repo) {
    const home = mkdtempSync(join(tmpdir(), 'dk-hook-git-home-'));
    homes.push(home);
    const bin = join(home, '.bun', 'bin');
    const packageBin = join(repo, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(packageBin, { recursive: true });
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\nprintf \'%s\\n\' "$PWD/node_modules/.bin"\n');
    chmodSync(join(bin, 'bun'), 0o755);
    writeFileSync(join(packageBin, 'biome'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(packageBin, 'biome'), 0o755);
    const hookPath = join(home, 'pre-commit');
    writeFileSync(hookPath, buildFullHook({ biome: true, guards: [] }));
    try {
      const stdout = execFileSync('sh', ['-e', hookPath], {
        cwd: repo,
        env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout };
    } catch (e) {
      return { status: e.status, stdout: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  it('re-stages a force-added gitignored dist/ file without aborting the hook', () => {
    const repo = initRepo();
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'out.mjs'), 'export const x = 1;\n');
    execFileSync('git', ['add', '-f', 'dist/out.mjs'], { cwd: repo });

    const r = runInRepo(repo);

    expect(r.stdout).not.toContain('ignored by gitignore');
    expect(r.status).toBe(0);
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(staged).toContain('dist/out.mjs');
  });
});

describe('assembled hook — shell/OS variants', () => {
  it.runIf(hasDash)('dash (Debian/Ubuntu /bin/sh): det-gate blocking + AI ordering hold', () => {
    const opts = { shell: '/bin/dash' };
    const fail = runHook({ DET_RC: '1' }, { biome: false, guards: ALL_GUARDS }, opts);
    expect(fail.status).toBe(1);
    expect(fail.calls).not.toContain('guard-decisions');
    const clean = runHook({ DET_RC: '0' }, { biome: false, guards: ALL_GUARDS }, opts);
    expect(clean.status).toBe(0);
    expect(clean.calls).toContain('guard-review');
  });

  it('a hook path containing SPACES survives every "$0"-derived quoting seam', () => {
    // devkit itself lives under "Personal and learning/" — the harness dir gets a space too.
    const r = runHook(
      { DET_RC: '0' },
      { biome: false, guards: ALL_GUARDS },
      {
        dirPrefix: 'dk hook exec-',
      },
    );
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-deterministic --hook');
  });
});

// ── commit-terminal telemetry ──────────────────────────────────────────────────────────────
// The hook is the only process that knows the whole chain's outcome, so it emits the
// `commit_result` terminal for the every-commit telemetry run (run-context.mts contract).
// These run the ASSEMBLED hook inside a real temp git repo so attempt identity and tree correlation
// are both exercised.
describe('commit-terminal telemetry (real temp git repo)', () => {
  function runHookInRepo(env = {}, selection = { biome: false, guards: ALL_GUARDS }) {
    const home = mkdtempSync(join(tmpdir(), 'dk-hook-terminal-'));
    homes.push(home);
    const repo = join(home, 'consumer-repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'my-branch'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    // An initial commit so `git rev-parse --abbrev-ref HEAD` resolves the branch NAME (an unborn
    // branch resolves to the literal "HEAD"; a real consumer repo always has commits).
    writeFileSync(join(repo, 'init.txt'), 'init\n');
    execFileSync('git', ['add', 'init.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'staged\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    const tree = execFileSync('git', ['write-tree'], { cwd: repo, encoding: 'utf8' }).trim();
    const bin = join(home, '.bun', 'bin');
    const packageBin = join(repo, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(packageBin, { recursive: true });
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\nprintf \'%s\\n\' "$PWD/node_modules/.bin"\n');
    chmodSync(join(bin, 'bun'), 0o755);
    const localGateStub =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional shell ${VAR:-default} expansion in the stub
      '#!/bin/sh\ntool="${0##*/}"\ncase "$tool" in\n  guard-deterministic) [ "${MUTATE_TREE:-0}" = 1 ] && { printf \'later\\n\' > telemetry-restaged.txt; git add telemetry-restaged.txt; }; printf \'%s\' "$DEVKIT_COMMIT_ID" > "$HOME/gate-id"; exit ${DET_RC:-0};;\n  *) exit 0;;\nesac\n';
    for (const gate of [
      'guard-deterministic',
      'guard-comments',
      'guard-decisions',
      'guard-review',
    ]) {
      writeFileSync(join(packageBin, gate), localGateStub);
      chmodSync(join(packageBin, gate), 0o755);
    }
    const hookPath = join(home, 'pre-commit');
    writeFileSync(hookPath, buildFullHook(selection));
    const sink = join(home, 'events.jsonl');
    let status = 0;
    // vitest.setup exports DEVKIT_NO_TELEMETRY=1 suite-wide (ordinary tests must never write a
    // developer's live telemetry) — strip it here: THESE tests point the sink at a temp file and
    // exist precisely to prove the capture, so inheriting the suite opt-out would no-op them.
    const hookEnv = { ...process.env, HOME: home, PATH: '/usr/bin:/bin', DEVKIT_GATE_EVENTS: sink };
    delete hookEnv.DEVKIT_NO_TELEMETRY;
    delete hookEnv.DEVKIT_REVIEW_ID;
    delete hookEnv.DEVKIT_SHIP_ID;
    Object.assign(hookEnv, env);
    try {
      execFileSync('sh', ['-e', hookPath], {
        cwd: repo,
        env: hookEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      status = e.status;
    }
    let events = [];
    if (existsSync(sink))
      events = readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const gateId = existsSync(join(home, 'gate-id'))
      ? readFileSync(join(home, 'gate-id'), 'utf8')
      : null;
    const commitStatePath = join(repo, '.git', 'devkit-commit-attempt');
    const commitState = existsSync(commitStatePath) ? readFileSync(commitStatePath, 'utf8') : null;
    return { status, events, tree, gateId, commitState };
  }

  function expectNoCommitTerminal(result: { status: number; events: Array<{ type?: string }> }) {
    expect(result.status).toBe(0);
    expect(result.events.filter((event) => event.type === 'commit_result')).toEqual([]);
  }

  it('a passing chain gives the gate and terminal one attempt id and retains the staged tree', () => {
    const r = runHookInRepo();
    expect(r.status).toBe(0);
    const terminals = r.events.filter((e) => e.type === 'commit_result');
    expect(terminals.length).toBe(1);
    const t = terminals[0];
    expect(t.ship_id).toMatch(/^commit-run-[A-Za-z0-9-]+$/);
    expect(r.gateId).toBe(t.ship_id);
    expect(t.commit_tree).toBe(r.tree);
    expect(r.commitState).toBe(`${t.ship_id}\n${r.tree}\n`);
    expect(t.run_mode).toBe('commit');
    expect(t.exit_code).toBe(0);
    expect(t.repo).toBe('consumer-repo');
    expect(t.branch).toBe('my-branch');
    expect(typeof t.duration_s).toBe('number');
    expect(t.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('two attempts with identical staged content receive distinct ids', () => {
    const first = runHookInRepo();
    const second = runHookInRepo();
    expect(second.tree).toBe(first.tree);
    expect(second.events[0].ship_id).not.toBe(first.events[0].ship_id);
  });

  it('refreshes the handoff tree after a gate restages content', () => {
    const r = runHookInRepo({ MUTATE_TREE: '1' });
    const terminal = r.events.find((event) => event.type === 'commit_result');
    expect(terminal.commit_tree).not.toBe(r.tree);
    expect(r.commitState).toBe(`${terminal.ship_id}\n${terminal.commit_tree}\n`);
  });

  it('a gate-blocked chain (deterministic exit 1) emits commit_result exit_code 1', () => {
    const r = runHookInRepo({ DET_RC: '1' });
    expect(r.status).toBe(1);
    const t = r.events.filter((e) => e.type === 'commit_result');
    expect(t.length).toBe(1);
    expect(t[0].exit_code).toBe(1);
    expect(r.commitState).toBeNull();
  });

  it('does not leave a handoff when no commit-msg judge is selected', () => {
    const r = runHookInRepo({}, { biome: false, guards: ['size'] });
    expect(r.status).toBe(0);
    expect(r.commitState).toBeNull();
  });

  it('inside a ship (DEVKIT_SHIP_ID set) the hook stays silent — ship_result is that terminal', () => {
    expectNoCommitTerminal(runHookInRepo({ DEVKIT_SHIP_ID: 'some-ship' }));
  });

  it('inside a review (DEVKIT_REVIEW_ID set) the hook stays silent — review events own that run', () => {
    expectNoCommitTerminal(
      runHookInRepo({
        DEVKIT_REVIEW_ID: 'some-review',
        DEVKIT_RUN_MODE: 'review',
        DEVKIT_REVIEW_GUARDS: '',
      }),
    );
  });

  it('DEVKIT_NO_TELEMETRY opts the terminal out with the capture itself', () => {
    expectNoCommitTerminal(runHookInRepo({ DEVKIT_NO_TELEMETRY: '1' }));
  });
});
