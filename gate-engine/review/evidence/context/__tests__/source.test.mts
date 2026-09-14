import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeFixture } from '../../../../decisions/eval/bench.mts';
import { gitCached } from '../../staged-git.mts';
import { buildEvidencePacket } from '../packets.mts';
import {
  PREPARATION_LIMITS,
  prepareContextSource,
  relativeModule,
  resolveContextMode,
} from '../source.mts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(base: Record<string, string>, staged: Record<string, string | null>) {
  const fx = materializeFixture({ repo: { base, staged } });
  cleanups.push(fx.cleanup);
  return fx;
}
describe('bounded snapshot discovery', () => {
  it('reads staged and base counterparts despite unstaged repairs and later index edits', () => {
    const fx = fixture(
      {
        'a.ts': "import { value } from './helper';\nexport const result = value;\n",
        'helper.ts': 'export const value = 1;\n',
      },
      {
        'a.ts': "import { value } from './helper';\nexport const result = value + 1;\n",
        'helper.ts': 'export const value = 2;\n',
      },
    );
    const source = prepareContextSource(fx.repo, ['a.ts']);
    const owned = gitCached(fx.repo, [], ['a.ts']);
    writeFileSync(join(fx.repo, 'helper.ts'), 'UNSTAGED_REPAIR\n');
    const packet = buildEvidencePacket(source, ['a.ts'], owned);
    expect(packet.input).toContain('export const value = 1;');
    expect(packet.input).toContain('export const value = 2;');
    expect(packet.input).not.toContain('UNSTAGED_REPAIR');
    execFileSync('git', ['add', 'helper.ts'], { cwd: fx.repo });
    expect(buildEvidencePacket(source, ['a.ts'], owned)).toEqual(packet);
    expect(packet.instructions).toContain(source.staged);
  });
  it('supplies enclosing function context outside the ordinary diff window', () => {
    const before = `export function classify(value) {\n${Array.from({ length: 30 }, (_, i) => `  // context ${i}`).join('\n')}\n  return value;\n}\n`;
    const fx = fixture(
      { 'a.js': before },
      { 'a.js': before.replace('return value;', 'return null;') },
    );
    const source = prepareContextSource(fx.repo, fx.staged);
    expect(gitCached(fx.repo, [], fx.staged)).not.toContain('// context 1\n');
    expect(source.segments.get('a.js')?.[0].content).toContain('// context 1\n');
  });
  it('keeps rename/deletion ownership and escaped path names', () => {
    const fx = fixture(
      { 'old name.ts': 'export const value = 1;\n', 'gone.ts': 'export const gone = 1;\n' },
      { 'old name.ts': null, 'new name.ts': 'export const value = 1;\n', 'gone.ts': null },
    );
    const source = prepareContextSource(fx.repo, ['new name.ts', 'gone.ts']);
    expect(source.segments.get('new name.ts')?.[0].content).toContain('rename from old name.ts');
    expect(source.segments.get('gone.ts')?.[0].content).toContain('-export const gone = 1;');
  });
  it('keeps ordinary space-containing paths in evidence and chunk ownership', () => {
    const fx = fixture(
      { 'a b.ts': 'export const a = 1;\n' },
      { 'a b.ts': 'export const a = 2;\n' },
    );
    const source = prepareContextSource(fx.repo, ['a b.ts']);
    expect(source.segments.get('a b.ts')?.[0].content).toContain('+export const a = 2;');
  });
  it('marks ambiguous, missing, CommonJS and computed lookups without inventing a relationship', () => {
    const fx = fixture(
      {
        'a.js': 'export const a = 0;',
        'b.ts': 'export const b = 1;',
        'b.js': 'export const b = 2;',
      },
      {
        'a.js':
          "import './b'; import './missing'; require('./c'); import(name); export const a = 1;",
      },
    );
    const source = prepareContextSource(fx.repo, ['a.js']);
    const notes = source.notes.get('a.js')!.join('\n');
    expect(notes).toContain('unresolved or ambiguous');
    expect(notes).toContain('CommonJS');
    expect(notes).toContain('computed');
    expect(source.segments.get('a.js')!.every((s) => s.side === 'function-diff')).toBe(true);
    expect(relativeModule('src/a.ts', '../../escape', new Set(['../escape']))).toBeNull();
  });
  it('prioritizes a changed literal dynamic import beyond the unchanged import budget', () => {
    const prefix = Array.from({ length: 20 }, (_, i) => `import './external-${i}.js';`).join('\n');
    const fx = fixture(
      {
        'a.js': `${prefix}\nexport const load = () => import('./before.js');\n`,
        'before.js': 'export const before = 1;\n',
        'after.js': 'export const after = 1;\n',
      },
      { 'a.js': `${prefix}\nexport const load = () => import('./after.js');\n` },
    );
    const source = prepareContextSource(fx.repo, ['a.js']);
    expect(
      source.segments.get('a.js')!.some((s) => s.path === 'after.js' && s.side === 'staged'),
    ).toBe(true);
    expect(
      source.segments.get('a.js')!.some((s) => s.path === 'before.js' && s.side === 'base'),
    ).toBe(true);
    expect(source.notes.get('a.js')!.join('\n')).toContain('truncated after 16 imports');
  });
  it('bounds large blob reads and caps support without sacrificing the owned diff', () => {
    const fx = fixture(
      {
        'a.js': "import './big'; export const a = 1;",
        'big.js': 'x'.repeat(PREPARATION_LIMITS.blobBytes + 1),
      },
      { 'a.js': "import './big'; export const a = 2;" },
    );
    const source = prepareContextSource(fx.repo, ['a.js']);
    expect(source.notes.get('a.js')!.join('\n')).toContain('related source unavailable');
    source.segments.set(
      'a.js',
      Array.from({ length: 5 }, (_, i) => ({
        path: `${i}.ts`,
        side: 'staged' as const,
        content: 'é'.repeat(15_000),
      })),
    );
    const diff = gitCached(fx.repo, [], ['a.js']);
    const packet = buildEvidencePacket(source, ['a.js'], diff);
    expect(packet.input).toContain(diff);
    expect(packet.receipt.supportCharactersShown).toBe(24_000);
    expect(packet.receipt.supportBytesShown).toBeGreaterThan(packet.receipt.supportCharactersShown);
    expect(packet.receipt.supportTruncated).toBe(3);
    expect(packet.receipt.supportOmitted).toBe(2);
    const full = buildEvidencePacket(source, ['a.js'], 'x'.repeat(60_000));
    expect(full.input).toContain('x'.repeat(60_000));
    expect(full.receipt.supportCharactersShown).toBe(0);
  });
  it('defaults to control and rejects misspelled experiment modes', () => {
    expect(resolveContextMode('off')).toBeNull();
    expect(resolveContextMode('bounded-v1')).toBe('bounded-v1');
    expect(() => resolveContextMode('bounded-v2')).toThrow('expected off or bounded-v1');
  });
});
