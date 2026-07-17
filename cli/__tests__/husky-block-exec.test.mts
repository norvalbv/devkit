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
import { buildFullHook } from '../lib/husky/husky-block.mts';

// Execute the ASSEMBLED hook under a real `sh -e` with a stub `bunx` that dispatches per tool
// (exit codes via env knobs) and logs every invocation. The hook now delegates the whole
// deterministic set (prefix cache → guards → structure → aggregation) to the single
// `guard-deterministic` orchestrator, so its internal trichotomy/aggregation is proven in
// gate-engine/deterministic/__tests__/run.test.mjs. THIS harness proves the SHELL contract the
// hook still owns: the orchestrator gates the AI fragments (`|| exit 1`), the AI gates stay
// fail-fast with their outage remedies, and it all survives dash + a hook path with spaces.

const homes = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop(), { recursive: true, force: true });
});

const ALL_GUARDS = ['size', 'fanout', 'dup', 'clone', 'decisions', 'review'];

// Hooks run under whatever /bin/sh the OS ships — dash on Debian/Ubuntu, bash on macOS. The
// fragments are POSIX sh; prove it where dash is installed instead of assuming.
const hasDash = existsSync('/bin/dash');

function runHook(
  env = {},
  selection = { biome: false, guards: ALL_GUARDS },
  { shell = 'sh', dirPrefix = 'dk-hook-exec-' } = {},
) {
  const home = mkdtempSync(join(tmpdir(), dirPrefix));
  homes.push(home);
  const bin = join(home, '.bun', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'bunx'),
    `#!/bin/sh
tool="$1"; shift
echo "$tool $*" >> "$HOME/calls.log"
case "$tool" in
  guard-deterministic) exit \${DET_RC:-0};;
  guard-decisions) exit \${DEC_RC:-0};;
  guard-review) exit \${REVIEW_RC:-0};;
  *) exit 0;;
esac
`,
  );
  chmodSync(join(bin, 'bunx'), 0o755);
  const hookPath = join(home, 'pre-commit');
  writeFileSync(hookPath, buildFullHook(selection));
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(shell, ['-e', hookPath], {
      env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin', ...env },
      encoding: 'utf8',
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
  return { status, stdout, calls };
}

describe('assembled hook execution (stubbed bunx, sh -e)', () => {
  it('a deterministic failure blocks the hook (exit 1) and the AI gates never run', () => {
    const r = runHook({ DET_RC: '1' });
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-deterministic');
    // `guard-deterministic … || exit 1` — a doomed commit never pays for a judge.
    expect(r.calls).not.toContain('guard-decisions');
    expect(r.calls).not.toContain('guard-review');
  });

  it('a clean deterministic run lets the AI gates run', () => {
    const r = runHook({ DET_RC: '0' });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-deterministic');
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
    expect(r.stdout).not.toContain('opus-confirmed');
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
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'bunx'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'bunx'), 0o755);
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
// These run the ASSEMBLED hook inside a real temp git repo so `git write-tree` correlates.
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
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'bunx'),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional shell ${VAR:-default} expansion in the stubbed bunx script
      '#!/bin/sh\ntool="$1"; shift\ncase "$tool" in\n  guard-deterministic) exit ${DET_RC:-0};;\n  *) exit 0;;\nesac\n',
    );
    chmodSync(join(bin, 'bunx'), 0o755);
    const hookPath = join(home, 'pre-commit');
    writeFileSync(hookPath, buildFullHook(selection));
    const sink = join(home, 'events.jsonl');
    let status = 0;
    // vitest.setup exports DEVKIT_NO_TELEMETRY=1 suite-wide (ordinary tests must never write a
    // developer's live telemetry) — strip it here: THESE tests point the sink at a temp file and
    // exist precisely to prove the capture, so inheriting the suite opt-out would no-op them.
    const hookEnv = { ...process.env, HOME: home, PATH: '/usr/bin:/bin', DEVKIT_GATE_EVENTS: sink };
    delete hookEnv.DEVKIT_NO_TELEMETRY;
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
    return { status, events, tree };
  }

  it('a passing chain emits ONE commit_result correlated to the staged write-tree', () => {
    const r = runHookInRepo();
    expect(r.status).toBe(0);
    const terminals = r.events.filter((e) => e.type === 'commit_result');
    expect(terminals.length).toBe(1);
    const t = terminals[0];
    expect(t.ship_id).toBe(`commit-${r.tree}`); // same id the gates' run-context derives
    expect(t.run_mode).toBe('commit');
    expect(t.exit_code).toBe(0);
    expect(t.repo).toBe('consumer-repo');
    expect(t.branch).toBe('my-branch');
    expect(typeof t.duration_s).toBe('number');
    expect(t.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('a gate-blocked chain (deterministic exit 1) emits commit_result exit_code 1', () => {
    const r = runHookInRepo({ DET_RC: '1' });
    expect(r.status).toBe(1);
    const t = r.events.filter((e) => e.type === 'commit_result');
    expect(t.length).toBe(1);
    expect(t[0].exit_code).toBe(1);
  });

  it('inside a ship (DEVKIT_SHIP_ID set) the hook stays silent — ship_result is that terminal', () => {
    const r = runHookInRepo({ DEVKIT_SHIP_ID: 'some-ship' });
    expect(r.status).toBe(0);
    expect(r.events.filter((e) => e.type === 'commit_result').length).toBe(0);
  });

  it('DEVKIT_NO_TELEMETRY opts the terminal out with the capture itself', () => {
    const r = runHookInRepo({ DEVKIT_NO_TELEMETRY: '1' });
    expect(r.status).toBe(0);
    expect(r.events.filter((e) => e.type === 'commit_result').length).toBe(0);
  });
});
