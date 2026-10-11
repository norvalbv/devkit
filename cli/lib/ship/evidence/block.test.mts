import { describe, expect, it } from 'vitest';
import type {
  RegressionEvidence,
  RegressionOperandEvidence,
} from '../../baseline-status/regression-evidence.mts';
import {
  callerText,
  carryEvidenceBlock,
  EVIDENCE_BEGIN,
  EVIDENCE_END,
  readEvidenceBlock,
  renderEvidenceBlock,
  upsertEvidenceBlock,
  VERDICT_SLOT,
} from './block.mts';
import { type EvidenceOutcome, notRun, outcomeFromRegression } from './outcome.mts';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const QAVIS = '<!-- qavis:start -->\nqa passed\n<!-- qavis:end -->';

function operand(sha: string, exitCode: number, failed: number): RegressionOperandEvidence {
  return {
    requestedRef: sha,
    sha,
    exitCode,
    signal: null,
    spawnError: false,
    stdoutFile: '',
    stderrFile: '',
    commandResultFile: '',
    stdoutSha256: '',
    stderrSha256: '',
    commandResultSha256: '',
    reportFile: null,
    reportSha256: null,
    reportError: null,
    testCounts: { total: 1, passed: 1 - failed, failed, skipped: 0, todo: 0 },
    failures: failed
      ? [{ fullName: 'value is fixed', message: 'expected <!-- devkit:evidence:end --> $& here' }]
      : [],
    fileErrors: [],
  };
}

const evidence: RegressionEvidence = {
  schema: 4,
  status: 'captured',
  createdAt: '2026-10-10T00:00:00.000Z',
  reason: '1 of 1 red-failing tests passed on green',
  command: {
    argv: ['vitest', 'run', 'src/value.test.mjs'],
    callerPrefix: '',
    vitestReport: 'r.json',
  },
  red: operand('c'.repeat(40), 1, 1),
  green: operand(HEAD, 0, 0),
  dependency: { source: null, mutableStoreException: false },
  cleanup: { redCloneRemoved: true, greenCloneRemoved: true },
  callerBoundarySamples: { beforeSha256: 'x', afterSha256: 'x', matched: true },
};

const captured: EvidenceOutcome = {
  status: 'captured',
  reason: null,
  detail: evidence.reason,
  headSha: HEAD,
  baseSha: BASE,
};

