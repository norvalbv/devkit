import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexRuntimeResult } from '../lib/doctor/guard-config-checks.mts';

// sc-2107: a gpt-* judge model with no resolvable codex binary is an undetected fail-open (every
// reviewer inconclusive, gate exit 2, nothing reviewed). This check gives it a doctor signal.

const envKeys = [
  'GUARD_CODEX_BIN',
  'GUARD_REVIEW_MODEL',
  'GUARD_REVIEW_ESCALATION_MODEL',
  'GUARD_CORRECTNESS_MODEL',
  'PATH',
] as const;
const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
const roots: string[] = [];

beforeEach(() => {
  for (const key of envKeys) savedEnv[key] = process.env[key];
  delete process.env.GUARD_CODEX_BIN;
  delete process.env.GUARD_REVIEW_MODEL;
  delete process.env.GUARD_REVIEW_ESCALATION_MODEL;
  delete process.env.GUARD_CORRECTNESS_MODEL;
});

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const cfg = (model: string, correctness: string, escalation = 'opus') => ({
  review: {
    backendRoots: [],
    frontendRoots: [],
    model,
    escalationModel: escalation,
    correctnessModel: correctness,
  },
});

describe('codexRuntimeResult', () => {
  it('is silent when no gpt-* model is resolved (most installs)', () => {
    expect(codexRuntimeResult(cfg('haiku', 'sonnet'))).toBeNull();
  });

  it('DRIFTs when a gpt-* model resolves but no codex binary does', () => {
    process.env.PATH = '/nonexistent-doctor-codex';
    const res = codexRuntimeResult(cfg('gpt-5.6-sol', 'sonnet'));
    expect(res?.status).toBe('DRIFT');
    expect(res?.detail).toContain('gpt-5.6-sol');
    // A GUARD_CODEX_BIN pin pointing at nothing is still unresolvable — and named in the detail.
    process.env.GUARD_CODEX_BIN = '/nonexistent-doctor-codex/codex';
    expect(codexRuntimeResult(cfg('haiku', 'gpt-5.6-terra'))?.detail).toContain('GUARD_CODEX_BIN');
  });

  it('is silent only for an EXECUTABLE codex file — a directory or mode-644 file still DRIFTs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devkit-codex-bin-'));
    roots.push(dir);
    // A directory at the pin exists but cannot judge anything.
    process.env.GUARD_CODEX_BIN = dir;
    expect(codexRuntimeResult(cfg('gpt-5.6-sol', 'sonnet'))?.status).toBe('DRIFT');
    writeFileSync(join(dir, 'codex'), '#!/bin/sh\n');
    chmodSync(join(dir, 'codex'), 0o644);
    process.env.GUARD_CODEX_BIN = join(dir, 'codex');
    expect(codexRuntimeResult(cfg('gpt-5.6-sol', 'sonnet'))?.status).toBe('DRIFT');
    chmodSync(join(dir, 'codex'), 0o755);
    expect(codexRuntimeResult(cfg('gpt-5.6-sol', 'gpt-5.6-sol'))).toBeNull();
    delete process.env.GUARD_CODEX_BIN;
    process.env.PATH = dir;
    expect(codexRuntimeResult(cfg('gpt-5.6-sol', 'sonnet'))).toBeNull();
  });

  it('the resolvers give env precedence: an env override to a claude model silences the check', () => {
    process.env.PATH = '/nonexistent-doctor-codex';
    process.env.GUARD_REVIEW_MODEL = 'haiku';
    process.env.GUARD_CORRECTNESS_MODEL = 'sonnet';
    process.env.GUARD_REVIEW_ESCALATION_MODEL = 'opus';
    expect(codexRuntimeResult(cfg('gpt-5.6-sol', 'gpt-5.6-sol', 'gpt-5.6-sol'))).toBeNull();
  });

  it('the escalation model is a judge too: a gpt-* escalator alone routes through codex', () => {
    process.env.PATH = '/nonexistent-doctor-codex';
    const res = codexRuntimeResult(cfg('haiku', 'sonnet', 'gpt-5.6-sol'));
    expect(res?.status).toBe('DRIFT');
    expect(res?.detail).toContain('gpt-5.6-sol');
    expect(res?.remediation).toContain('review.escalationModel');
  });

  it('a model@effort spec the adapter would refuse DRIFTs now, naming the effort — not at the next commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devkit-codex-bin-'));
    roots.push(dir);
    writeFileSync(join(dir, 'codex'), '#!/bin/sh\n');
    chmodSync(join(dir, 'codex'), 0o755);
    process.env.GUARD_CODEX_BIN = join(dir, 'codex');
    expect(codexRuntimeResult(cfg('gpt-5.6-terra@high', 'gpt-5.6-sol'))).toBeNull();
    const res = codexRuntimeResult(cfg('gpt-5.6-terra@ultra', 'gpt-5.6-sol'));
    expect(res?.status).toBe('DRIFT');
    expect(res?.detail).toContain('"ultra"');
  });

  it('an @effort suffix on a CLAUDE model DRIFTs even with no codex in play — claude would receive it verbatim', () => {
    const res = codexRuntimeResult(cfg('sonnet@high', 'sonnet', 'opus'));
    expect(res?.status).toBe('DRIFT');
    expect(res?.detail).toContain('sonnet@high');
  });
});
