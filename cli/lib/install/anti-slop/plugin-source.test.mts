import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ANTI_SLOP_RULE_NAMES } from './constants.mts';
import { antiSlopPluginSource } from './managed-state.mts';

const roots: string[] = [];
const BUILT_INDEX = 'dist/anti-slop/src/index.js';
const REGISTERS_EVERY_RULE = ANTI_SLOP_RULE_NAMES.map((name) => `"${name}": rule,`).join('\n');

function pkgWith(files: string[], builtIndex = REGISTERS_EVERY_RULE): string {
  const pkg = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-source-'));
  roots.push(pkg);
  for (const file of files) {
    mkdirSync(dirname(join(pkg, file)), { recursive: true });
    writeFileSync(join(pkg, file), file === BUILT_INDEX ? builtIndex : '');
  }
  return pkg;
}

const SOURCE = ['anti-slop/src/index.ts', 'anti-slop/src/rules/a.ts'];
const BUILT = [BUILT_INDEX, 'dist/anti-slop/src/rules/a.js'];

afterEach(() => {
  for (const pkg of roots.splice(0)) rmSync(pkg, { recursive: true, force: true });
});

describe('antiSlopPluginSource', () => {
  it('projects a packaged install from its compiled source', () => {
    const pkg = pkgWith(['anti-slop/src/index.js']);
    expect(antiSlopPluginSource(pkg)).toEqual({
      root: join(pkg, 'anti-slop/src'),
      entry: './plugin/index.js',
    });
  });

  it('projects a source checkout from the tracked dist build while it mirrors source', () => {
    const pkg = pkgWith([...SOURCE, ...BUILT]);
    expect(antiSlopPluginSource(pkg)).toEqual({
      root: join(pkg, 'dist/anti-slop/src'),
      entry: './plugin/index.js',
    });
  });

  it('falls back to .ts when source gained a module the dist build lacks', () => {
    const pkg = pkgWith([...SOURCE, 'anti-slop/src/rules/b.ts', ...BUILT]);
    expect(antiSlopPluginSource(pkg)).toEqual({
      root: join(pkg, 'anti-slop/src'),
      entry: './plugin/index.ts',
    });
  });

  it('falls back to .ts when the mirroring dist index predates a newly added rule', () => {
    const stale = REGISTERS_EVERY_RULE.replace('"no-elapsed-time-assertions": rule,', '');
    const pkg = pkgWith([...SOURCE, ...BUILT], stale);
    expect(antiSlopPluginSource(pkg).entry).toBe('./plugin/index.ts');
  });

  it('does not count a rule name that appears outside a registration key', () => {
    const mentioned = REGISTERS_EVERY_RULE.replace(
      '"no-elapsed-time-assertions": rule,',
      '// "no-elapsed-time-assertions"',
    );
    const pkg = pkgWith([...SOURCE, ...BUILT], mentioned);
    expect(antiSlopPluginSource(pkg).entry).toBe('./plugin/index.ts');
  });

  it('falls back to .ts when there is no dist build', () => {
    const pkg = pkgWith(SOURCE);
    expect(antiSlopPluginSource(pkg).entry).toBe('./plugin/index.ts');
  });

  it('throws when no plugin entry exists', () => {
    expect(() => antiSlopPluginSource(pkgWith([]))).toThrow(
      'bundled anti-slop plugin entry is missing',
    );
  });
});