describe('evidence block', () => {
  it('records both SHAs, the command, both runs and their counts, and reads back', () => {
    const block = renderEvidenceBlock(captured, evidence);

    expect(block.startsWith(EVIDENCE_BEGIN)).toBe(true);
    expect(block.endsWith(EVIDENCE_END)).toBe(true);
    expect(block).toContain(`Head \`${HEAD.slice(0, 12)}\` · base \`${BASE.slice(0, 12)}\``);
    expect(block).toContain('| red | PR base + PR test files `cccccccccccc` | 1 | 0 | 1 | 0 |');
    expect(block).toContain('| green | PR head `aaaaaaaaaaaa` | 0 | 1 | 0 | 0 |');
    expect(block).toContain('"src/value.test.mjs"');
    expect(block).toContain('not proof of causality');
    expect(block).toContain(`${VERDICT_SLOT}\n`);
    expect(readEvidenceBlock(`intro\n\n${block}\n`, HEAD)).toEqual({ ...captured, stale: false });
  });

  it('reads a block produced at another head as stale', () => {
    const block = renderEvidenceBlock(captured, evidence);
    expect(readEvidenceBlock(block, 'f'.repeat(40))?.stale).toBe(true);
  });

  it('names the abstention reason and renders no runs when nothing was captured', () => {
    const block = renderEvidenceBlock(notRun('docs-only', 'only Markdown', HEAD, BASE), null);
    expect(block).toContain('**not-run (docs-only)**: only Markdown');
    expect(block).not.toContain('| red |');
    expect(readEvidenceBlock(block, HEAD)?.reason).toBe('docs-only');
  });

  it('fills the reserved verdict line when given one', () => {
    const block = renderEvidenceBlock(captured, evidence, '**Verdict:** human-review');
    expect(block).toContain(`${VERDICT_SLOT} **Verdict:** human-review\n`);
  });

  it('keeps marker text and comment closers in content from ending the block or its data', () => {
    const hostile = { ...captured, detail: 'boom --> <!-- devkit:evidence:end --> tail' };
    const block = renderEvidenceBlock(hostile, evidence);

    expect(block.split(EVIDENCE_END)).toHaveLength(2);
    expect(block.split(EVIDENCE_BEGIN)).toHaveLength(2);
    expect(readEvidenceBlock(block, HEAD)?.detail).toBe(hostile.detail);
  });

  it('replaces the block in place, keeping caller text and a qavis block byte for byte', () => {
    const old = renderEvidenceBlock({ ...captured, headSha: 'f'.repeat(40) }, null);
    const body = `## Problem\n\nx $& y\n\n${old}\n\n${QAVIS}\n`;
    const next = renderEvidenceBlock(captured, evidence);

    const updated = upsertEvidenceBlock(body, next);

    expect(updated).toBe(`## Problem\n\nx $& y\n\n${next}\n\n${QAVIS}\n`);
    expect(upsertEvidenceBlock('', next)).toBe(`${next}\n`);
    expect(upsertEvidenceBlock('text\n\n', next)).toBe(`text\n\n${next}\n`);
  });

  it('treats markers quoted inline in prose as text, never as the block', () => {
    const prose = `Ship writes between \`${EVIDENCE_BEGIN}\` and \`${EVIDENCE_END}\` in the body.\n`;
    const block = renderEvidenceBlock(captured, evidence);

    expect(readEvidenceBlock(prose, HEAD)).toBeNull();
    expect(upsertEvidenceBlock(prose, block)).toBe(`${prose}\n${block}\n`);
    expect(upsertEvidenceBlock(`${prose}\n${block}\n`, block)).toBe(`${prose}\n${block}\n`);
  });

  it('drops a pasted block from caller text and defuses a stray marker', () => {
    const pasted = renderEvidenceBlock(captured, evidence);
    const cleaned = callerText(`keep\n${pasted}\nquote <!-- devkit:evidence:begin --> here`);

    expect(cleaned).not.toContain(EVIDENCE_BEGIN);
    expect(cleaned.startsWith('keep\n\nquote ')).toBe(true);
    expect(readEvidenceBlock(cleaned, HEAD)).toBeNull();
  });

  it('carries the PR block into an explicit replacement body', () => {
    const current = `old text\n\n${renderEvidenceBlock(captured, evidence)}\n`;
    const block = renderEvidenceBlock(captured, evidence);

    expect(carryEvidenceBlock('new text\n', current)).toBe(`new text\n\n${block}\n`);
    expect(carryEvidenceBlock('new text\n', 'no block')).toBe('new text\n');
  });

  it('reads an absent or malformed block as null', () => {
    expect(readEvidenceBlock('plain body', HEAD)).toBeNull();
    const broken = `${EVIDENCE_BEGIN}\n<!-- devkit:evidence:data {"status":"proved"} -->\n${EVIDENCE_END}`;
    expect(readEvidenceBlock(broken, HEAD)).toBeNull();
  });
});

describe('evidence outcome from a regression capture', () => {
  const skippedGreen = {
    ...evidence.green,
    testCounts: { total: 1, passed: 0, failed: 0, skipped: 1, todo: 0 },
  };
  it.each([
    ['a capture stays captured', evidence, { status: 'captured', reason: null }],
    [
      'a red build failure stays inconclusive',
      { ...evidence, status: 'inconclusive' as const, reason: 'red failed only at file level' },
      { status: 'inconclusive', reason: null, detail: 'red failed only at file level' },
    ],
    [
      'tests that all skip on this host abstain',
      {
        ...evidence,
        status: 'inconclusive' as const,
        reason: 'expected red nonzero',
        green: skippedGreen,
      },
      { status: 'not-run', reason: 'platform-skipped' },
    ],
  ])('%s', (_case, capture, expected) => {
    expect(outcomeFromRegression(capture, HEAD, BASE)).toMatchObject({
      ...expected,
      headSha: HEAD,
      baseSha: BASE,
    });
  });
});
