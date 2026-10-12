import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expandCommand, readEvidenceConfig } from './config.mts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repoWith(configJson?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'evidence-config-'));
  roots.push(root);
  if (configJson !== undefined) writeFileSync(join(root, 'guard.config.json'), configJson);
  return root;
}

const COMMAND = ['vitest', 'run', '--outputFile.json={report}', '{files}'];

describe('guard.config.json evidence', () => {
  it('reads an absent file or key as not configured', () => {
    expect(readEvidenceConfig(repoWith())).toBeNull();
    expect(readEvidenceConfig(repoWith(JSON.stringify({ sourceExtensions: ['ts'] })))).toBeNull();
  });

  it('fills the support globs and the bound when they are omitted', () => {
    expect(
      readEvidenceConfig(repoWith(JSON.stringify({ evidence: { command: COMMAND } }))),
    ).toEqual({
      command: COMMAND,
      supportPaths: [],
      timeoutSeconds: 120,
    });
  });

  it.each([
    ['no {files} element', { command: ['vitest', '--outputFile.json={report}'] }, /exactly one/],
    ['two {files} elements', { command: [...COMMAND, '{files}'] }, /exactly one/],
    ['{files} inside an argument', { command: ['vitest', '{report}', 'x={files}'] }, /exactly one/],
    ['no {report}', { command: ['vitest', '{files}'] }, /\{report\}/],
    ['a zero bound', { command: COMMAND, timeoutSeconds: 0 }, /timeoutSeconds/],
    ['a fractional bound', { command: COMMAND, timeoutSeconds: 1.5 }, /timeoutSeconds/],
    ['a brace glob', { command: COMMAND, supportPaths: ['src/{a,b}/**'] }, /only \*, \*\* and \?/],
    ['an unknown key', { command: COMMAND, shell: true }, /evidence/],
  ])('refuses %s, naming the field', (_case, evidence, message) => {
    expect(() => readEvidenceConfig(repoWith(JSON.stringify({ evidence })))).toThrow(message);
  });

  it('spreads the test paths into {files} and names the report in {report}', () => {
    expect(expandCommand(COMMAND, ['a.test.ts', 'b.test.ts'], 'r.json')).toEqual([
      'vitest',
      'run',
      '--outputFile.json=r.json',
      'a.test.ts',
      'b.test.ts',
    ]);
  });
});
