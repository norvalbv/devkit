import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import { reviewerTargetSalts } from '../evidence/targets-block.mts';
import { correctnessModel, resolveReviewModel, selectReviewers } from '../reviewers.mts';

// sc-2107/sc-2054: the judge knobs resolve env > guard.config.json > package defaults (the
// benched winner, sol@400, since codex parity landed). These tests pin the resolution order, the
// config-resolved correctness pin, and the model term in the cache salt (sc-2053: a verdict must
// not survive a model change).

const envKeys = ['GUARD_REVIEW_MODEL', 'FRINK_REVIEW_MODEL', 'GUARD_CORRECTNESS_MODEL'] as const;
const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
const roots: string[] = [];

beforeEach(() => {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

interface ReviewConfigFile {
  review?: { model?: string; correctnessModel?: string; correctnessChunkLoc?: number };
}

function cfgIn(json?: ReviewConfigFile) {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-model-cfg-'));
  roots.push(dir);
  if (json) writeFileSync(join(dir, 'guard.config.json'), JSON.stringify(json));
  return resolveGuardConfig(dir);
}

describe('model resolution: env > guard.config.json > shipped default', () => {
  it('package defaults are the benched winner since sc-2054 parity: sol judges, chunk 400', () => {
    const cfg = cfgIn();
    expect(resolveReviewModel(cfg)).toBe('gpt-5.6-sol');
    expect(correctnessModel(cfg)).toBe('gpt-5.6-sol');
    expect(cfg.review.correctnessChunkLoc).toBe(400);
  });

  it('malformed file values fall to the defaults — a number model never reaches judge argv, a string cap never silently disables chunking', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devkit-model-cfg-'));
    roots.push(dir);
    writeFileSync(
      join(dir, 'guard.config.json'),
      '{"review":{"model":7,"correctnessModel":" sonnet ","correctnessChunkLoc":"off"}}',
    );
    const cfg = resolveGuardConfig(dir);
    expect(cfg.review.model).toBe('gpt-5.6-sol');
    // A padded value is honored TRIMMED — whitespace must never reach --model.
    expect(cfg.review.correctnessModel).toBe('sonnet');
    expect(cfg.review.correctnessChunkLoc).toBe(400);
  });

  it('guard.config.json overrides per installation; env overrides the file', () => {
    const cfg = cfgIn({ review: { model: 'haiku', correctnessModel: 'sonnet' } });
    expect(resolveReviewModel(cfg)).toBe('haiku');
    expect(correctnessModel(cfg)).toBe('sonnet');
    process.env.GUARD_REVIEW_MODEL = 'gpt-5.6-terra';
    process.env.GUARD_CORRECTNESS_MODEL = 'opus';
    expect(resolveReviewModel(cfg)).toBe('gpt-5.6-terra');
    expect(correctnessModel(cfg)).toBe('opus');
    // An empty/blank env var is unset, not a pin — falls to the FILE value, never --model ''.
    process.env.GUARD_REVIEW_MODEL = '';
    process.env.GUARD_CORRECTNESS_MODEL = '  ';
    expect(resolveReviewModel(cfg)).toBe('haiku');
    expect(correctnessModel(cfg)).toBe('sonnet');
  });
});

describe('selectReviewers applies the config-resolved correctness pin', () => {
  it('the correctness selection carries the configured single-pass model', () => {
    const staged = ['src/a.ts'];
    const pick = (cfg: ReturnType<typeof resolveGuardConfig>) =>
      selectReviewers(staged, cfg).find((s) => s.reviewer.name === 'correctness-reviewer');
    expect(pick(cfgIn())?.reviewer.model).toBe('gpt-5.6-sol');
    expect(pick(cfgIn({ review: { correctnessModel: 'sonnet' } }))?.reviewer.model).toBe('sonnet');
    process.env.GUARD_CORRECTNESS_MODEL = 'haiku';
    expect(pick(cfgIn())?.reviewer.model).toBe('haiku');
  });
});

describe('the judging model is part of verdict-cache identity (sc-2053)', () => {
  it('a different model yields a different salt for pinned and unpinned reviewers alike', () => {
    const sels = selectReviewers(['src/a.ts'], cfgIn());
    expect(sels.length).toBeGreaterThan(1);
    const a = reviewerTargetSalts(sels, new Map(), 'block', 'gpt-5.6-sol');
    const b = reviewerTargetSalts(sels, new Map(), 'block', 'haiku');
    // (cascade args differ; the pinned correctness salt must NOT follow them)
    const unpinned = sels.find(
      (s) => !s.reviewer.model && s.reviewer.name !== 'correctness-reviewer',
    );
    if (!unpinned) throw new Error('fixture: expected at least one unpinned reviewer selection');
    const name = unpinned.reviewer.name;
    expect(a.get(name)).toContain('model:gpt-5.6-sol');
    expect(a.get(name)).not.toBe(b.get(name));
    // The correctness pin, not the cascade default, is its identity: same salt under both.
    expect(a.get('correctness-reviewer')).toContain('model:gpt-5.6-sol');
    expect(a.get('correctness-reviewer')).toBe(b.get('correctness-reviewer'));
  });
});
