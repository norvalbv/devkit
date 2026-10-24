import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MIN_TIMEOUT_S, parseTimeoutSeconds, VERDICT_PREFIX } from '../lib/ship/wait-ci/wait.mts';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  bodyUpdateRepo,
  buildAndRun,
  FLAG_RE,
  ghStub,
  reshipScript,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

/**
 * `URL.pathname` is percent-ENCODED, so a checkout under a path with a space resolves to nothing and
 * every bash body below sources a file that is not there. Resolve it properly, and prove it exists.
 */
function shipLibDir(): string {
  const dir = fileURLToPath(new URL('../lib/ship/', import.meta.url));
  expect(existsSync(join(dir, 'wait-ci/args.sh')), `ship lib not found at ${dir}`).toBe(true);
  return dir;
}

const PR_URL = 'https://github.com/acme/app/pull/42';
const argvLog = () => join(mkdtempSync(join(tmpdir(), 'gh-argv-')), 'argv.txt');
const lines = (log: string) => readFileSync(log, 'utf8').split('\n').filter(Boolean);

/** Logs every `gh pr …` argv, answers `pr create` with a URL and `pr checks` with real gh JSON. */
const ghChecksStub = (log: string, rows: string) =>
  ghStub(
    `printf '%s\\n' "$*" >> '${log}'
      case "$2" in
        checks) printf '%s' '${rows}' ;;
        *) echo "${PR_URL}" ;;
      esac`,
  );

const GREEN = '[{"bucket":"pass","name":"gate","state":"SUCCESS","link":"","workflow":"gate"}]';
const RED =
  '[{"bucket":"fail","name":"gate","state":"FAILURE","link":"https://x/1","workflow":"gate"}]';

/** A settled verdict in milliseconds: the module is bounded by wall clock, not by poll count. */
const FAST = { DEVKIT_WAIT_CI_INTERVAL_MS: '5', DEVKIT_WAIT_CI_SETTLE_MS: '1' };

function ship(argv: string[], log: string, rows = GREEN, extraEnv: Record<string, string> = {}) {
  const { dir, env } = seedShipRepoLocalRemote();
  writeFileSync(join(dir, 'note.txt'), 'hello\n');
  const r = spawnSync('/bin/bash', [scriptPath, ...argv], {
    cwd: dir,
    input: 'b\n',
    encoding: 'utf8',
    env: {
      ...env,
      ...FAST,
      ...extraEnv,
      PATH: `${ghChecksStub(log, rows)}:${process.env.PATH}`,
    },
  });
  return { dir, r };
}

