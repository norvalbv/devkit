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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFullHook, buildOverlayHook, buildStandaloneHook } from '../lib/husky/husky-block.mts';

// Runs an ASSEMBLED hook under a real `sh -e` with per-tool stubs whose exit codes come from env
// knobs; every invocation lands in calls.log, so ordering is read off the log.

export const homes = [];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ALL_GUARDS = ['size', 'fanout', 'dup', 'clone', 'comments', 'decisions', 'review'];

// Hooks run under whatever /bin/sh the OS ships — dash on Debian/Ubuntu, bash on macOS. The
// fragments are POSIX sh; prove it where dash is installed instead of assuming.
export const hasDash = existsSync('/bin/dash');

// Stubs log to calls.log and exit with the named env knob, so ordering is read off the log.
function writeStub(path, name, rcVar) {
  writeFileSync(
    path,
    `#!/bin/sh\necho "${name} $*" >> "$HOME/calls.log"\ncat >/dev/null\nexit \${${rcVar}:-0}\n`,
  );
  chmodSync(path, 0o755);
}

// Overlay staged-gate fixtures. fallow is global ($HOME/.bun/bin, first on the hook's PATH), where a
// consumer's `command -v fallow` finds it; eslint is the repo-local bin the overlay step requires.
function stageOverlayFixtures(
  home,
  { bin, packageBin, pkgRel, fallow, staged, eslintOverlay, stagedBytes, unstagedDebt },
) {
  if (fallow) {
    // Keeps the diff fallow was handed, so a test can assert WHAT it scoped, not just that it ran.
    writeFileSync(
      join(bin, 'fallow'),
      `#!/bin/sh\necho "fallow $*" >> "$HOME/calls.log"\ncat > "$HOME/fallow-stdin"\nexit \${FALLOW_RC:-0}\n`,
    );
    chmodSync(join(bin, 'fallow'), 0o755);
  }
  if (eslintOverlay) {
    writeFileSync(join(home, 'eslint.config.devkit.mjs'), 'export default [];\n');
    writeStub(join(packageBin, 'eslint'), 'eslint', 'ESLINT_RC');
  }
  if (!staged) return;
  // Outside a repo `git diff --cached` fails and the hook exits before fallow/eslint run, so an
  // ordering assertion would pass vacuously.
  const src = join(pkgRel ? join(home, pkgRel) : home, 'src');
  mkdirSync(src, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: home });
  if (staged === 'none') return;
  if (unstagedDebt) {
    // A TRACKED file with unstaged edits — another agent's work in a shared tree.
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: home });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: home });
    writeFileSync(join(src, 'other.ts'), 'export const a = 1;\n');
    execFileSync('git', ['add', join(src, 'other.ts')], { cwd: home });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: home });
    writeFileSync(join(src, 'other.ts'), 'export const a = 1;\nexport const unstagedDebt = 2;\n');
  }
  const body = stagedBytes
    ? '// padding line for the diff-size cap\n'.repeat(Math.ceil(stagedBytes / 38))
    : 'export const unused = 1;\n';
  writeFileSync(join(src, 'staged.ts'), body);
  execFileSync('git', ['add', join(src, 'staged.ts')], { cwd: home });
}

export function runHook(
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
    realDeterministic = false,
    fallow = false,
    staged = false,
    eslintOverlay = false,
    stagedBytes = 0,
    unstagedDebt = false,
    binStubs = {},
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
        # COMP_FIRST: the ordering the narration tests depend on — this judge REACHES ITS VERDICT
        # before the fleet blocks, so the hook reaps an already-exited child (status = COMP_RC)
        # rather than killing one mid-judgement (status 143). Without the sentinel the two race,
        # and the test passes or fails on scheduler luck.
        [ -n "\${COMP_FIRST:-}" ] && echo done > "$HOME/comp-exited"
        exit \${COMP_RC:-0};;
      *)
        if [ -n "\${COMP_FIRST:-}" ]; then
            i=0
            while [ ! -f "$HOME/comp-exited" ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i+1)); done
            sleep 0.2
        fi
        [ -n "\${COMP_SLOW_TERM:-}" ] && sleep 0.1; exit \${REVIEW_RC:-0};;
    esac;;
  guard-sentry) echo "guard-sentry-argc $#" >> "$HOME/calls.log"; exit \${SENTRY_RC:-0};;
  guard-qavis-advisory) exit \${QAVIS_RC:-0};;
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
    'guard-sentry',
  ]) {
    writeFileSync(join(bin, name), gateStub);
    chmodSync(join(bin, name), 0o755);
    if (name !== 'bunx') {
      writeFileSync(join(packageBin, name), gateStub);
      chmodSync(join(packageBin, name), 0o755);
    }
  }
  for (const name of missingBins) rmSync(join(bin, name), { force: true });
  // Extra tools shadowed on the hook's PATH (first entry), e.g. a broken `wc`.
  for (const [name, body] of Object.entries(binStubs)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  for (const name of missingLocalBins) rmSync(join(packageBin, name), { force: true });

  if (realDeterministic) {
    const runner = join(ROOT, 'gate-engine', 'deterministic', 'run.mts');
    const nodeShim = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`;
    const runnerShim = `#!/bin/sh\necho "guard-deterministic $*" >> "$HOME/calls.log"\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(runner)} "$@"\n`;
    writeFileSync(join(bin, 'node'), nodeShim);
    chmodSync(join(bin, 'node'), 0o755);
    for (const target of [
      join(bin, 'guard-deterministic'),
      join(packageBin, 'guard-deterministic'),
    ]) {
      writeFileSync(target, runnerShim);
      chmodSync(target, 0o755);
    }

    const repo = pkgRel ? join(home, pkgRel) : home;
    mkdirSync(join(repo, '.devkit'), { recursive: true });
    writeFileSync(
      join(repo, '.devkit', 'config.json'),
      `${JSON.stringify({ components: { guards: [], antiSlop: true } })}\n`,
    );
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['add', '.devkit/config.json'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'finding.ts'), 'export const value: unknown = 1;\n');
    execFileSync('git', ['add', 'src/finding.ts'], { cwd: repo });
  }

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
  stageOverlayFixtures(home, {
    bin,
    packageBin,
    pkgRel,
    fallow,
    staged,
    eslintOverlay,
    stagedBytes,
    unstagedDebt,
  });
  const hookPath = join(home, 'pre-commit');
  const hook =
    builder === 'standalone'
      ? buildStandaloneHook(selection, pkgRel)
      : builder === 'overlay'
        ? buildOverlayHook(selection, '', pkgRel, { fallow })
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

export function cleanupHomes() {
  while (homes.length) rmSync(homes.pop(), { recursive: true, force: true });
}
