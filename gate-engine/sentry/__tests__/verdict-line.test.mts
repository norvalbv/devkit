import { describe, expect, it } from 'vitest';
import { gateVerdictLine, reportLine } from '../verdict-line.mts';

describe('reportLine (report-mode formatting)', () => {
  it('formats a verdict + evidence, and the no-verdict fallback', () => {
    expect(reportLine({ verdict: 'MONITOR', evidence: 'executor path' })).toBe(
      'sentry-judge: MONITOR — executor path',
    );
    expect(reportLine({ verdict: 'SKIP', evidence: '' })).toBe('sentry-judge: SKIP'); // no evidence
    expect(reportLine(null)).toContain('no verdict');
    expect(reportLine({ verdict: 'SKIP', evidence: '', cached: true })).toBe(
      'sentry-judge: SKIP (cached)',
    );
  });
});

describe('gateVerdictLine (one gate-log line per judged run)', () => {
  it('renders a judged SKIP as PASS, never with the "verified nothing" SKIP token', () => {
    expect(gateVerdictLine({ verdict: 'SKIP', evidence: '' })).toBe('sentry-judge: PASS');
    const line = gateVerdictLine({ verdict: 'SKIP', evidence: 'pure UI', cached: true });
    expect(line).toBe('sentry-judge: PASS (cached) — pure UI');
    expect(line).not.toContain('SKIP');
  });

  it('keeps the MONITOR warning and marks a cached replay', () => {
    expect(gateVerdictLine({ verdict: 'MONITOR', evidence: 'executor path' })).toBe(
      '⚠️  sentry-advisory: MONITOR — consider a Sentry capture (executor path).',
    );
    expect(gateVerdictLine({ verdict: 'MONITOR', evidence: '', cached: true })).toBe(
      '⚠️  sentry-advisory: MONITOR (cached) — consider a Sentry capture.',
    );
  });

  it('names an unavailable judge and an inconclusive vote differently', () => {
    const outage = gateVerdictLine(null);
    const tie = gateVerdictLine({ verdict: null, evidence: '' });
    expect(outage).toContain('SKIPPED — no verdict (judge unavailable)');
    expect(tie).toContain('SKIPPED — no confident verdict (samples split or unparseable)');
    for (const line of [outage, tie]) expect(line).toMatch(/^⚠️ {2}sentry-judge: .*unjudged\.$/);
  });
});