describe('wait.mts — an early red through the real gh exec', () => {
  it('reads the failed step of a still-running job from gh exit 8 and reports it red at once', () => {
    // Unit tests stub the exec; this proves the CLI entrypoint wires poller, steps and attribution.
    const bin = mkdtempSync(join(tmpdir(), 'gh-early-'));
    const link = 'https://github.com/acme/app/actions/runs/9/job/42';
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh
case "$1" in
  pr) printf '%s' '[{"bucket":"pending","name":"gate","state":"IN_PROGRESS","link":"${link}","workflow":"gate"}]'; exit 8 ;;
  api) printf '%s' '{"jobs":[{"id":42,"steps":[{"name":"Lint (Oxlint)","conclusion":"failure"}]}]}' ;;
esac
`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const wait = fileURLToPath(new URL('../lib/ship/wait-ci/wait.mts', import.meta.url));
    const r = spawnSync(
      process.execPath,
      [wait, '--pr', '42', '--repo', 'acme/app', '--timeout', String(MIN_TIMEOUT_S)],
      {
        cwd: bin,
        encoding: 'utf8',
        env: { ...process.env, ...FAST, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(
      `ci-outcome=failed pr=42 failing=gate:${link} failed-steps=gate › Lint (Oxlint)` +
        ' attribution=unknown reason=run-in-progress',
    );
  });
});

describe('ship-branch.sh — --wait-ci refusals', () => {
  const refuse = (extraArgs: string[]) =>
    buildAndRun('main', 'git@github.com:acme/app.git', { extraArgs });

  it.each([
    [
      'a timeout with no --wait-ci',
      ['--wait-ci-timeout', '900'],
      /has no effect without --wait-ci/,
    ],
    [
      'a non-numeric timeout',
      ['--wait-ci', '--wait-ci-timeout', 'soon'],
      /whole number of seconds/,
    ],
    ['a timeout under the floor', ['--wait-ci', '--wait-ci-timeout', '10'], /must be between/],
    ['a timeout over the ceiling', ['--wait-ci', '--wait-ci-timeout', '7201'], /must be between/],
    ['--wait-ci with --dry-gates', ['--wait-ci', '--dry-gates'], /never opens a PR/],
  ])('refuses %s by name', (_label, extraArgs, message) => {
    const r = refuse(extraArgs);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(message);
    // A named refusal, never the generic fallthrough that would mean the flag was never parsed.
    expect(r.stderr).not.toMatch(FLAG_RE);
  });

  it('rejects a flag sitting in a positional slot instead of shipping a branch called --wait-ci', () => {
    const r = buildAndRun('main', 'git@github.com:acme/app.git', {
      argv: ['--wait-ci', 'title', 'note.txt'],
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/must come FIRST, before any flag/);
  });

  it('accepts --wait-ci under --resume, where the record cannot carry it', () => {
    // Decision: the wait observes a PR that already exists, so it is one-shot like --ready and is
    // re-requested on a retry rather than replayed.
    const r = buildAndRun('main', 'git@github.com:acme/app.git', {
      argv: ['--resume', 'feat/never-shipped', '--wait-ci'],
    });
    expect(r.stderr).not.toMatch(FLAG_RE);
    expect(r.stderr).not.toMatch(/has no effect without --wait-ci/);
  });
});

describe('ship-branch.sh — --wait-ci', () => {
  it('polls the PR it just opened, and only after opening it', () => {
    const log = argvLog();
    const { r } = ship(['feat/ci', 't', '--wait-ci', 'note.txt'], log);
    expect(r.status, r.stderr).toBe(0);

    const calls = lines(log);
    const created = calls.findIndex((l) => l.startsWith('pr create'));
    const checked = calls.findIndex((l) => l.startsWith('pr checks'));
    expect(created).toBeGreaterThanOrEqual(0);
    expect(checked).toBeGreaterThan(created);
    // ALL checks, never --required: an unprotected branch reports an EMPTY required set, which
    // would render a red PR green.
    expect(calls[checked]).not.toContain('--required');
    // The required-set reads belong to --wait-ci-required alone.
    expect(calls.filter((l) => l.includes('baseRefName'))).toEqual([]);
    expect(r.stderr).toContain('ship: ci-outcome=passed pr=42');
  });

  it('leaves the immediate return untouched when the flag is absent', () => {
    const log = argvLog();
    const { r } = ship(['feat/plain', 't', 'note.txt'], log);
    expect(r.status, r.stderr).toBe(0);
    expect(lines(log).some((l) => l.startsWith('pr checks'))).toBe(false);
    expect(r.stderr).not.toContain('ci-outcome=');
  });

  it('still exits 0 with the PR URL on stdout when CI is red', () => {
    // The whole contract: a red PR is not a failed ship. An agent that read non-zero here would
    // retry --resume against a record the push already deleted.
    const log = argvLog();
    const { r } = ship(['feat/red', 't', '--wait-ci', 'note.txt'], log, RED);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(PR_URL);
    expect(r.stderr).toContain('ci-outcome=failed pr=42 failing=gate:https://x/1');
    // Every line the wait writes goes to stderr, so a caller reading stdout for the PR URL is
    // unaffected by it.
    expect(r.stdout).not.toContain('ci-outcome=');
    expect(r.stdout).not.toContain('ci: ');
  });

  it('ends red while another check still runs, and does not attribute an unfinished run', () => {
    const log = argvLog();
    const redAndRunning =
      '[{"bucket":"fail","name":"gate","state":"FAILURE","link":"https://x/1","workflow":"gate"},' +
      '{"bucket":"pending","name":"e2e","state":"IN_PROGRESS","link":"","workflow":"e2e"}]';
    const { r } = ship(['feat/early-red', 't', '--wait-ci', 'note.txt'], log, redAndRunning);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(
      'ci-outcome=failed pr=42 failing=gate:https://x/1 attribution=unknown reason=run-in-progress',
    );
  });

  it('announces that the PR is open before it starts waiting', () => {
    // A signal during the wait exits 130 through the managed wrapper whatever bash does, so the
    // abort has to be self-describing before it can happen.
    const log = argvLog();
    const { r } = ship(['feat/announce', 't', '--wait-ci', 'note.txt'], log);
    const announced = r.stderr.indexOf('the ship is complete');
    const verdict = r.stderr.indexOf('ci-outcome=');
    expect(announced).toBeGreaterThanOrEqual(0);
    expect(verdict).toBeGreaterThan(announced);
  });

  it('reports not-run rather than silence when there is no PR to wait on', () => {
    const log = argvLog();
    const { r } = ship(['feat/dry', 't', '--wait-ci', 'note.txt'], log, GREEN, {
      SHIP_DRY_RUN: '1',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('ci-outcome=not-run pr=? reason=dry-run-opened-no-pr');
  });

  it('names the reason instead of guessing when gh cannot answer', () => {
    const log = argvLog();
    const { r } = ship(['feat/badjson', 't', '--wait-ci', 'note.txt'], log, 'not json');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('ci-outcome=unavailable pr=42 reason=gh-json-unparseable');
  });
});

describe('reship.sh — --wait-ci', () => {
  it('refuses an incoherent timeout the same way a new ship does', () => {
    const r = buildAndRun('main', 'git@github.com:acme/app.git', {
      script: reshipScript,
      argv: ['feat/x', 't', '--pr', '--wait-ci', '--wait-ci-timeout', '1', '--', 'note.txt'],
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/must be between/);
    expect(r.stderr).not.toMatch(FLAG_RE);
  });
});

describe('reship.sh — --wait-ci after a real re-push', () => {
  const CHECKS = { GH_CHECKS_JSON: GREEN, ...FAST };

  it('polls the PR it just re-pushed to', () => {
    const { dir, env, ghLog } = bodyUpdateRepo();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = spawnSync(
      '/bin/bash',
      [reshipScript, 'feat/pr', 'add v2', '--pr', '--wait-ci', '--', 'a.ts'],
      { cwd: dir, input: 'body\n', encoding: 'utf8', env: { ...process.env, ...env, ...CHECKS } },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(ghLog, 'utf8')).toContain('pr checks 7');
    expect(r.stderr).toContain('ship: ci-outcome=passed pr=7');
  });

  it('skips the wait and says so when the --ready flip failed', () => {
    // The operator has an actionable `gh pr ready` remedy on stderr; burying it under minutes of
    // polling on a PR that is in the wrong state helps nobody.
    const { dir, env, ghLog } = bodyUpdateRepo();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = spawnSync(
      '/bin/bash',
      [reshipScript, 'feat/pr', 'add v2', '--pr', '--ready', '--wait-ci', '--', 'a.ts'],
      {
        cwd: dir,
        input: 'body\n',
        encoding: 'utf8',
        env: { ...process.env, ...env, ...CHECKS, GH_READY_STATUS: '1' },
      },
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ci-outcome=not-run pr=7 reason=ready-flip-failed');
    expect(readFileSync(ghLog, 'utf8')).not.toContain('pr checks');
  });
});

describe('ship_run_wait_ci', () => {
  it('never lets a failing wait abort the script that called it', () => {
    // Both callers run under `set -euo pipefail`, so a crashed or signal-killed node would take a
    // fully successful ship down with it.
    const binDir = mkdtempSync(join(tmpdir(), 'wait-ci-node-'));
    writeFileSync(join(binDir, 'node'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    const shipLib = shipLibDir();

    const r = spawnSync(
      '/bin/bash',
      [
        '-c',
        `set -euo pipefail
SCRIPT_DIR='${shipLib}'
. "$SCRIPT_DIR/wait-ci/args.sh"
ship_run_wait_ci 42 acme/app 900 https://x/42
echo REACHED_NEXT_LINE`,
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('REACHED_NEXT_LINE');
  });
});

describe('the timeout floor', () => {
  it('is the same number in bash and in the module', () => {
    // Two languages, one rule: below the floor a no-checks verdict is unreachable and a CI-less
    // repo would report a timeout instead.
    const helper = readFileSync(new URL('../lib/ship/wait-ci/args.sh', import.meta.url), 'utf8');
    expect(helper).toContain(`SHIP_WAIT_CI_MIN_S=${MIN_TIMEOUT_S}`);
  });
});

describe('--wait-ci-timeout boundary values', () => {
  // The bash validator is a SECOND implementation of the module's bounds, so its inclusive edges
  // need their own proof — an off-by-one there refuses a legal timeout the help documents.
  const shipLib = shipLibDir();
  const validate = (timeout: string) =>
    spawnSync(
      '/bin/bash',
      [
        '-c',
        `SCRIPT_DIR='${shipLib}'
. "$SCRIPT_DIR/wait-ci/args.sh"
ship_validate_wait_ci 1 '${timeout}' 1 0`,
      ],
      { encoding: 'utf8' },
    );

  it.each([
    ['the floor itself', '60', 0],
    ['the ceiling itself', '7200', 0],
    ['one below the floor', '59', 1],
    ['one above the ceiling', '7201', 1],
  ])('accepts/refuses %s', (_label, timeout, status) => {
    expect(validate(timeout).status).toBe(status);
  });

  it('refuses a negative timeout as non-numeric rather than comparing it', () => {
    // `-60` would pass a naive `-lt` guard as a number; the digit check has to catch it first.
    const r = validate('-60');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/whole number of seconds/);
  });
});

describe('the ci-outcome prefix', () => {
  it('is the same string in bash and in the module', () => {
    // ship-branch.sh echoes the not-run line itself, so a change to VERDICT_PREFIX would silently
    // leave the two halves of one contract disagreeing.
    const helper = readFileSync(new URL('../lib/ship/wait-ci/args.sh', import.meta.url), 'utf8');
    expect(helper).toContain(`echo "${VERDICT_PREFIX}not-run`);
  });
});

