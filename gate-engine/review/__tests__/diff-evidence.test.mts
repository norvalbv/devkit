import { describe, expect, it } from 'vitest';
import { buildCappedDiffEvidence, measureDiffEvidenceCap } from '../diff-evidence.mts';

// One synthetic per-file segment of roughly `bytes` bytes, shaped like real `git diff --cached` output.
function segment(path: string, bytes: number): string {
  const head = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,9 @@\n`;
  const line = `+const pad_${path.replace(/\W/g, '_')} = '${'x'.repeat(60)}';\n`;
  let body = '';
  while (head.length + body.length < bytes) body += line;
  return head + body;
}

describe('measureDiffEvidenceCap', () => {
  it('is the identity under the total cap: every byte shown, nothing omitted or truncated', () => {
    const diff = segment('src/a.ts', 2_000) + segment('src/b.ts', 3_000);
    expect(measureDiffEvidenceCap(diff)).toEqual({
      evidence_bytes_shown: Buffer.byteLength(diff, 'utf8'),
      omitted_files: 0,
      truncated_files: 0,
    });
  });

  it('accounts for per-file TRUNCATION and whole-file OMISSION once the diff exceeds the caps', () => {
    // 12 files × ~9 KB = ~108 KB: over the 60 KB total, and every file over the 8 KB segment cap.
    const files = Array.from({ length: 12 }, (_, i) => `src/mod-${String(i).padStart(2, '0')}.ts`);
    const diff = files.map((f) => segment(f, 9_000)).join('');
    const m = measureDiffEvidenceCap(diff);
    // ASCII fixture: UTF-8 bytes == UTF-16 units, so the shown bytes sit under the 60 KB unit cap.
    expect(m.evidence_bytes_shown).toBeLessThanOrEqual(60_000);
    expect(m.evidence_bytes_shown).toBeLessThan(Buffer.byteLength(diff, 'utf8'));
    expect(m.truncated_files).toBeGreaterThan(0);
    expect(m.omitted_files).toBeGreaterThan(0);
    expect(m.truncated_files + m.omitted_files).toBeLessThanOrEqual(files.length);
    // The measurement mirrors the evidence the judge actually receives.
    const rendered = buildCappedDiffEvidence(diff, '(stat)');
    expect((rendered.match(/^OMITTED: /gm) ?? []).length).toBe(m.omitted_files);
    expect((rendered.match(/\[TRUNCATED: /g) ?? []).length).toBe(m.truncated_files);
  });

  it('reports UTF-8 bytes while the caps act on UTF-16 units — shown can exceed the unit cap, never diff_bytes', () => {
    // A single multi-byte file: 9,000 UTF-16 units (> the 8,000-unit segment cap), 3 bytes each.
    const head =
      'diff --git a/src/cjk.ts b/src/cjk.ts\n--- a/src/cjk.ts\n+++ b/src/cjk.ts\n@@ -0,0 +1,1 @@\n+';
    const diff = `${head}${'\u4e00'.repeat(9_000 - head.length)}\n`;
    const wide = diff + segment('src/pad.ts', 70_000); // force the capping path
    const m = measureDiffEvidenceCap(wide);
    expect(m.evidence_bytes_shown).toBeGreaterThan(8_000); // bytes exceed the unit cap for CJK
    expect(m.evidence_bytes_shown).toBeLessThan(Buffer.byteLength(wide, 'utf8')); // never the whole diff
  });

  it('is pure and stable across calls', () => {
    const diff = segment('src/a.ts', 70_000);
    expect(measureDiffEvidenceCap(diff)).toEqual(measureDiffEvidenceCap(diff));
  });
});
