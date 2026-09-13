import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGuardConfig, resolveGuardConfigJson } from '../../config.mts';
import { CLAUDE_FAMILY_SET, JUDGE_MODEL_ENVS } from '../../judge/outage/family-override.mts';
import { reviewerTargetSalts } from '../evidence/targets-block.mts';
import {
  correctnessModel,
  resolveEscalationModel,
  resolveReviewModel,
  resolveSentryModel,
  REVIEWERS,
  selectReviewers,
  sentryModelOverride,
} from '../reviewers.mts';

// sc-2107/sc-2054: the judge knobs resolve env > guard.config.json > package defaults (the
// benched winner, sol@400, since codex parity landed). These tests pin the resolution order, the
// config-resolved correctness pin, and the model term in the cache salt (sc-2053: a verdict must
// not survive a model change).

const envKeys = [
  'GUARD_REVIEW_MODEL',
  'FRINK_REVIEW_MODEL',
  'GUARD_REVIEW_ESCALATION_MODEL',
  'GUARD_CORRECTNESS_MODEL',
  'GUARD_CORRECTNESS_CHUNK',
  'GUARD_SENTRY_MODEL',
  'FRINK_SENTRY_MODEL',
] as const;
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
  review?: {
    model?: string;
    escalationModel?: string;
    correctnessModel?: string;
    correctnessChunkLoc?: number;
    backendRoots?: string[];
    frontendRoots?: string[];
    paths?: { include?: string[]; exclude?: string[] };
  };
}

function cfgIn(json?: ReviewConfigFile) {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-model-cfg-'));
  roots.push(dir);
  if (json) writeFileSync(join(dir, 'guard.config.json'), JSON.stringify(json));
  return resolveGuardConfig(dir);
}

