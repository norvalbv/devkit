import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAntiSlopScope } from './runner.mts';

const roots: string[] = [];

function root(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'anti-slop-scope-'));
  roots.push(cwd);
  mkdirSync(join(cwd, 'src', 'nested'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'one.ts'), 'export const one = 1;\n');
  writeFileSync(join(cwd, 'src', 'nested', 'two.ts'), 'export const two = 2;\n');
  writeFileSync(join(cwd, '-bad.ts'), 'export const bad = 3;\n');
  return cwd;
}

afterEach(() => {
  for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe('anti-slop path scope', () => {
  it('matches literal repository files/directories and rejects missing or external paths', () => {
    const cwd = root();
    const directory = resolveAntiSlopScope(cwd, ['src']);
    const file = resolveAntiSlopScope(cwd, ['src/one.ts']);
    symlinkSync(join(cwd, 'src', 'one.ts'), join(cwd, 'link.ts'));
    const link = resolveAntiSlopScope(cwd, ['link.ts']);

    expect(directory.includes('src/one.ts')).toBe(true);
    expect(directory.includes('src/nested/two.ts')).toBe(true);
    expect(directory.includes('outside.ts')).toBe(false);
    expect(file.includes('src/one.ts')).toBe(true);
    expect(file.includes('src/nested/two.ts')).toBe(false);
    expect(link.includes('link.ts')).toBe(true);
    expect(link.includes('src/one.ts')).toBe(false);
    expect(resolveAntiSlopScope(cwd, ['--', '-bad.ts']).includes('-bad.ts')).toBe(true);
    expect(() => resolveAntiSlopScope(cwd, ['missing.ts'])).toThrow('does not exist');
    expect(() => resolveAntiSlopScope(cwd, ['/tmp'])).toThrow('escapes repository');
  });
});
