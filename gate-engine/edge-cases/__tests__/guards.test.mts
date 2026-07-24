/**
 * Pins the pre-registered purity rules of the synthetic guard generator (guards-generate.mts).
 * A guard row on which a judge could raise a LEGITIMATE finding (config/build/lockfile/CI paths,
 * or a fenced code example inside prose) would score good configs as hallucinating — these rules
 * are what make "any finding on a guard row = hallucination" true by construction.
 */

import { describe, expect, it } from 'vitest';
import { hasFencedBlock, isPureDocsPath, PINNED } from '../eval/guards-generate.mts';

describe('synthetic guard purity rules (pre-registered)', () => {
  it('accepts prose paths', () => {
    for (const p of [
      'README.md',
      'docs/decisions/INDEX.md',
      'user-docs/flows.mdx',
      'LICENSE',
      'CONTRIBUTING.md',
      'agents/api-security-reviewer.md',
    ])
      expect(isPureDocsPath(p), p).toBe(true);
  });

  it('rejects code-adjacent paths a judge may legitimately flag', () => {
    for (const p of [
      'package.json',
      'bun.lockb',
      'vitest.config.mts',
      '.github/workflows/ci.yml',
      'src/index.ts',
      'Makefile',
      'biome.json',
      'docs.ts', // extension wins over a docs-ish name
    ])
      expect(isPureDocsPath(p), p).toBe(false);
  });

  it('rejects diffs that add or remove fenced code blocks', () => {
    expect(hasFencedBlock('+ some prose\n+```ts\n+const x = 1\n+```')).toBe(true);
    expect(hasFencedBlock('-```\n-old example\n-```')).toBe(true);
    expect(hasFencedBlock('+ plain prose only\n+ more prose\n context ``` in context line')).toBe(
      false,
    );
  });

  it('generation frontier is pinned (reproducibility contract)', () => {
    expect(PINNED).toEqual({
      devkit: '86bb201f3205071fc3f9d41be2460ef6d977fb16',
      frink: '1394feb018d8a5edd99ebf274c88d0941dde50da',
    });
  });
});
