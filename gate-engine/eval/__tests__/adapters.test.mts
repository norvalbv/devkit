import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseBaseline,
  parseCompleteness,
  parseConventions,
  parseCritique,
  parseDecisions,
  parseEdgeCases,
  parseReviewer,
  parseSentry,
  wilson,
} from '../adapters.mts';

const ROOT = join(import.meta.dirname, '..', '..', '..');

function json(path: string) {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

describe('benchmark adapters', () => {
  it('parses the committed critique baseline with raw counts and acceptance', () => {
    const parsed = parseCritique(json('gate-engine/critique/eval/results.baseline.json'));
    expect(parsed.acceptance.accepted).toBe(true);
    expect(parsed.metrics.find((metric) => metric.id === 'recall')).toMatchObject({
      numerator: 23,
      denominator: 24,
      direction: 'higher',
    });
    expect(parsed.metrics.find((metric) => metric.id === 'decoy-flag-rate')).toMatchObject({
      numerator: 2,
      denominator: 20,
      direction: 'lower',
    });
  });

  it('parses completeness and conventions without pretending they share a trend', () => {
    const completeness = parseCompleteness(json('gate-engine/review/eval/results.baseline.json'));
    const conventions = parseConventions(
      json('gate-engine/review/eval/conventions/results.baseline.json'),
    );
    expect(completeness.metrics[0]).toMatchObject({ numerator: 25, denominator: 35 });
    expect(completeness.metrics[1]).toMatchObject({ numerator: 2, denominator: 27 });
    expect(conventions.metrics[0]).toMatchObject({ numerator: 18, denominator: 18 });
    expect(conventions.metrics[1]).toMatchObject({ numerator: 1, denominator: 14 });
  });

  it('parses native reviewer sections and preserves normalized namespaced rows', () => {
    const parsed = parseReviewer({
      sections: {
        'correctness-reviewer@sonnet@cascade-off': {
          model: 'sonnet',
          cascade: false,
          rows: {
            gold1: { expected: 'FAIL', okFirst: true, okFinal: true, finalStatus: 'fail' },
            clean1: { expected: 'PASS', okFirst: true, okFinal: true, finalStatus: 'pass' },
          },
          metrics: {
            rows: 2,
            gold: 1,
            decoys: 1,
            firstFailRecall: { k: 1, n: 1 },
            firstCleanPass: { k: 1, n: 1 },
            inconclusive: {},
          },
        },
      },
    });
    expect(parsed.acceptance.accepted).toBe(true);
    expect(parsed.metrics.map((metric) => metric.id)).toEqual([
      'correctness-reviewer@sonnet@cascade-off:first-fail-recall',
      'correctness-reviewer@sonnet@cascade-off:first-clean-pass',
    ]);
    expect(parsed.rows).toMatchObject({
      'correctness-reviewer@sonnet@cascade-off:gold1': { ok: true },
      'correctness-reviewer@sonnet@cascade-off:clean1': { ok: true },
    });
  });

  it('parses native decisions, sentry, and a locked edge-case no-ship result', () => {
    const decisions = parseDecisions({
      detect: {
        correct: 45,
        total: 49,
        runs: 3,
        decision: { tp: 8, fp: 0, fn: 1, precision: 1, recall: 8 / 9 },
        rows: { detect1: { ok: true } },
      },
      alignment: {
        cascade: true,
        runs: 1,
        final: { contradict: { tp: 8, fp: 1, fn: 0 } },
        outages: 0,
        rows: { alignment1: { ok: true, stable: true } },
      },
      depth: { correct: 34, total: 34, runs: 3, rows: { depth1: { ok: true } } },
    });
    expect(decisions.acceptance.accepted).toBe(true);
    expect(decisions.metrics).toHaveLength(4);
    expect(decisions.metrics.find((metric) => metric.id === 'decision-recall')).toMatchObject({
      numerator: 8,
      denominator: 9,
    });
    expect(
      decisions.metrics.find((metric) => metric.id === 'contradiction-precision'),
    ).toMatchObject({ numerator: 8, denominator: 9 });
    expect(decisions.rows).toHaveProperty('detect:detect1');
    expect(decisions.rows).toHaveProperty('alignment:alignment1');
    expect(decisions.rows).toHaveProperty('depth:depth1');

    const unstableAlignment = parseDecisions({
      detect: {
        correct: 45,
        total: 49,
        runs: 3,
        decision: { tp: 8, fp: 0, fn: 1 },
        rows: { detect1: { ok: true } },
      },
      alignment: {
        cascade: true,
        runs: 1,
        final: { contradict: { tp: 8, fp: 1, fn: 0 } },
        rows: { alignment1: { ok: true, stable: false } },
      },
      depth: { correct: 34, total: 34, runs: 3, rows: { depth1: { ok: true } } },
    });
    expect(unstableAlignment.acceptance).toMatchObject({
      accepted: false,
      reason: expect.stringContaining('unstable alignment row'),
    });

    const omittedCascade = parseDecisions({
      detect: {
        correct: 45,
        total: 49,
        runs: 3,
        decision: { tp: 8, fp: 0, fn: 1 },
        rows: { detect1: { ok: true } },
      },
      alignment: {
        runs: 1,
        firstPass: { contradict: { tp: 2, fp: 8, fn: 0 } },
        final: { contradict: { tp: 9, fp: 1, fn: 0 } },
        rows: { alignment1: { ok: true, stable: true } },
      },
      depth: { correct: 34, total: 34, runs: 3, rows: { depth1: { ok: true } } },
    });
    expect(
      omittedCascade.metrics.find((metric) => metric.id === 'contradiction-precision'),
    ).toMatchObject({ numerator: 2, denominator: 10 });
    expect(omittedCascade.acceptance.accepted).toBe(false);

    const sentry = parseSentry({
      precision: 1,
      recall: 1,
      f1: 1,
      outages: 0,
      results: [
        { id: 'monitor-1', expected: 'MONITOR', got: 'MONITOR', ok: true },
        { id: 'skip-1', expected: 'SKIP', got: 'SKIP', ok: true },
      ],
    });
    expect(sentry.acceptance.accepted).toBe(true);
    expect(sentry.metrics.find((metric) => metric.id === 'precision')).toMatchObject({
      numerator: 1,
      denominator: 1,
    });
    expect(sentry.rows).toHaveProperty('monitor-1');

    const edge = parseEdgeCases({
      C: 0.512,
      T: 0.35,
      best: 'guard-pass',
      noConfigShips: true,
      metrics: {
        'guard-pass': { macroRecall: 0.214, guardFireRate: 0.192, receiptsHit: 2 },
      },
      winnerGuardFired: { a: false },
    });
    expect(edge.acceptance).toEqual({
      accepted: true,
      reason: 'Pre-registered no-ship analysis completed',
    });
    expect(edge.metrics.find((metric) => metric.id === 'best-admissible-recall')).toMatchObject({
      value: 0.214,
      floor: 0.35,
    });
  });

  it('rejects incomplete rowless native evidence', () => {
    expect(
      parseDecisions({
        detect: { correct: 1, total: 1, decision: { tp: 1, fn: 0 } },
        alignment: { final: { contradict: { tp: 1, fp: 0 } } },
        depth: { correct: 1, total: 1 },
      }).acceptance.accepted,
    ).toBe(false);
    expect(parseSentry({ precision: 1, recall: 1, f1: 1 }).acceptance.accepted).toBe(false);
  });

  it('rejects native reviewer and decisions evidence below suite safety policy', () => {
    const reviewer = parseReviewer({
      sections: {
        'correctness-reviewer@sonnet@cascade-on': {
          model: 'sonnet',
          cascade: true,
          rows: { gold1: { okFirst: false, okFinal: false } },
          metrics: {
            firstFailRecall: { k: 0, n: 1 },
            firstCleanPass: { k: 1, n: 1 },
            blockRecall: { k: 0, n: 1 },
            cleanPass: { k: 1, n: 1 },
            inconclusive: {},
          },
        },
      },
    });
    expect(reviewer.acceptance.accepted).toBe(false);
    expect(reviewer.acceptance.reason).toMatch(/floor/i);

    const decisions = parseDecisions({
      detect: {
        correct: 1,
        total: 10,
        runs: 1,
        decision: { tp: 1, fn: 9 },
        rows: { d: { ok: false } },
      },
      alignment: {
        cascade: true,
        runs: 1,
        final: { contradict: { tp: 1, fp: 9 } },
        rows: { a: { ok: false } },
      },
      depth: { correct: 1, total: 10, runs: 1, rows: { z: { ok: false } } },
    });
    expect(decisions.acceptance.accepted).toBe(false);
    expect(decisions.acceptance.reason).toMatch(/K below 3|floor/i);
  });

  it('rejects unknown adapters and computes bounded Wilson intervals', () => {
    expect(() => parseBaseline('unknown', {})).toThrow(/Unknown benchmark adapter/);
    expect(wilson(0, 1)).toMatchObject({ method: 'wilson-95', lower: 0 });
    expect(wilson(1, 1)?.upper).toBe(1);
  });
});
