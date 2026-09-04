import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
      [reshipScript, 'feat/pr', 'add v2', '--pr', '--wait-ci', '--no-qavis-publish', '--', 'a.ts'],
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
      [
        reshipScript,
        'feat/pr',
        'add v2',
        '--pr',
        '--ready',
        '--wait-ci',
        '--no-qavis-publish',
        '--',
        'a.ts',
      ],
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
