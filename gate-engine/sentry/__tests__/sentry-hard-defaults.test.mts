// Hard-by-default + the samples confidence contract (2026-07-12 Target: all judge gates hard by
// default; block = 3-sample majority). Pure resolveSamples is table-tested; the hard default is
// proven end-to-end by spawning the gate with a stubbed `claude` — on the `message` tier, which
// keeps its hard block without staged-diff evidence (effectiveHard's diff-tier downgrade is
// covered in check-sentry.test.mts).

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSamples } from '../check-sentry.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'check-sentry.mts');

describe('resolveSamples (confidence contract: block = 3-sample majority, warn = 1)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [true, undefined, 3],
    [false, undefined, 1],
    [true, '5', 5], // env override wins in hard mode
    [false, '2', 2], // and in warn mode
    [true, '0', 3], // invalid override falls back to the default
    [false, 'nope', 1],
  ])('resolveSamples(hard=%j, GUARD_SENTRY_SAMPLES=%j) → %j', (hard, env, expected) => {
    if (env !== undefined) vi.stubEnv('GUARD_SENTRY_SAMPLES', env);
    expect(resolveSamples(hard)).toBe(expected);
  });

  it('honours the FRINK_* back-compat alias', () => {
    vi.stubEnv('FRINK_SENTRY_SAMPLES', '7');
    expect(resolveSamples(true)).toBe(7);
  });
});

