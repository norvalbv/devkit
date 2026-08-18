import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { groupFindings, parseAntiSlopFindings } from './diagnostics.mts';

const roots: string[] = [];

function root(source: string): string {
  const cwd = mkdtempSync(join(tmpdir(), 'anti-slop-fingerprint-'));
  roots.push(cwd);
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'sample.ts'), source);
  return cwd;
}

function payload(filename: string, line: number, severity = 'error'): string {
  return JSON.stringify({
    diagnostics: [
      {
        message: '  Parameter  value uses broad object.  ',
        code: 'anti-slop(no-object-parameters)',
        severity,
        filename,
        labels: [{ span: { line, column: 3 } }],
      },
      {
        message: 'native finding',
        code: 'eslint(no-debugger)',
        severity: 'error',
        filename,
      },
    ],
  });
}

afterEach(() => {
  for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe('anti-slop fingerprints', () => {
  it('is stable across checkout roots, line movement, CRLF, and diagnostic whitespace', () => {
    const first = root('function save(value: object) {}\n');
    const second = root('\r\nfunction   save(value: object) {}\r\n');
    const a = parseAntiSlopFindings(first, payload('src/sample.ts', 1))[0];
    const b = parseAntiSlopFindings(second, payload(join(second, 'src', 'sample.ts'), 2))[0];

    expect(a).toMatchObject({
      ruleId: 'anti-slop/no-object-parameters',
      file: 'src/sample.ts',
      diagnostic: 'Parameter value uses broad object.',
      context: 'function save(value: object) {}',
    });
    expect(b?.context).toBe('function save(value: object) {}');
    expect(b?.fingerprint).toBe(a?.fingerprint);
  });

  it('filters other rules and groups identical occurrences with error taking precedence', () => {
    const cwd = root('function save(value: object) {}\n');
    const findings = parseAntiSlopFindings(cwd, payload('src/sample.ts', 1, 'warning'));
    expect(findings).toHaveLength(1);
    const one = findings[0];
    if (!one) throw new Error('expected one anti-slop finding');
    const groups = groupFindings([one, { ...one, severity: 'error', column: 20 }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 2, severity: 'error' });
  });

  it('rejects diagnostics outside the repository', () => {
    const cwd = root('function save(value: object) {}\n');
    expect(() => parseAntiSlopFindings(cwd, payload('/tmp/outside.ts', 1))).toThrow(
      'diagnostic path escapes repository',
    );
  });
});
