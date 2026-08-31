import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../gate-engine/config.mts';
import {
  bindClaudeFamily,
  binResolvable,
  CLAUDE_FAMILY_SET,
  claudeBindable,
  claudeRuntimeResult,
  explicitFamilyKeys,
  FAMILY_PROVENANCE_KEY,
  familyStaleResult,
  requiredJudgeProviders,
} from '../lib/doctor/judge/judge-family.mts';

const envKeys = [
  'GUARD_CODEX_BIN',
  'PATH',
  'GUARD_REVIEW_MODEL',
  'FRINK_REVIEW_MODEL',
  'GUARD_REVIEW_ESCALATION_MODEL',
  'GUARD_CORRECTNESS_MODEL',
  'GUARD_CORRECTNESS_CHUNK',
] as const;
const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
const roots: string[] = [];

beforeEach(() => {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    if (key !== 'PATH') delete process.env[key];
  }
});
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'judge-family-'));
  roots.push(d);
  return d;
}

function binDir(...names: string[]): string {
  const d = tmp();
  for (const n of names) {
    const p = join(d, n);
    writeFileSync(p, '#!/bin/sh\nexit 0\n');
    chmodSync(p, 0o755);
  }
  return d;
}

const TEMPLATE_CONFIG = {
  scanRoots: ['src'],
  '//review': 'guidance text that must survive the write',
  review: {
    backendRoots: ['src'],
    frontendRoots: [],
    paths: { include: ['**'], exclude: ['dist/**'] },
  },
};

type FixtureConfig = Omit<typeof TEMPLATE_CONFIG, 'review'> & {
  review: (typeof TEMPLATE_CONFIG)['review'] &
    Partial<{
      model: string;
      escalationModel: string;
      correctnessModel: string;
      correctnessChunkLoc: number;
      '//judgeFamily': string;
    }>;
};

function repoWith(config: FixtureConfig): string {
  const d = tmp();
  writeFileSync(join(d, 'guard.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return d;
}

describe('bindClaudeFamily', () => {
  it('writes the COMPLETE family set nested under review, readable by resolveGuardConfig', () => {
    const repo = repoWith(TEMPLATE_CONFIG);
    process.env.PATH = binDir('claude');
    expect(bindClaudeFamily(repo)).toBe(true);
    const review = resolveGuardConfig(repo).review;
    expect(review.model).toBe('haiku');
    expect(review.escalationModel).toBe('opus');
    expect(review.correctnessModel).toBe('sonnet');
    expect(review.correctnessChunkLoc).toBe(0);
    const raw = JSON.parse(readFileSync(join(repo, 'guard.config.json'), 'utf8'));
    expect(raw.review[FAMILY_PROVENANCE_KEY]).toContain('devkit doctor --fix');
    expect(raw['//review']).toBe('guidance text that must survive the write');
    expect(raw.review.backendRoots).toEqual(['src']);
  });

  it('any explicit family key blocks the write and the file stays byte-identical', () => {
    const explicitVariants: Array<[string, Partial<FixtureConfig['review']>]> = [
      ['model', { model: 'opus' }],
      ['escalationModel', { escalationModel: 'opus' }],
      ['correctnessModel', { correctnessModel: 'opus' }],
      ['correctnessChunkLoc', { correctnessChunkLoc: 200 }],
    ];
    for (const [key, patch] of explicitVariants) {
      const repo = repoWith({
        ...TEMPLATE_CONFIG,
        review: { ...TEMPLATE_CONFIG.review, ...patch },
      });
      process.env.PATH = binDir('claude');
      const before = readFileSync(join(repo, 'guard.config.json'), 'utf8');
      expect(explicitFamilyKeys(repo)).toEqual([key]);
      expect(claudeBindable(repo)).toBe(false);
      expect(bindClaudeFamily(repo)).toBe(false);
      expect(readFileSync(join(repo, 'guard.config.json'), 'utf8')).toBe(before);
    }
  });

  it('an active GUARD_* model env blocks the bind — envs outrank anything devkit writes', () => {
    const repo = repoWith(TEMPLATE_CONFIG);
    process.env.PATH = binDir('claude');
    process.env.GUARD_REVIEW_MODEL = 'gpt-5.6-sol';
    const before = readFileSync(join(repo, 'guard.config.json'), 'utf8');
    expect(claudeBindable(repo)).toBe(false);
    expect(bindClaudeFamily(repo)).toBe(false);
    expect(readFileSync(join(repo, 'guard.config.json'), 'utf8')).toBe(before);
  });

  it('no claude binary → not bindable', () => {
    const repo = repoWith(TEMPLATE_CONFIG);
    process.env.PATH = binDir();
    expect(claudeBindable(repo)).toBe(false);
    expect(bindClaudeFamily(repo)).toBe(false);
  });

  it('a held lockfile makes a concurrent bind lose cleanly — no write, no wait', () => {
    const repo = repoWith(TEMPLATE_CONFIG);
    process.env.PATH = binDir('claude');
    writeFileSync(join(repo, 'guard.config.json.devkit-lock'), '');
    const before = readFileSync(join(repo, 'guard.config.json'), 'utf8');
    expect(bindClaudeFamily(repo)).toBe(false);
    expect(readFileSync(join(repo, 'guard.config.json'), 'utf8')).toBe(before);
  });

  it('an existing //judgeFamily key — even an operator note — blocks the bind', () => {
    const repo = repoWith({
      ...TEMPLATE_CONFIG,
      review: { ...TEMPLATE_CONFIG.review, '//judgeFamily': 'operator note' },
    });
    process.env.PATH = binDir('claude');
    expect(claudeBindable(repo)).toBe(false);
    expect(bindClaudeFamily(repo)).toBe(false);
  });

  it('codex resolvable again by write time → the writer itself refuses', () => {
    const repo = repoWith(TEMPLATE_CONFIG);
    process.env.PATH = binDir('claude', 'codex');
    expect(claudeBindable(repo)).toBe(false);
    expect(bindClaudeFamily(repo)).toBe(false);
  });

  it('the claude set matches the documented claude-era example values', () => {
    const example = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'guard.config.example.json'), 'utf8'),
    );
    expect(CLAUDE_FAMILY_SET).toEqual({
      model: example.review.model,
      escalationModel: example.review.escalationModel,
      correctnessModel: example.review.correctnessModel,
      correctnessChunkLoc: example.review.correctnessChunkLoc,
    });
  });
});