describe('gate mode is hard by default (spawned; stubbed claude, message tier, tmp watchlist)', () => {
  const stubs: string[] = [];
  const stubPath = (script: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'sentry-hard-stub-'));
    stubs.push(dir);
    const fake = join(dir, 'claude');
    writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\n${script}`);
    chmodSync(fake, 0o755);
    return `${dir}:${process.env.PATH}`;
  };
  // MONITOR on the warn path appends to the watchlist — point it at a tmp file, never the repo's.
  // The verdict cache likewise anchors to the real checkout, so each spawn gets a private store
  // root (realpath: reviewDataRoot rejects the /var→/private/var alias). Both tmp dirs join
  // `stubs` so afterEach reclaims them with the claude stubs.
  const gate = (env: Record<string, string>, msg: string) => {
    const wlDir = mkdtempSync(join(tmpdir(), 'sentry-hard-wl-'));
    const storeDir = realpathSync(mkdtempSync(join(tmpdir(), 'sentry-hard-store-')));
    stubs.push(wlDir, storeDir);
    return spawnSync('node', [SCRIPT, '--gate', msg], {
      env: {
        ...process.env,
        GUARD_REVIEW_MODEL: 'haiku', // stubbed `claude` on PATH; the default judge family is codex
        GUARD_SENTRY_CONTEXT: 'message',
        GUARD_SENTRY_WATCHLIST: join(wlDir, 'wl.md'),
        DEVKIT_RUN_MODE: 'review',
        DEVKIT_REVIEW_DATA_ROOT: storeDir,
        ...env,
      },
      encoding: 'utf8',
    });
  };
  afterEach(() => {
    while (stubs.length) rmSync(stubs.pop() as string, { recursive: true, force: true });
  });

  it('confident MONITOR blocks (exit 1) with NO SENTRY_HARD set — hard is the default', () => {
    const r = gate({ PATH: stubPath('echo MONITOR\n') }, 'fix(x): silent swallow');
    expect(r.status).toBe(1);
  });

  it('GUARD_SENTRY_HARD=0 softens the same verdict back to warn (exit 0)', () => {
    const r = gate(
      { PATH: stubPath('echo MONITOR\n'), GUARD_SENTRY_HARD: '0' },
      'fix(x): silent swallow',
    );
    expect(r.status).toBe(0);
  });

  it('a SKIP verdict passes (exit 0) under the hard default', () => {
    expect(gate({ PATH: stubPath('echo SKIP\n') }, 'fix(x): y').status).toBe(0);
  });
});

describe('diff tier, spawned against a REAL staged diff (sc-1984: authority follows the evidence)', () => {
  const dirs: string[] = [];
  const tmp = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  /** A git repo with `body` staged as src/exec.ts, plus a stubbed `claude` that always says MONITOR. */
  const stagedRepo = (body: string) => {
    const repo = tmp('sentry-diff-repo-');
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 't@t'],
      ['config', 'user.name', 't'],
    ]) {
      spawnSync('git', args, { cwd: repo });
    }
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'exec.ts'), body);
    spawnSync('git', ['add', '-A'], { cwd: repo });
    return repo;
  };
  /** Always-MONITOR `claude`, tee-ing the judge's stdin (what it was SHOWN) and appending one line
   * per invocation to `callFile` (how many SAMPLES the run voted). */
  const monitorStub = (payloadFile?: string, callFile?: string) => {
    const dir = tmp('sentry-diff-stub-');
    const fake = join(dir, 'claude');
    const sink = payloadFile ? `cat >>'${payloadFile}'` : 'cat >/dev/null';
    const count = callFile ? `echo call >>'${callFile}'\n` : '';
    writeFileSync(fake, `#!/bin/sh\n${sink}\n${count}echo MONITOR\n`);
    chmodSync(fake, 0o755);
    return `${dir}:${process.env.PATH}`;
  };
  const gate = (repo: string, subject: string, payloadFile?: string, callFile?: string) =>
    spawnSync('node', [SCRIPT, '--gate', subject], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: monitorStub(payloadFile, callFile),
        GUARD_SENTRY_CONTEXT: 'diff',
        // Pin the judge so these assert gate LOGIC, not model routing: the default now resolves from
        // the repo's `review.model` (sc-2190), which can select a non-claude runtime the stub below
        // does not intercept.
        GUARD_SENTRY_MODEL: 'haiku',
        GUARD_SENTRY_WATCHLIST: join(tmp('sentry-diff-wl-'), 'wl.md'),
        DEVKIT_RUN_MODE: 'review',
        DEVKIT_REVIEW_DATA_ROOT: tmp('sentry-diff-store-'),
        DEVKIT_NO_TELEMETRY: '1',
        // Git's per-repo control vars are already stripped by vitest.setup.mjs, so a hook-launched
        // run cannot point these spawns at devkit's own index (see judge-isolation's GIT_ENV_VARS).
      },
      encoding: 'utf8',
    });
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('SHOWS the judge a wrapper capture that the old selector dropped (the sc-1984 false block)', () => {
    // The reported failure was not a bad verdict — it was a verdict reached on evidence containing
    // zero lines of code, because `captureContained` matched no error token and the hunk was dropped
    // as a distractor. The judge then blocked for the absence of the very call in the staged diff.
    const payload = join(tmp('sentry-diff-payload-'), 'stdin.txt');
    gate(
      stagedRepo("export async function fanOut() {\n  captureContained('fan-out not-ok');\n}\n"),
      'fix(exec): report a not-ok fan-out result',
      payload,
    );
    const shown = readFileSync(payload, 'utf8');
    expect(shown).toContain('captureContained'); // the hunk itself reaches the judge…
    expect(shown).toContain('CAPTURES ADDED BY THIS COMMIT'); // …and the deterministic ground truth
    expect(shown).toContain('src/exec.ts:');
  });

  it('a real swallow with NO capture still blocks — the floor removes false blocks, not teeth', () => {
    const r = gate(
      stagedRepo('export function save() {\n  try { write(); } catch (e) { log.warn(e); }\n}\n'),
      'fix(save): swallow a write failure',
    );
    expect(r.status).toBe(1);
  });

  it('samples follow the POST-degrade hard: 3 when it can block, 1 when it cannot', () => {
    // run() must derive evidence -> hard -> samples in that order. If `hard` were resolved before the
    // evidence (as it was pre-sc-1984), a degraded run would still pay the 3-sample blocking vote and
    // key its cache slot as though it had blocking authority.
    const calls = (subject: string, body: string) => {
      const file = join(tmp('sentry-diff-calls-'), 'calls.txt');
      writeFileSync(file, '');
      const r = gate(stagedRepo(body), subject, undefined, file);
      return {
        status: r.status,
        samples: readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length,
      };
    };
    const sufficient = calls(
      'fix(save): swallow a write failure',
      'export function save() {\n  try { write(); } catch (e) { log.warn(e); }\n}\n',
    );
    expect(sufficient).toEqual({ status: 1, samples: 3 }); // confidence contract intact where it blocks

    const degraded = calls('fix(ui): badge spacing', 'export const Badge = () => "x";\n');
    expect(degraded).toEqual({ status: 0, samples: 1 }); // advisory runs spend one sample, never three
  });

  it('a diff with no error-handling hunk at all is advisory only, and says so', () => {
    const r = gate(
      stagedRepo('export const Badge = () => <span className="x" />;\n'),
      'fix(ui): badge spacing',
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('advisory only');
    expect(r.stderr).toContain('no error-handling hunk');
  });
});
