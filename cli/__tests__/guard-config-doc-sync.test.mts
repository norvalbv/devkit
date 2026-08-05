// The `//review` guidance string is duplicated across every shipped guard.config.json template plus
// the example file, and it is the ONLY place a consumer is told that an empty roots array switches a
// whole domain's reviewers off. It has already drifted once — every copy still said "the 5 reviewer
// subagents" long after REVIEWERS grew to seven — so a copy that silently falls behind is the
// documented failure mode, not a hypothetical one.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REVIEWERS } from '../../gate-engine/review/reviewers.mts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const COPIES = [
  'templates/generic/guard.config.json',
  'templates/react-app/guard.config.json',
  'templates/component-lib/guard.config.json',
  'templates/electron/guard.config.json',
  'guard.config.example.json',
];

const reviewDoc = (rel: string): string =>
  (JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Record<string, string>)['//review'];

describe('the //review guidance string', () => {
  it('is byte-identical across every shipped copy', () => {
    const docs = COPIES.map(reviewDoc);
    expect(docs.every(Boolean)).toBe(true);
    expect(new Set(docs).size).toBe(1);
  });

  it('names the reviewers an empty frontendRoots actually disables', () => {
    const doc = reviewDoc(COPIES[0]);
    for (const { name } of REVIEWERS.filter((r) => r.domain === 'frontend')) {
      expect(doc).toContain(name);
    }
    // The old wording said they "exit early", which is wrong: they are never SELECTED.
    expect(doc).toContain('never selected');
    expect(doc).not.toContain('exit early');
  });

  it('no longer hardcodes a reviewer count that REVIEWERS can outgrow', () => {
    expect(reviewDoc(COPIES[0])).not.toMatch(/\b\d+ reviewer subagents\b/);
  });
});
