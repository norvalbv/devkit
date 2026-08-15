import { describe, expect, it } from 'vitest';
import { analyzeDiagnostics, diagnosticDigest } from '../performance/diagnostics.mts';

describe('performance diagnostic adapters', () => {
  it('normalizes Biome diagnostics without retaining fixture paths', () => {
    const result = analyzeDiagnostics(
      'biome-json',
      `${JSON.stringify({
        summary: { unchanged: 1 },
        diagnostics: [
          {
            category: 'lint/suspicious/noDoubleEquals',
            severity: 'error',
            description: 'Use   strict equality',
            location: { path: 'src/a.ts', start: { line: 3, column: 4 } },
          },
        ],
      })}\n`,
      'unstable JSON warning',
      '/tmp/fixture',
      '/tmp/fixture/packages/app',
    );
    expect(result).toEqual({
      diagnostics: [
        {
          semanticRuleId: 'lint/suspicious/noDoubleEquals',
          relativePath: 'packages/app/src/a.ts',
          line: 3,
          column: 4,
          severity: 'error',
          normalizedMessage: 'Use strict equality',
        },
      ],
    });
  });

  it('normalizes ESLint records and reports actual processed paths', () => {
    const result = analyzeDiagnostics(
      'eslint-json',
      JSON.stringify([
        {
          filePath: '/tmp/fixture/src/a.ts',
          messages: [{ ruleId: 'max-lines', severity: 2, line: 4, column: 2, message: 'Too long' }],
        },
      ]),
      '',
      '/tmp/fixture',
    );
    expect(result.reportedProcessedFiles).toEqual(['src/a.ts']);
    expect(result.diagnostics[0]).toMatchObject({
      semanticRuleId: 'max-lines',
      relativePath: 'src/a.ts',
      line: 4,
      column: 2,
      severity: 'error',
    });
  });

  it('normalizes tsc text and produces an order-independent digest', () => {
    const output = [
      'src/b.ts(2,3): error TS2322: Type mismatch',
      'src/a.ts(1,1): error TS2304: Missing name',
    ].join('\n');
    const first = analyzeDiagnostics('tsc-text', output, '', '/tmp/fixture').diagnostics;
    const second = analyzeDiagnostics(
      'tsc-text',
      output.split('\n').reverse().join('\n'),
      '',
      '/tmp/fixture',
    ).diagnostics;
    expect(diagnosticDigest(first)).toBe(diagnosticDigest(second));
    expect(first.map((diagnostic) => diagnostic.relativePath)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('uses the first diagnostic span when a TypeScript message cites another location', () => {
    const result = analyzeDiagnostics(
      'tsc-text',
      'src/a.ts(1,1): error TS2554: See src/b.ts(2,2): error TS0000: for details.',
      '',
      '/tmp/fixture',
    );
    expect(result.diagnostics).toEqual([
      {
        semanticRuleId: 'TS2554',
        relativePath: 'src/a.ts',
        line: 1,
        column: 1,
        severity: 'error',
        normalizedMessage: 'See src/b.ts(2,2): error TS0000: for details.',
      },
    ]);
  });
});
