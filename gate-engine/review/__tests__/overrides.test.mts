import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blockingNote,
  envOverrides,
  fingerprint,
  loadOverrides,
  reconcile,
} from '../overrides.mts';
import { resetReviewBaseContext } from '../evidence/base-context.mts';

const dirs: string[] = [];
const repo = () => {
  const d = mkdtempSync(join(tmpdir(), 'overrides-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const NOW = '2026-07-06T00:00:00.000Z';

describe('fingerprint', () => {
  it('is stable for the same reviewer + lens + diff', () => {
    const a = fingerprint('correctness-reviewer', 'concurrency-races', 'DIFF-A');
    const b = fingerprint('correctness-reviewer', 'concurrency-races', 'DIFF-A');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });
  it('voids when the reviewed diff changes (a stale override cannot suppress a new bug)', () => {
    expect(fingerprint('correctness-reviewer', 'concurrency-races', 'DIFF-A')).not.toBe(
      fingerprint('correctness-reviewer', 'concurrency-races', 'DIFF-B'),
    );
  });
  it('differs by lens', () => {
    expect(fingerprint('correctness-reviewer', 'concurrency-races', 'D')).not.toBe(
      fingerprint('correctness-reviewer', 'state-transitions', 'D'),
    );
  });
});

describe('envOverrides', () => {
  it('parses OVERRIDE_<fp>_RATIONALE, ignores blanks and malformed keys', () => {
    const env = {
      OVERRIDE_a1b2c3d4e5f6_RATIONALE: 'not a real race',
      OVERRIDE_deadbeef0000_RATIONALE: '   ', // blank → ignored (no silent waive)
      OVERRIDE_short_RATIONALE: 'bad fp',
      UNRELATED: 'x',
    } as NodeJS.ProcessEnv;
    expect(envOverrides(env)).toEqual({ a1b2c3d4e5f6: 'not a real race' });
  });
});

describe('reconcile', () => {
  const fpFor = (lens: string, diff: string) => fingerprint('correctness-reviewer', lens, diff);

  it('un-overridden lenses block; the store file is not created for a pure read', () => {
    const cwd = repo();
    const r = reconcile(cwd, 'correctness-reviewer', ['concurrency-races'], 'D', NOW);
    expect(r.suppressed).toEqual([]);
    expect(r.blocking).toEqual([
      { lens: 'concurrency-races', fp: fpFor('concurrency-races', 'D') },
    ]);
    expect(loadOverrides(cwd)).toEqual({}); // nothing persisted on a plain block
  });

  it('a committed-file override with a rationale suppresses the finding', () => {
    const cwd = repo();
    const fp = fpFor('state-transitions', 'D');
    mkdirSync(join(cwd, '.devkit'), { recursive: true });
    writeFileSync(
      join(cwd, '.devkit/correctness-overrides.json'),
      JSON.stringify({ [fp]: { rationale: 'writer holds a lock the fixture omits', by: 'file' } }),
    );
    const r = reconcile(cwd, 'correctness-reviewer', ['state-transitions'], 'D', NOW);
    expect(r.blocking).toEqual([]);
    expect(r.suppressed[0]).toMatchObject({
      rationale: 'writer holds a lock the fixture omits',
      recorded_at: null,
      recorded_by: 'file',
    });
  });

  it('an env override suppresses AND is persisted through to the file (survives next commit)', () => {
    const cwd = repo();
    const fp = fpFor('error-and-edge-classification', 'D');
    const env = {
      [`OVERRIDE_${fp}_RATIONALE`]: 'anchor is tight — false positive',
    } as NodeJS.ProcessEnv;
    const r = reconcile(
      cwd,
      'correctness-reviewer',
      ['error-and-edge-classification'],
      'D',
      NOW,
      env,
    );
    expect(r.blocking).toEqual([]);
    expect(r.suppressed[0]).toMatchObject({
      recorded_at: NOW,
      recorded_by: 'env',
    });
    const stored = loadOverrides(cwd)[fp];
    expect(stored).toMatchObject({
      rationale: 'anchor is tight — false positive',
      by: 'env',
      at: NOW,
    });
  });

  it('mixed: one waived, one still blocking', () => {
    const cwd = repo();
    const fp = fpFor('concurrency-races', 'D');
    const env = { [`OVERRIDE_${fp}_RATIONALE`]: 'ok' } as NodeJS.ProcessEnv;
    const r = reconcile(
      cwd,
      'correctness-reviewer',
      ['concurrency-races', 'json-shape'],
      'D',
      NOW,
      env,
    );
    expect(r.suppressed.map((s) => s.lens)).toEqual(['concurrency-races']);
    expect(r.blocking.map((b) => b.lens)).toEqual(['json-shape']);
  });

  it('a corrupt store file never suppresses (fails safe to blocking)', () => {
    const cwd = repo();
    mkdirSync(join(cwd, '.devkit'), { recursive: true });
    writeFileSync(join(cwd, '.devkit/correctness-overrides.json'), '{ not json');
    const r = reconcile(cwd, 'correctness-reviewer', ['json-shape'], 'D', NOW);
    expect(r.blocking).toHaveLength(1);
  });

  // conventions-reviewer shares this exact store/mechanism with correctness-reviewer (both are
  // single-pass, model-pinned REVIEWERS entries — see reviewers.mts). Two DIFFERENT reviewers
  // waiving findings on the SAME diff bytes must coexist in one persisted file, not clobber each
  // other — `persist()` does a full read-modify-write of the WHOLE store, so a naive
  // implementation that dropped unrelated keys on write would silently un-waive the other
  // reviewer's already-recorded override.
  it("two DIFFERENT reviewers' env overrides on the SAME diff both persist — neither clobbers the other", () => {
    const cwd = repo();
    const fpConventions = fingerprint('conventions-reviewer', 'app/handler.ts:4', 'DIFF-SHARED');
    const fpCorrectness = fingerprint('correctness-reviewer', 'concurrency-races', 'DIFF-SHARED');
    reconcile(cwd, 'conventions-reviewer', ['app/handler.ts:4'], 'DIFF-SHARED', NOW, {
      [`OVERRIDE_${fpConventions}_RATIONALE`]: 'conventions waiver',
    } as NodeJS.ProcessEnv);
    reconcile(cwd, 'correctness-reviewer', ['concurrency-races'], 'DIFF-SHARED', NOW, {
      [`OVERRIDE_${fpCorrectness}_RATIONALE`]: 'correctness waiver',
    } as NodeJS.ProcessEnv);
    const store = loadOverrides(cwd);
    expect(store[fpConventions]?.rationale).toBe('conventions waiver');
    expect(store[fpCorrectness]?.rationale).toBe('correctness waiver');
    // Re-reconciling EITHER reviewer alone still sees BOTH entries intact — a read for one
    // reviewer must never observe the other's waiver as lost.
    const rConv = reconcile(cwd, 'conventions-reviewer', ['app/handler.ts:4'], 'DIFF-SHARED', NOW);
    expect(rConv.suppressed.map((s) => s.fingerprint)).toEqual([fpConventions]);
    const rCorr = reconcile(cwd, 'correctness-reviewer', ['concurrency-races'], 'DIFF-SHARED', NOW);
    expect(rCorr.suppressed.map((s) => s.fingerprint)).toEqual([fpCorrectness]);
  });
});

describe('blockingNote', () => {
  it('names each finding fingerprint and the exact override affordance', () => {
    const note = blockingNote('correctness-reviewer', [{ lens: 'json-shape', fp: 'a1b2c3d4e5f6' }]);
    expect(note).toContain('json-shape');
    expect(note).toContain('OVERRIDE_a1b2c3d4e5f6_RATIONALE=');
    expect(note).toContain('.devkit/correctness-overrides.json');
  });
  it('also prints the `guard-review waive` affordance with the exact reviewer:lens/fp to copy', () => {
    const note = blockingNote('correctness-reviewer', [{ lens: 'json-shape', fp: 'a1b2c3d4e5f6' }]);
    expect(note).toContain('guard-review waive correctness-reviewer:json-shape a1b2c3d4e5f6');
  });
  it('empty for no findings', () => {
    expect(blockingNote('correctness-reviewer', [])).toBe('');
  });
});

describe('reconcile — author pass-through', () => {
  it('carries a file-store `author` field into the RecordedWaiver (the waive CLI sets it)', () => {
    const cwd = repo();
    const fp = fingerprint('correctness-reviewer', 'state-transitions', 'D');
    mkdirSync(join(cwd, '.devkit'), { recursive: true });
    writeFileSync(
      join(cwd, '.devkit/correctness-overrides.json'),
      JSON.stringify({
        [fp]: { rationale: 'writer holds a lock', by: 'cli', author: 'Ada Lovelace' },
      }),
    );
    const r = reconcile(cwd, 'correctness-reviewer', ['state-transitions'], 'D', NOW);
    expect(r.suppressed[0]).toMatchObject({ recorded_by: 'cli', author: 'Ada Lovelace' });
  });
  it('omits `author` entirely (not `undefined`/`null`) when the entry never set one', () => {
    const cwd = repo();
    const fp = fingerprint('correctness-reviewer', 'state-transitions', 'D');
    mkdirSync(join(cwd, '.devkit'), { recursive: true });
    writeFileSync(
      join(cwd, '.devkit/correctness-overrides.json'),
      JSON.stringify({ [fp]: { rationale: 'writer holds a lock', by: 'file' } }),
    );
    const r = reconcile(cwd, 'correctness-reviewer', ['state-transitions'], 'D', NOW);
    expect('author' in r.suppressed[0]).toBe(false);
  });
  it('a later env override MERGES onto a CLI-recorded entry — author/reviewer/lens/itemId survive', () => {
    const cwd = repo();
    const fp = fingerprint('correctness-reviewer', 'state-transitions', 'D');
    mkdirSync(join(cwd, '.devkit'), { recursive: true });
    writeFileSync(
      join(cwd, '.devkit/correctness-overrides.json'),
      JSON.stringify({
        [fp]: {
          rationale: 'cli rationale',
          by: 'cli',
          author: 'Ada Lovelace',
          reviewer: 'correctness-reviewer',
          lens: 'state-transitions',
          itemId: fp,
        },
      }),
    );
    const env = { [`OVERRIDE_${fp}_RATIONALE`]: 'a different env rationale' } as NodeJS.ProcessEnv;
    const r = reconcile(cwd, 'correctness-reviewer', ['state-transitions'], 'D', NOW, env);
    expect(r.suppressed[0]).toMatchObject({
      rationale: 'a different env rationale',
      author: 'Ada Lovelace',
    });
    const stored = loadOverrides(cwd)[fp];
    expect(stored).toMatchObject({
      rationale: 'a different env rationale',
      by: 'env',
      author: 'Ada Lovelace',
      reviewer: 'correctness-reviewer',
      lens: 'state-transitions',
      itemId: fp,
    });
  });
});

// fingerprint hashes diffCacheIdentity(diff): a waiver recorded pre-fix must survive the
// purely-sentry-additive restage the sentry gate demands, and void on anything more.
describe('fingerprint across a sentry-additive restage', () => {
  const d1 =
    'diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n ctx();\n+handle();\n more();\n';
  const d2 =
    'diff --git a/src/a.ts b/src/a.ts\nindex 1111111..3333333 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,4 @@\n ctx();\n+handle();\n+Sentry.captureException(e);\n more();\n';

  it('survives the capture-only restage', () => {
    expect(fingerprint('correctness-reviewer', 'concurrency-races', d1)).toBe(
      fingerprint('correctness-reviewer', 'concurrency-races', d2),
    );
  });

  it('voids when a real line rides along', () => {
    const d3 = d2.replace('+Sentry.captureException(e);', '+refund(user);');
    expect(fingerprint('correctness-reviewer', 'concurrency-races', d1)).not.toBe(
      fingerprint('correctness-reviewer', 'concurrency-races', d3),
    );
  });
});

describe('waiver base provenance (sc-2480)', () => {
  const gitIn = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const commitIn = (cwd: string, message: string): string => {
    writeFileSync(join(cwd, 'f.ts'), `export const n = "${message}";\n`);
    gitIn(cwd, ['add', '-A']);
    gitIn(cwd, [
      '-c',
      'user.email=devkit@example.test',
      '-c',
      'user.name=Devkit Test',
      'commit',
      '-qm',
      message,
    ]);
    return gitIn(cwd, ['rev-parse', 'HEAD']);
  };
  const DIFF = 'diff --git a/f.ts b/f.ts';
  const LENS = 'concurrency-races';

  afterEach(() => resetReviewBaseContext());

  it('stamps the env write-through with the tree the finding was judged against', () => {
    const cwd = repo();
    gitIn(cwd, ['init', '-q']);
    const head = commitIn(cwd, 'one');
    const fp = fingerprint('correctness-reviewer', LENS, DIFF);
    reconcile(cwd, 'correctness-reviewer', [LENS], DIFF, NOW, {
      [`OVERRIDE_${fp}_RATIONALE`]: 'the shard lock the fixture omits makes this safe',
    });
    expect(loadOverrides(cwd)[fp].baseSha).toBe(head);
  });

  it('does not carry a STALE base forward when the same fingerprint is re-waived', () => {
    const cwd = repo();
    gitIn(cwd, ['init', '-q']);
    const first = commitIn(cwd, 'one');
    const fp = fingerprint('correctness-reviewer', LENS, DIFF);
    const env = (rationale: string) => ({ [`OVERRIDE_${fp}_RATIONALE`]: rationale });
    reconcile(cwd, 'correctness-reviewer', [LENS], DIFF, NOW, env('first recorded rationale here'));
    resetReviewBaseContext();
    const second = commitIn(cwd, 'two');
    expect(second).not.toBe(first);
    reconcile(
      cwd,
      'correctness-reviewer',
      [LENS],
      DIFF,
      NOW,
      env('a different rationale entirely'),
    );
    expect(loadOverrides(cwd)[fp].baseSha).toBe(second);
  });

  it('names the base in the copyable waive command', () => {
    const note = blockingNote(
      'correctness-reviewer',
      [{ lens: LENS, fp: 'a1b2c3d4e5f6' }],
      'a'.repeat(40),
    );
    expect(note).toContain('--base aaaaaaaaaaaa');
    expect(
      blockingNote('correctness-reviewer', [{ lens: LENS, fp: 'a1b2c3d4e5f6' }]),
    ).not.toContain('--base');
  });
});

describe('waiver base refresh when only the base moved (reviewer finding)', () => {
  const gitIn = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const commitIn = (cwd: string, message: string): string => {
    writeFileSync(join(cwd, 'f.ts'), `export const n = "${message}";\n`);
    gitIn(cwd, ['add', '-A']);
    gitIn(cwd, ['-c', 'user.email=d@e.test', '-c', 'user.name=D', 'commit', '-qm', message]);
    return gitIn(cwd, ['rev-parse', 'HEAD']);
  };
  afterEach(() => resetReviewBaseContext());

  it('refreshes the recorded base when the rationale is UNCHANGED but the tree moved', () => {
    const cwd = repo();
    gitIn(cwd, ['init', '-q']);
    commitIn(cwd, 'one');
    const fp = fingerprint('correctness-reviewer', 'races', 'DIFF');
    const env = { [`OVERRIDE_${fp}_RATIONALE`]: 'one stable rationale, reused verbatim' };
    reconcile(cwd, 'correctness-reviewer', ['races'], 'DIFF', NOW, env);
    resetReviewBaseContext();
    const second = commitIn(cwd, 'two');
    reconcile(cwd, 'correctness-reviewer', ['races'], 'DIFF', NOW, env);
    expect(loadOverrides(cwd)[fp].baseSha).toBe(second);
  });
});
