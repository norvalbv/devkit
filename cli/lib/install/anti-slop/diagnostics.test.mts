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

/** One anti-slop diagnostic whose span covers `text` in `source`, at Oxlint's UTF-8 byte offset. */
function spanned(source: string, text: string, line: number): string {
  const offset = Buffer.byteLength(source.slice(0, source.indexOf(text)));
  const span = { offset, length: Buffer.byteLength(text), line, column: 1 };
  return JSON.stringify({
    diagnostics: [
      {
        message: 'Parameter value uses broad object.',
        code: 'anti-slop(no-object-parameters)',
        severity: 'error',
        filename: 'src/sample.ts',
        labels: [{ span }],
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

  it('keys a spanned finding on its span, so reflowing the line around it keeps the identity', () => {
    const oneLine = 'export function hit(judge: string, model?: unknown): void {}\n';
    const wrapped = 'export function hit(\n  judge: string,\n  model?: unknown,\n): void {}\n';
    const [a] = parseAntiSlopFindings(root(oneLine), spanned(oneLine, 'unknown', 1));
    const [b] = parseAntiSlopFindings(root(wrapped), spanned(wrapped, 'unknown', 3));

    expect(a?.context).toBe('unknown');
    expect(b?.fingerprint).toBe(a?.fingerprint);
    expect(b?.legacyFingerprint).not.toBe(a?.legacyFingerprint);
  });

  it('slices UTF-8 byte offsets, and keeps only the first line of a multi-line span', () => {
    const source = '// widen — narrows later\nconst f = (value: unknown) => value;\n';
    expect(parseAntiSlopFindings(root(source), spanned(source, 'unknown', 2))[0]?.context).toBe(
      'unknown',
    );
    const before = 'vi.mock("./a", () => ({\n  run: 1,\n}));\n';
    const after = 'vi.mock("./a", () => ({\n  run: 2,\n}));\n';
    const [x] = parseAntiSlopFindings(root(before), spanned(before, before.trimEnd(), 1));
    const [y] = parseAntiSlopFindings(root(after), spanned(after, after.trimEnd(), 1));
    expect(x?.context).toBe('vi.mock("./a", () => ({');
    expect(y?.fingerprint).toBe(x?.fingerprint);
  });

  it('keeps the whole-line identity as the legacy fingerprint, and for spanless diagnostics', () => {
    const source = 'function save(value: object) {}\n';
    const [spanless] = parseAntiSlopFindings(root(source), payload('src/sample.ts', 1));
    const [withSpan] = parseAntiSlopFindings(root(source), spanned(source, 'object', 1));

    expect(spanless?.context).toBe('function save(value: object) {}');
    expect(spanless?.legacyFingerprint).toBe(spanless?.fingerprint);
    expect(withSpan?.legacyFingerprint).toBe(spanless?.fingerprint);
  });

  it('rejects diagnostics outside the repository', () => {
    const cwd = root('function save(value: object) {}\n');
    expect(() => parseAntiSlopFindings(cwd, payload('/tmp/outside.ts', 1))).toThrow(
      'diagnostic path escapes repository',
    );
  });
});