describe('binResolvable', () => {
  it('finds a PATH binary and honors a GUARD_CODEX_BIN pin', () => {
    const d = binDir('claude', 'codex');
    process.env.PATH = d;
    expect(binResolvable('claude', d)).toBe(true);
    expect(binResolvable('codex', d)).toBe(true);
    process.env.PATH = binDir();
    expect(binResolvable('claude', d)).toBe(false);
    process.env.GUARD_CODEX_BIN = join(d, 'codex');
    expect(binResolvable('codex', d)).toBe(true);
    process.env.GUARD_CODEX_BIN = '/nonexistent/codex';
    expect(binResolvable('codex', d)).toBe(false);
  });
});

describe('claudeRuntimeResult', () => {
  it('is silent on the shipped all-Codex family when no claude resolves', () => {
    const repo = repoWith(TEMPLATE_CONFIG);
    process.env.PATH = binDir('codex');
    const cfg = resolveGuardConfig(repo);
    expect(requiredJudgeProviders(cfg)).toEqual(new Set(['codex']));
    expect(claudeRuntimeResult(cfg, repo)).toBeNull();
  });

  it('DRIFTs (gating) when an all-Claude family has no claude runtime', () => {
    const repo = repoWith({
      ...TEMPLATE_CONFIG,
      review: { ...TEMPLATE_CONFIG.review, ...CLAUDE_FAMILY_SET },
    });
    process.env.PATH = binDir('codex');
    const cfg = resolveGuardConfig(repo);
    expect(requiredJudgeProviders(cfg)).toEqual(new Set(['claude']));
    const r = claudeRuntimeResult(cfg, repo);
    expect(r?.status).toBe('DRIFT');
    expect(r?.advisory).toBeFalsy();
    expect(r?.detail).toContain('claude CLI');
  });

  it('requires both providers for an intentional mixed family', () => {
    const repo = repoWith({
      ...TEMPLATE_CONFIG,
      review: { ...TEMPLATE_CONFIG.review, model: 'haiku' },
    });
    process.env.PATH = binDir('codex');
    const cfg = resolveGuardConfig(repo);
    expect(requiredJudgeProviders(cfg)).toEqual(new Set(['claude', 'codex']));
    expect(claudeRuntimeResult(cfg, repo)?.status).toBe('DRIFT');
    process.env.PATH = binDir('claude', 'codex');
    expect(claudeRuntimeResult(cfg, repo)).toBeNull();
  });
});

describe('familyStaleResult', () => {
  it('advisory once codex resolves again over a devkit-written pin', () => {
    const repo = repoWith(TEMPLATE_CONFIG);
    process.env.PATH = binDir('claude');
    expect(bindClaudeFamily(repo)).toBe(true);
    expect(familyStaleResult(repo)).toBeNull(); // codex still absent — pin is doing its job
    process.env.PATH = binDir('claude', 'codex');
    const r = familyStaleResult(repo);
    expect(r?.status).toBe('DRIFT');
    expect(r?.advisory).toBe(true);
    expect(r?.detail).toContain('outlived');
  });

  it('a user-authored note under the provenance key is NOT a devkit pin — exact marker required', () => {
    const repo = repoWith({
      ...TEMPLATE_CONFIG,
      review: { ...TEMPLATE_CONFIG.review, '//judgeFamily': 'operator note', model: 'haiku' },
    });
    process.env.PATH = binDir('claude', 'codex');
    expect(familyStaleResult(repo)).toBeNull();
  });

  it('silent without the provenance marker — an operator pin is never called stale', () => {
    const repo = repoWith({
      ...TEMPLATE_CONFIG,
      review: { ...TEMPLATE_CONFIG.review, model: 'haiku' },
    });
    process.env.PATH = binDir('claude', 'codex');
    expect(familyStaleResult(repo)).toBeNull();
  });
});