describe('model resolution: env > guard.config.json > shipped default', () => {
  it('package defaults: light judges terra@high, sol escalation, correctness sol @ chunk 400 (2026-08-27 ruling)', () => {
    const cfg = cfgIn();
    expect(resolveReviewModel(cfg)).toBe('gpt-5.6-terra@high');
    expect(resolveEscalationModel(cfg)).toBe('gpt-5.6-sol');
    expect(correctnessModel(cfg)).toBe('gpt-5.6-sol');
    expect(cfg.review.correctnessChunkLoc).toBe(400);
  });

  it('the escalation model resolves env > file > default and never reaches argv blank', () => {
    expect(resolveEscalationModel(cfgIn({ review: { escalationModel: 'opus' } }))).toBe('opus');
    process.env.GUARD_REVIEW_ESCALATION_MODEL = 'gpt-5.6-terra@xhigh';
    expect(resolveEscalationModel(cfgIn({ review: { escalationModel: 'opus' } }))).toBe(
      'gpt-5.6-terra@xhigh',
    );
    process.env.GUARD_REVIEW_ESCALATION_MODEL = '  ';
    expect(resolveEscalationModel(cfgIn({ review: { escalationModel: 'opus' } }))).toBe('opus');
  });

  it('malformed file values fall to the defaults — a number model never reaches judge argv, a string cap never silently disables chunking', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devkit-model-cfg-'));
    roots.push(dir);
    writeFileSync(
      join(dir, 'guard.config.json'),
      '{"review":{"model":7,"escalationModel":[],"correctnessModel":" sonnet ","correctnessChunkLoc":"off"}}',
    );
    const cfg = resolveGuardConfig(dir);
    expect(cfg.review.model).toBe('gpt-5.6-terra@high');
    expect(cfg.review.escalationModel).toBe('gpt-5.6-sol');
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

describe('shared review path config resolution', () => {
  it('keeps the block absent for exact legacy compatibility', () => {
    expect(cfgIn().review.paths).toBeUndefined();
  });

  it('canonicalizes valid path rules and resolves a HEAD snapshot through the same code', () => {
    const json = JSON.stringify({
      review: {
        paths: {
          include: [' scripts/** ', './src/**'],
          exclude: ['**/*.test.*'],
        },
      },
    });
    const fromFile = cfgIn(JSON.parse(json)).review.paths;
    const fromSnapshot = resolveGuardConfigJson(json, '/consumer').review.paths;
    expect(fromFile).toEqual({
      include: ['scripts/**', 'src/**'],
      exclude: ['**/*.test.*'],
    });
    expect(fromSnapshot).toEqual(fromFile);
  });

  it('fails setup loudly for malformed or disable-all configured scope', () => {
    expect(() => cfgIn({ review: { paths: { include: [] } } })).toThrow(/review\.paths\.include/);
    expect(() =>
      cfgIn({
        review: { paths: { include: ['src/**'], exclude: ['**/*'] } },
      }),
    ).toThrow(/disable the entire review scope/);
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
    const a = reviewerTargetSalts(sels, new Map(), 'block', 'gpt-5.6-sol', 'opus');
    const b = reviewerTargetSalts(sels, new Map(), 'block', 'haiku', 'opus');
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

  it("the escalation model joins an UNPINNED reviewer's identity only — its PASS may have been earned on escalation", () => {
    const sels = selectReviewers(['src/a.ts'], cfgIn());
    const a = reviewerTargetSalts(sels, new Map(), 'block', 'gpt-5.6-terra@high', 'gpt-5.6-sol');
    const b = reviewerTargetSalts(sels, new Map(), 'block', 'gpt-5.6-terra@high', 'opus');
    const unpinned = sels.find((s) => !s.reviewer.model);
    if (!unpinned) throw new Error('fixture: expected at least one unpinned reviewer selection');
    expect(a.get(unpinned.reviewer.name)).toContain('escalate:gpt-5.6-sol');
    expect(a.get(unpinned.reviewer.name)).not.toBe(b.get(unpinned.reviewer.name));
    // Pinned reviewers never escalate: correctness AND conventions ignore the escalator.
    for (const name of ['correctness-reviewer', 'conventions-reviewer']) {
      expect(a.get(name)).toBe(b.get(name));
      expect(a.get(name)).not.toContain('escalate:');
    }
  });
});

// sc-2689: the operator who set the two knobs devkit printed got a PARTIAL move and a ship that
// still failed closed. These pin that the published set is COMPLETE and stays that way.
describe('the published knob set moves every judge — and no knob can hide from it', () => {
  const ALL = { backendRoots: ['src'], frontendRoots: ['web'] };
  const staged = ['src/a.ts', 'web/b.tsx'];
  const isCodex = (m: string) => m.startsWith('gpt-');

  it('the fixture really selects every reviewer — otherwise the sweep below proves nothing', () => {
    expect(selectReviewers(staged, cfgIn({ review: ALL })).length).toBe(REVIEWERS.length);
  });

  it('with the claude family set, no judge — cascade, pinned or sentry — resolves a gpt-* model', () => {
    const cfg = cfgIn({ review: { ...ALL, ...CLAUDE_FAMILY_SET } });
    expect(isCodex(resolveReviewModel(cfg))).toBe(false);
    expect(isCodex(resolveEscalationModel(cfg))).toBe(false);
    expect(isCodex(correctnessModel(cfg))).toBe(false);
    expect(isCodex(resolveSentryModel(cfg))).toBe(false);
    expect(cfg.review.correctnessChunkLoc).toBe(0);
    for (const s of selectReviewers(staged, cfg))
      if (s.reviewer.model) expect(isCodex(s.reviewer.model)).toBe(false);
  });

  // Fails when a future reviewer carries a static `model` that selectReviewers forgets to
  // re-resolve: it lands in `pinned` but never in `rewritten`.
  it('every statically-pinned reviewer is re-resolved by selectReviewers', () => {
    const cfg = cfgIn({
      review: { ...ALL, model: 'haiku', escalationModel: 'opus', correctnessModel: 'sonnet' },
    });
    const shipped = new Map(REVIEWERS.map((r) => [r.name, r.model]));
    const pinned = new Set(REVIEWERS.filter((r) => r.model !== undefined).map((r) => r.name));
    const rewritten = new Set(
      selectReviewers(staged, cfg)
        .filter(
          (s) =>
            s.reviewer.model !== undefined && s.reviewer.model !== shipped.get(s.reviewer.name),
        )
        .map((s) => s.reviewer.name),
    );
    expect(rewritten).toEqual(pinned);
  });

  // The ratchet: a new envModel()/envVar() model knob anywhere in the engine fails here until it
  // joins the table the remedy, the doctor and the docs all render from.
  it('every model env the engine reads is published in JUDGE_MODEL_ENVS', () => {
    const src = ['../reviewers.mts', '../../sentry/check-sentry.mts', '../lens/chunk-tasks.mts']
      .map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'))
      .join('\n');
    const names = new Set<string>();
    for (const m of src.matchAll(/envModel\(['"]([A-Z_]+)['"]\)/g)) names.add(m[1]);
    for (const m of src.matchAll(/envVar\(['"]([A-Z_]+)['"]\)/g)) names.add(`GUARD_${m[1]}`);
    for (const m of src.matchAll(/process\.env\.(GUARD_[A-Z_]+)/g)) names.add(m[1]);
    const knobs = [...names].filter((n) => /MODEL|CHUNK/.test(n));
    expect(knobs.length).toBeGreaterThan(0);
    for (const n of knobs) expect(JUDGE_MODEL_ENVS).toContain(n);
  });
});

// The sentry judge is the one model knob with no config key of its own, so its blank/alias
// behaviour has to match the other three rather than being rediscovered per call site.
describe('the sentry judge resolves like its three siblings', () => {
  const cfg = () => cfgIn({ review: { model: 'haiku' } });

  it('unset, it follows review.model — one family move carries it (sc-2190)', () => {
    expect(sentryModelOverride()).toBeUndefined();
    expect(resolveSentryModel(cfg())).toBe('haiku');
    process.env.GUARD_REVIEW_MODEL = 'opus';
    expect(resolveSentryModel(cfg())).toBe('opus');
  });

  it('set, it overrides review.model', () => {
    process.env.GUARD_SENTRY_MODEL = 'gpt-5.6-sol';
    expect(sentryModelOverride()).toBe('gpt-5.6-sol');
    expect(resolveSentryModel(cfg())).toBe('gpt-5.6-sol');
  });

  // The same rule the other three keep: a blank env is UNSET, not a pin. Without it the sentry
  // spawn receives `--model ''` and the doctor reports a role whose model is the empty string.
  it('a blank or whitespace value is unset, never a pin — a blank --model must be unreachable', () => {
    process.env.GUARD_SENTRY_MODEL = '';
    expect(sentryModelOverride()).toBeUndefined();
    expect(resolveSentryModel(cfg())).toBe('haiku');
    process.env.GUARD_SENTRY_MODEL = '   ';
    expect(sentryModelOverride()).toBeUndefined();
    expect(resolveSentryModel(cfg())).toBe('haiku');
  });

  // The chain resolveReviewModel keeps: a blank GUARD_ falls through to FRINK_, never shadows it.
  it('a blank GUARD_ value falls through to the FRINK_ alias rather than hiding it', () => {
    process.env.GUARD_SENTRY_MODEL = '  ';
    process.env.FRINK_SENTRY_MODEL = 'sonnet';
    expect(sentryModelOverride()).toBe('sonnet');
    expect(resolveSentryModel(cfg())).toBe('sonnet');
  });

  it('honours the FRINK_ alias, and GUARD_ wins when both are set', () => {
    process.env.FRINK_SENTRY_MODEL = 'sonnet';
    expect(resolveSentryModel(cfg())).toBe('sonnet');
    process.env.GUARD_SENTRY_MODEL = 'opus';
    expect(resolveSentryModel(cfg())).toBe('opus');
  });
});