describe('an unresolvable PR number', () => {
  it('still emits exactly one ci-outcome line instead of waiting on nothing', () => {
    // gh printing a URL whose trailing segment is not a number leaves PR_NUM empty; the wait must
    // say so rather than go silent, or a caller cannot tell "skipped" from "ship died".
    const shipLib = shipLibDir();
    const r = spawnSync(
      '/bin/bash',
      [
        '-c',
        `set -euo pipefail
SCRIPT_DIR='${shipLib}'
. "$SCRIPT_DIR/wait-ci/args.sh"
ship_run_wait_ci "" acme/app 900 https://github.com/acme/app/pull/not-a-number
echo REACHED_NEXT_LINE`,
      ],
      { encoding: 'utf8' },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('ship: ci-outcome=not-run pr=? reason=pr-number-unresolved');
    expect(r.stderr.match(/ci-outcome=/g)).toHaveLength(1);
    expect(r.stdout).toContain('REACHED_NEXT_LINE');
  });
});

describe('the reship publish mutex', () => {
  it('is released before the wait on every arm, so a poll cannot block a same-branch --pr', () => {
    // The wait polls for up to WAIT_CI_TIMEOUT (7200s max). Holding the per-branch publish lock
    // across it rejects a concurrent `devkit ship --pr` after its 30s spin, over a ~1s mutation.
    const reship = readFileSync(new URL('../lib/ship/reship.sh', import.meta.url), 'utf8');
    const lines = reship.split('\n');
    const waitCalls = lines.flatMap((l, i) =>
      l.includes('ship_run_wait_ci "$PR_NUM"') ? [i] : [],
    );
    expect(waitCalls.length).toBeGreaterThan(0);

    for (const at of waitCalls) {
      const before = lines.slice(0, at);
      const lastAcquire = before.findLastIndex((l) => l.includes('rewrite_publish_lock_acquire'));
      const lastRelease = before.findLastIndex((l) => l.includes('rewrite_publish_lock_release'));
      // Either the lock was never taken on this path, or its release already happened above.
      expect(
        lastRelease,
        `wait at reship.sh:${at + 1} runs inside the publish lock`,
      ).toBeGreaterThan(lastAcquire);
    }
  });
});

describe('the bash timeout validator reads base 10', () => {
  // `[ 09000 -lt 60 ]` reads octal in bash's arithmetic evaluator: the comparison errors to false,
  // so a value wait.mts rejects passes here and the wait is skipped with no ci-outcome line.
  const shipLib = shipLibDir();
  const validate = (timeout: string) =>
    spawnSync(
      '/bin/bash',
      [
        '-c',
        `SCRIPT_DIR='${shipLib}'
. "$SCRIPT_DIR/wait-ci/args.sh"
ship_validate_wait_ci 1 '${timeout}' 1 0`,
      ],
      { encoding: 'utf8' },
    );

  it.each([
    ['refuses a leading-zero value over the ceiling', '09000', 1],
    ['accepts a leading-zero value inside the range', '0070', 0],
    ['accepts a leading-zero floor', '060', 0],
  ])('%s', (_label, timeout, status) => {
    expect(validate(timeout).status).toBe(status);
  });

  it('agrees with the module on every value it accepts', () => {
    // Divergence here is what makes the wait skip silently, so the two parsers are compared directly.
    for (const raw of ['060', '0070', '900', '7200', '09000', '0', '59', '7201']) {
      const bashOk = validate(raw).status === 0;
      expect(parseTimeoutSeconds(raw) !== null, `disagreed on '${raw}'`).toBe(bashOk);
    }
  });
});

describe('the ephemeral worktree', () => {
  it('is released before every reship wait, so a concurrent same-branch ship is not refused', () => {
    // The run record inside the worktree is what ship_reclaim_orphan_worktrees matches on. Holding
    // it across a poll of up to 7200s refuses a concurrent `devkit ship --pr` for the whole bound.
    const reship = readFileSync(new URL('../lib/ship/reship.sh', import.meta.url), 'utf8');
    const lines = reship.split('\n');
    const waits = lines.flatMap((l, i) => (l.includes('ship_run_wait_ci "$PR_NUM"') ? [i] : []));
    expect(waits.length).toBeGreaterThan(0);
    for (const at of waits) {
      const released = lines
        .slice(0, at)
        .findLastIndex((l) => l.includes('reship_release_worktree_for_wait'));
      expect(released, `wait at reship.sh:${at + 1} still holds the worktree`).toBeGreaterThan(0);
    }
  });
});

describe('--wait-ci-required', () => {
  /** gh as an UNPROTECTED repo answers: red unfiltered, and exit 1 "no required checks" when narrowed. */
  const unprotectedStub = (log: string) =>
    ghStub(
      `printf '%s\\n' "$*" >> '${log}'
      case " $* " in *" baseRefName "*) echo main; exit 0 ;; esac
      case "$2" in
        checks)
          case " $* " in *" --required "*) echo "no required checks reported on the 'x' branch" >&2; exit 1 ;; esac
          printf '%s' '${RED}' ;;
        *) echo "${PR_URL}" ;;
      esac`,
    );

  it.each([
    ['new ship', undefined],
    ['re-push', reshipScript],
  ])('is refused without --wait-ci on a %s', (_label, script) => {
    const r = buildAndRun('main', 'git@github.com:acme/app.git', {
      ...(script
        ? {
            script,
            argv: ['feat/x', 't', '--pr', '--wait-ci-required', '--', 'note.txt'],
          }
        : { extraArgs: ['--wait-ci-required'] }),
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--wait-ci-required has no effect without --wait-ci/);
    expect(r.stderr).not.toMatch(FLAG_RE);
  });

  it('is rejected in a positional slot instead of shipping a branch named after it', () => {
    const r = buildAndRun('main', 'git@github.com:acme/app.git', {
      argv: ['--wait-ci-required', 'title', 'note.txt'],
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/must come FIRST, before any flag/);
  });

  it('is accepted under --resume, where the record cannot carry it', () => {
    const r = buildAndRun('main', 'git@github.com:acme/app.git', {
      argv: ['--resume', 'feat/never-shipped', '--wait-ci', '--wait-ci-required'],
    });
    expect(r.stderr).not.toMatch(FLAG_RE);
    expect(r.stderr).not.toMatch(/has no effect without --wait-ci/);
  });

  it('reports no-checks, never passed, for a red PR on a repo without branch protection', () => {
    const log = argvLog();
    const { dir, env } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/req', 't', '--wait-ci', '--wait-ci-required', 'note.txt'],
      {
        cwd: dir,
        input: 'b\n',
        encoding: 'utf8',
        env: {
          ...env,
          ...FAST,
          PATH: `${unprotectedStub(log)}:${process.env.PATH}`,
        },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(lines(log).find((l) => l.startsWith('pr checks'))).toContain('--required');
    // The set read ran: ghStub answers `gh api` with an empty set, i.e. an unprotected base.
    expect(lines(log).some((l) => l.includes('--json baseRefName'))).toBe(true);
    expect(r.stderr).toContain(
      'ship: ci-outcome=no-checks pr=42 scope=required required-contexts=0 checks=0',
    );
    expect(r.stderr).not.toContain('ci-outcome=passed');
  });

  it.each([
    ['the plain re-push', []],
    ['the --ready flip', ['--ready']],
  ])('reaches gh from %s', (_label, extra) => {
    const { dir, env, ghLog } = bodyUpdateRepo();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    const r = spawnSync(
      '/bin/bash',
      [
        reshipScript,
        'feat/pr',
        'add v2',
        '--pr',
        ...extra,
        '--wait-ci',
        '--wait-ci-required',
        '--',
        'a.ts',
      ],
      {
        cwd: dir,
        input: 'body\n',
        encoding: 'utf8',
        env: {
          ...process.env,
          ...env,
          GH_CHECKS_JSON: GREEN,
          GH_REQUIRED_CONTEXTS: 'gate',
          ...FAST,
        },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(ghLog, 'utf8')).toMatch(/^pr checks 7 .*--required$/m);
    expect(readFileSync(ghLog, 'utf8')).toMatch(
      /^api --paginate repos\/acme\/app\/rules\/branches\/main /m,
    );
    expect(r.stderr).toContain(
      'ship: ci-outcome=passed pr=7 scope=required required-contexts=1 checks=1',
    );
  });
});

const STRICT = ['--wait-ci', '--wait-ci-strict'];

function strictShip(flags: string[], rows: string, env: Record<string, string> = {}) {
  return ship(['feat/strict', 't', ...flags, 'note.txt'], argvLog(), rows, env).r;
}

/** A --pr re-push of feat/pr; `edit` false leaves a.ts unchanged, so only a --body can publish. */
function strictReship(argv: string[], env: Record<string, string>, edit = true) {
  const { dir, env: repoEnv, ghBody } = bodyUpdateRepo();
  if (edit) writeFileSync(join(dir, 'a.ts'), 'v2\n');
  const r = spawnSync('/bin/bash', [reshipScript, 'feat/pr', 'add v2', '--pr', ...argv], {
    cwd: dir,
    input: 'body\n',
    encoding: 'utf8',
    env: { ...process.env, ...repoEnv, ...FAST, ...env },
  });
  return { r, ghBody };
}

/** Runs the wait against a `node` that exits `code`, then prints the recorded status. */
function waitWithNodeExiting(code: number, strict: number, call = 'ship_run_wait_ci 42 a/b 900 u') {
  const binDir = mkdtempSync(join(tmpdir(), 'wait-ci-strict-node-'));
  writeFileSync(join(binDir, 'node'), `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      `set -euo pipefail
SCRIPT_DIR='${shipLibDir()}'
. "$SCRIPT_DIR/wait-ci/args.sh"
WAIT_CI_STRICT=${strict}
${call}
echo "status=$WAIT_CI_STATUS"`,
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } },
  );
}

describe('--wait-ci-strict', () => {
  it('exits 0 when the verdict is passed', () => {
    const r = strictShip(STRICT, GREEN);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('ci-outcome=passed pr=42');
  });

  it.each([
    ['failed', RED, {}, 'ci-outcome=failed pr=42'],
    ['unavailable', 'not json', {}, 'ci-outcome=unavailable pr=42'],
    [
      'not-run',
      GREEN,
      { SHIP_DRY_RUN: '1' },
      'ci-outcome=not-run pr=? reason=dry-run-opened-no-pr',
    ],
  ])('exits 5 on a %s verdict, keeping the verdict line', (_label, rows, env, line) => {
    const r = strictShip(STRICT, rows, env);
    expect(r.status, r.stderr).toBe(5);
    expect(r.stderr).toContain(line);
  });

  it('keeps the PR URL on stdout and says not to --resume when CI is red', () => {
    const r = strictShip(STRICT, RED);
    expect(r.status, r.stderr).toBe(5);
    expect(r.stdout).toContain(PR_URL);
    expect(r.stderr).toContain(
      `the PR is open at ${PR_URL}; its CI is not known green. Do NOT --resume.`,
    );
  });

  it('ignores a WAIT_CI_STRICT inherited from the environment', () => {
    // Only the flag opts in: an exported variable must neither turn red into 5 nor refuse a ship.
    const red = strictShip(['--wait-ci'], RED, { WAIT_CI_STRICT: '1' });
    expect(red.status, red.stderr).toBe(0);
    const plain = strictShip([], GREEN, { WAIT_CI_STRICT: '1' });
    expect(plain.status, plain.stderr).toBe(0);
  });

  it('exits 5 after a real re-push to a red PR, with the URL still on stdout', () => {
    const { r } = strictReship([...STRICT, '--', 'a.ts'], { GH_CHECKS_JSON: RED });
    expect(r.status, r.stderr).toBe(5);
    expect(r.stdout).toContain('https://github.com/acme/app/pull/7');
    expect(r.stderr).toContain('ci-outcome=failed pr=7');
  });

  it('finishes a body-only update before exiting 5, rather than aborting mid-arm', () => {
    // reship runs under `set -e`: a wait that exited would skip the body receipt and the URL echo.
    const argv = ['--body', 'fresh body', ...STRICT, '--', 'a.ts'];
    const { r, ghBody } = strictReship(argv, { GH_CHECKS_JSON: RED }, false);
    expect(r.status, r.stderr).toBe(5);
    expect(readFileSync(ghBody, 'utf8')).toBe('fresh body');
    expect(r.stdout).toContain('https://github.com/acme/app/pull/7');
  });

  it('exits 5 for a SHIP_DRY_RUN re-push, as a new ship does, since no verdict was formed', () => {
    const env = { GH_CHECKS_JSON: GREEN, SHIP_DRY_RUN: '1' };
    const { r } = strictReship([...STRICT, '--', 'a.ts'], env);
    expect(r.status, r.stderr).toBe(5);
    expect(r.stderr).toContain('ci-outcome=not-run pr=? reason=dry-run-opened-no-pr');
  });

  it('lets a failed --ready flip keep its exit 1', () => {
    const env = { GH_CHECKS_JSON: GREEN, GH_READY_STATUS: '1' };
    const { r } = strictReship(['--ready', ...STRICT, '--', 'a.ts'], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ci-outcome=not-run pr=7 reason=ready-flip-failed');
  });

  it.each([
    ['new ship', undefined],
    ['re-push', reshipScript],
  ])('is refused without --wait-ci on a %s', (_label, script) => {
    const r = buildAndRun('main', 'git@github.com:acme/app.git', {
      ...(script
        ? { script, argv: ['feat/x', 't', '--pr', '--wait-ci-strict', '--', 'note.txt'] }
        : { extraArgs: ['--wait-ci-strict'] }),
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--wait-ci-strict has no effect without --wait-ci/);
    expect(r.stderr).not.toMatch(FLAG_RE);
  });

  it('is accepted under --resume, where the record cannot carry it', () => {
    const r = buildAndRun('main', 'git@github.com:acme/app.git', {
      argv: ['--resume', 'feat/never-shipped', ...STRICT],
    });
    expect(r.stderr).not.toMatch(FLAG_RE);
    expect(r.stderr).not.toMatch(/has no effect without --wait-ci/);
  });

  it('is rejected in a positional slot instead of shipping a branch named after it', () => {
    const r = buildAndRun('main', 'git@github.com:acme/app.git', {
      argv: ['--wait-ci-strict', 'title', 'note.txt'],
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/must come FIRST, before any flag/);
  });

  it.each([
    ['a crashed wait to 5, never the "PR did not open" 1', 1, 1, 'status=5'],
    ['any other module failure to 5', 7, 1, 'status=5'],
    ['a SIGKILLed wait to 5, not an undocumented 137', 137, 1, 'status=5'],
    ['a SIGINT status through unchanged', 130, 1, 'status=130'],
    ['a SIGTERM status through unchanged', 143, 1, 'status=143'],
    ['a passed wait to 0', 0, 1, 'status=0'],
    ['nothing at all without the flag', 7, 0, 'status=0'],
  ])('maps %s', (_label, code, strict, expected) => {
    const r = waitWithNodeExiting(code, strict);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(expected);
  });

  it('records 5 for a wait that could not run', () => {
    const r = waitWithNodeExiting(0, 1, 'ship_run_wait_ci "" a/b 900 u');
    expect(r.stdout.trim()).toBe('status=5');
    expect(r.stderr).toContain('ci-outcome=not-run pr=? reason=pr-number-unresolved');
  });
});
