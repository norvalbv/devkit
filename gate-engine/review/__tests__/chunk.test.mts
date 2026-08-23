import { describe, expect, it } from 'vitest';
import { identityBytesByPath, packDiffIntoChunks } from '../lens/chunk.mts';

function segment(path: string, lines: number): string {
  const head = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${lines} @@\n`;
  return (
    head + Array.from({ length: lines }, (_, i) => `+const v${i} = '${'x'.repeat(30)}';\n`).join('')
  );
}

describe('identityBytesByPath', () => {
  it('maps each file to the byte size of its normalized diff identity', () => {
    const diff = segment('src/a.ts', 10) + segment('src/b.ts', 40);
    const bytes = identityBytesByPath(diff);
    expect([...bytes.keys()].sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(bytes.get('src/b.ts')!).toBeGreaterThan(bytes.get('src/a.ts')!);
  });
});

describe('packDiffIntoChunks', () => {
  it('packs whole files first-fit in sorted path order, never splitting a file', () => {
    const files = ['src/c.ts', 'src/a.ts', 'src/b.ts'];
    const diff = segment('src/a.ts', 30) + segment('src/b.ts', 30) + segment('src/c.ts', 30);
    const per = identityBytesByPath(diff).get('src/a.ts')!;
    const { chunks } = packDiffIntoChunks(files, diff, per * 2 + 10);
    expect(chunks).toEqual([['src/a.ts', 'src/b.ts'], ['src/c.ts']]);
  });

  it('gives an over-cap file its own chunk instead of splitting it', () => {
    const diff = segment('src/big.ts', 200) + segment('src/small.ts', 5);
    const { chunks } = packDiffIntoChunks(['src/big.ts', 'src/small.ts'], diff, 1_000);
    expect(chunks[0]).toEqual(['src/big.ts']);
    expect(chunks[1]).toEqual(['src/small.ts']);
  });

  it('is deterministic for the same inputs (checkpoint keys depend on it)', () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/m${String(i).padStart(2, '0')}.ts`);
    const diff = files.map((f) => segment(f, 20)).join('');
    const a = packDiffIntoChunks(files, diff, 3_000).chunks;
    const b = packDiffIntoChunks([...files].reverse(), diff, 3_000).chunks;
    expect(a).toEqual(b);
  });

  it('keeps every file exactly once across chunks', () => {
    const files = Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`);
    const diff = files.map((f, i) => segment(f, 10 + i * 7)).join('');
    const { chunks } = packDiffIntoChunks(files, diff, 2_500);
    expect(chunks.flat().sort()).toEqual([...files].sort());
  });
});

describe('identityByPath rename handling', () => {
  it('keys a renamed file under its post-image path', () => {
    const diff = [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 90%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
      'index 1111111..2222222 100644',
      '--- a/src/old-name.ts',
      '+++ b/src/new-name.ts',
      '@@ -1,2 +1,2 @@',
      '-const a = 1;',
      '+const a = 2;',
      '',
    ].join('\n');
    const bytes = identityBytesByPath(diff);
    expect(bytes.has('src/new-name.ts')).toBe(true);
    expect(bytes.has('src/old-name.ts')).toBe(false);
    expect(bytes.get('src/new-name.ts')).toBeGreaterThan(0);
    const plan = packDiffIntoChunks(['src/new-name.ts'], diff, 40_000);
    expect(plan.bytesByPath.get('src/new-name.ts')).toBeGreaterThan(0);
  });
});
