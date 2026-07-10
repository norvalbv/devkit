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
    expect(r.suppressed[0].rationale).toMatch(/holds a lock/);
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
    expect(rConv.suppressed.map((s) => s.fp)).toEqual([fpConventions]);
    const rCorr = reconcile(cwd, 'correctness-reviewer', ['concurrency-races'], 'DIFF-SHARED', NOW);
    expect(rCorr.suppressed.map((s) => s.fp)).toEqual([fpCorrectness]);
  });
});

describe('blockingNote', () => {
  it('names each finding fingerprint and the exact override affordance', () => {
    const note = blockingNote('correctness-reviewer', [{ lens: 'json-shape', fp: 'a1b2c3d4e5f6' }]);
    expect(note).toContain('json-shape');
    expect(note).toContain('OVERRIDE_a1b2c3d4e5f6_RATIONALE=');
    expect(note).toContain('.devkit/correctness-overrides.json');
  });
  it('empty for no findings', () => {
    expect(blockingNote('correctness-reviewer', [])).toBe('');
  });
});
