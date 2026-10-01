import { describe, expect, it, vi } from 'vitest';
import { buildCappedDiffEvidence, measureDiffCoverage, readFileHint } from '../diff-evidence.mts';
import { coverageFields, partialEvidenceNote } from '../evidence/packet/coverage.mts';
import { omissionHintFor, omissionHintSalt } from '../evidence/packet/omission-hint.mts';
import { holdLensPart } from '../lens/split.mts';
import { REVIEWERS } from '../reviewers.mts';

// One synthetic per-file segment of roughly `bytes` bytes, shaped like real `git diff --cached` output.
function segment(path: string, bytes: number): string {
  const head = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,9 @@\n`;
  const line = `+const pad_${path.replace(/\W/g, '_')} = '${'x'.repeat(60)}';\n`;
  let body = '';
  while (head.length + body.length < bytes) body += line;
  return head + body;
}

const files = (n: number, prefix = 'src/mod') =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(2, '0')}.ts`);
// 32 files × ~4 KB ≈ 128 KB: each under the 8 KB segment cap, so the tail is OMITTED, never truncated.
const BIG = files(32);
const bigDiff = BIG.map((f) => segment(f, 4_000)).join('');

describe('measureDiffCoverage (sc-2305)', () => {
  it('reports every file shown when the diff fits the budget', () => {
    const diff = segment('src/a.ts', 2_000) + segment('src/b.ts', 3_000);
    expect(measureDiffCoverage(diff)).toEqual({
      file_count: 2,
      omitted_files: 0,
      truncated_files: 0,
      omitted_paths: [],
    });
  });

  it('names exactly the files the rendered packet OMITTED, in diff order', () => {
    const c = measureDiffCoverage(bigDiff);
    expect(c.file_count).toBe(32);
    expect(c.omitted_files).toBeGreaterThan(0);
    const rendered = buildCappedDiffEvidence(bigDiff, '(stat)');
    const marked = [...rendered.matchAll(/^OMITTED: (\S+)/gm)].map((m) => m[1]);
    expect(c.omitted_paths).toEqual(marked);
    expect(c.omitted_paths).toEqual(BIG.slice(32 - c.omitted_files));
  });
});

describe('buildCappedDiffEvidence hint', () => {
  it('keeps the git-diff hint by default — byte-identical for every existing caller', () => {
    expect(buildCappedDiffEvidence(bigDiff, '(stat)')).toBe(
      buildCappedDiffEvidence(bigDiff, '(stat)', {}),
    );
    expect(buildCappedDiffEvidence(bigDiff, '(stat)')).toContain('run `git diff --cached -- ');
  });

  it('gives a shell-less judge a Read hint it can follow instead of a git command', () => {
    const rendered = buildCappedDiffEvidence(bigDiff, '(stat)', { hint: readFileHint });
    expect(rendered).not.toContain('git diff');
    expect(rendered).toContain(`Read \`${BIG[31]}\` directly`);
  });
});

describe('coverageFields', () => {
  it('is empty for a fully shown packet, so a clean verdict row gains no fields', () => {
    expect(coverageFields([{ diffText: segment('src/a.ts', 2_000) }])).toEqual({});
    expect(partialEvidenceNote({})).toBe('');
  });

  it('reports an unchunked reviewer whose packet omitted files', () => {
    const c = coverageFields([{ diffText: bigDiff }]);
    expect(c.evidence_file_count).toBe(32);
    expect(c.evidence_omitted_files).toBeGreaterThan(0);
    expect(c.evidence_lens).toBeUndefined();
    expect(partialEvidenceNote(c)).toMatch(/partial evidence: \d+\/32 file\(s\) omitted/);
  });

  it('treats chunk parts as a partition: full coverage when every chunk fit', () => {
    const chunkDiffs = [BIG.slice(0, 11), BIG.slice(11, 22), BIG.slice(22)].map((fs) =>
      fs.map((f) => segment(f, 4_000)).join(''),
    );
    const parts = chunkDiffs.map((diffText, index) => ({ diffText, chunk: { index } }));
    expect(coverageFields(parts)).toEqual({});
  });

  it('names the whole-diff lens that stayed partial beside a fully covered chunk plan', () => {
    const chunkParts = [BIG.slice(0, 16), BIG.slice(16)].map((fs, index) => ({
      diffText: fs.map((f) => segment(f, 4_000)).join(''),
      group: 'concurrency-races',
      chunk: { index },
    }));
    const contracts = { diffText: bigDiff, group: 'writer-reader-contracts' };
    const c = coverageFields([...chunkParts, contracts]);
    expect(c.evidence_lens).toBe('writer-reader-contracts');
    expect(c.evidence_file_count).toBe(32);
    expect(partialEvidenceNote(c)).toContain('(writer-reader-contracts lens)');
  });

  it('measures lens groups that share one whole diff once, not once per group', () => {
    const one = coverageFields([{ diffText: bigDiff }]);
    const split = coverageFields([
      { diffText: bigDiff, group: 'a' },
      { diffText: bigDiff, group: 'b' },
    ]);
    expect(split).toEqual(one);
  });
});

// Grow `diff`'s last line so the whole diff is exactly `units` UTF-16 units long.
function exactly(diff: string, units: number): string {
  const pad = units - diff.length - 2;
  if (pad < 0) throw new Error('fixture already longer than target');
  return `${diff}+${'y'.repeat(pad)}\n`;
}

describe('measureDiffCoverage — edge cases', () => {
  it('agrees with the rendered packet on both sides of the 60 000-unit budget', () => {
    const base = files(8)
      .map((f) => segment(f, 7_000))
      .join('');
    for (const units of [60_000, 60_001]) {
      const diff = exactly(base, units);
      const c = measureDiffCoverage(diff);
      const rendered = buildCappedDiffEvidence(diff, '(stat)');
      expect(c.omitted_files).toBe((rendered.match(/^OMITTED: /gm) ?? []).length);
      expect(c.truncated_files).toBe((rendered.match(/\[TRUNCATED: /g) ?? []).length);
      expect(c.file_count).toBe(8);
    }
    expect(coverageFields([{ diffText: exactly(base, 60_000) }])).toEqual({});
    expect(coverageFields([{ diffText: exactly(base, 60_001) }])).not.toEqual({});
  });

  it('reports a truncation-only packet (one file over the segment cap) with no omitted paths', () => {
    const diff = segment('src/huge.ts', 30_000) + segment('src/b.ts', 1_000);
    // Under the total cap the packet passes through whole — no truncation at all.
    expect(coverageFields([{ diffText: diff }])).toEqual({});
    const big =
      segment('src/huge.ts', 20_000) +
      files(12)
        .map((f) => segment(f, 4_000))
        .join('');
    const c = measureDiffCoverage(big);
    expect(c.truncated_files).toBeGreaterThanOrEqual(1);
    expect(c.omitted_paths).toHaveLength(c.omitted_files);
  });

  it('caps omitted_paths at the packet list cutoff (40) while the count stays exact', () => {
    const many = files(120, 'src/f');
    const c = measureDiffCoverage(many.map((f) => segment(f, 1_000)).join(''));
    expect(c.omitted_files).toBeGreaterThan(40);
    expect(c.omitted_paths).toHaveLength(40);
    expect(c.omitted_paths[0]).toBe(many[many.length - c.omitted_files]);
  });

  it('names a path containing spaces whole, in the count AND in the Read hint', () => {
    const spaced = 'docs/my notes/file name.md';
    const diff =
      files(20)
        .map((f) => segment(f, 4_000))
        .join('') + segment(spaced, 4_000);
    expect(measureDiffCoverage(diff).omitted_paths).toContain(spaced);
    expect(buildCappedDiffEvidence(diff, '', { hint: readFileHint })).toContain(
      `Read \`${spaced}\` directly`,
    );
  });

  it('is empty for an empty diff and for no tasks', () => {
    expect(measureDiffCoverage('')).toEqual({
      file_count: 0,
      omitted_files: 0,
      truncated_files: 0,
      omitted_paths: [],
    });
    expect(coverageFields([])).toEqual({});
  });
});

const byName = (n: string) => REVIEWERS.find((r) => r.name === n)!;

describe('omission hint per judge variant (claude vs codex, checklist vs not)', () => {
  const conventions = byName('conventions-reviewer');
  const commitGuard = byName('commit-guard');

  it('gives ONLY a checklist-less claude judge the Read hint and the one-time salt', () => {
    for (const model of ['haiku', 'sonnet', 'claude-opus-5-5']) {
      expect(omissionHintFor(conventions, model)).toEqual({ hint: readFileHint });
      expect(omissionHintSalt(conventions, model)).not.toBe('');
    }
  });

  it('keeps the git hint (and salt-free keys) for a codex judge, which has a shell', () => {
    expect(omissionHintFor(conventions, 'gpt-5.6-terra')).toEqual({});
    expect(omissionHintSalt(conventions, 'gpt-5.6-terra')).toBe('');
  });

  it('keeps the git hint for a checklist reviewer on any runtime — it has Bash', () => {
    for (const model of ['haiku', 'gpt-5.6-sol']) {
      expect(omissionHintFor(commitGuard, model)).toEqual({});
      expect(omissionHintSalt(commitGuard, model)).toBe('');
    }
  });
});

// Real `git diff --cached -M` shapes: git tab-terminates a spaced name on its ---/+++ lines.
const renamed = (from: string, to: string, body = true) =>
  `diff --git a/${from} b/${to}\nsimilarity index 83%\nrename from ${from}\nrename to ${to}\n` +
  (body
    ? `index 8a1218a..b414108 100644\n--- a/${from}\t\n+++ b/${to}\t\n@@ -3,3 +3,4 @@\n 3\n+6\n`
    : '');
const deleted = (path: string) =>
  `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\t\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`;
const padding = files(20)
  .map((f) => segment(f, 4_000))
  .join('');

describe('omitted path = the POST-image path, whole (review findings on sc-2305)', () => {
  it.each([
    ['a spaced rename with hunks', renamed('d/old name.ts', 'd/new name.ts'), 'd/new name.ts'],
    [
      'a pure spaced rename (no hunks)',
      renamed('d/old name.ts', 'd/new name.ts', false),
      'd/new name.ts',
    ],
    ['a plain rename', renamed('src/old.ts', 'src/new.ts'), 'src/new.ts'],
    ['a spaced deletion', deleted('d/gone name.ts'), 'd/gone name.ts'],
  ])('names %s by its post-image path', (_case, seg, expected) => {
    const diff = padding + seg;
    // The padding overflows too; the shape under test is the last file in diff order.
    expect(measureDiffCoverage(diff).omitted_paths.at(-1)).toBe(expected);
    expect(buildCappedDiffEvidence(diff, '', { hint: readFileHint })).toContain(
      `Read \`${expected}\` directly`,
    );
  });

  it('shell-quotes a spaced path in the git hint, and leaves a plain one byte-identical', () => {
    const spaced = buildCappedDiffEvidence(padding + renamed('d/o.ts', "d/it's new.ts"), '');
    expect(spaced).toContain("run `git diff --cached -- 'd/it'\\''s new.ts'`");
    expect(buildCappedDiffEvidence(bigDiff, '')).toContain(
      `run \`git diff --cached -- ${BIG[31]}\``,
    );
  });
});

describe('chunked correctness with several local lens groups', () => {
  it('counts each chunk once however many lens groups judged it', () => {
    // One chunk alone overflows its packet; two lens groups each judged both chunks.
    const small = BIG.slice(0, 4)
      .map((f) => segment(f, 4_000))
      .join('');
    const tasks = ['concurrency-races', 'state-transitions'].flatMap((group) => [
      { diffText: small, group, chunk: { index: 0 } },
      { diffText: bigDiff, group, chunk: { index: 1 } },
    ]);
    const once = coverageFields([
      { diffText: small, chunk: { index: 0 } },
      { diffText: bigDiff, chunk: { index: 1 } },
    ]);
    expect(coverageFields(tasks)).toEqual(once);
    expect(once.evidence_file_count).toBe(36);
  });
});

describe('holdLensPart completion line', () => {
  it('names a split lens PASS over a partial packet on its own completion line', () => {
    const sel = { reviewer: byName('correctness-reviewer'), files: BIG };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const task = { sel, key: 'k', diffText: bigDiff, splitOf: 'correctness-reviewer', base: sel };
    holdLensPart(
      new Map(),
      'correctness-reviewer',
      { res: { status: 'pass', name: 'correctness-reviewer' }, secs: 3, task },
      'correctness-reviewer [x]',
    );
    holdLensPart(
      new Map(),
      'correctness-reviewer',
      { res: { status: 'fail', name: 'correctness-reviewer' }, secs: 3, task },
      'correctness-reviewer [y]',
    );
    const lines = err.mock.calls.map((c) => String(c[0]));
    expect(lines[0]).toMatch(/\[x\] — PASS in 3s — partial evidence: \d+\/32 file\(s\) omitted/);
    expect(lines[1]).not.toContain('partial evidence');
    err.mockRestore();
  });
});

describe('second review round on sc-2305', () => {
  // Real `git diff --cached` headers: git C-quotes a path holding `"`, `\`, or a non-ASCII byte.
  const quoted = (header: string, plus: string) =>
    `diff --git ${header}\nnew file mode 100644\nindex 0000000..587be6b\n--- /dev/null\n+++ ${plus}\n@@ -0,0 +1 @@\n+x\n`;

  it.each([
    ['a double quote', '"a/a\\"b.ts" "b/a\\"b.ts"', '"b/a\\"b.ts"', 'a"b.ts'],
    [
      'a non-ASCII name',
      '"a/\\303\\274ber.ts" "b/\\303\\274ber.ts"',
      '"b/\\303\\274ber.ts"',
      'über.ts',
    ],
  ])('unquotes a git-quoted path holding %s', (_case, header, plus, expected) => {
    const diff = padding + quoted(header, plus);
    expect(measureDiffCoverage(diff).omitted_paths.at(-1)).toBe(expected);
  });

  it('bounds the telemetry path list in count and bytes, while the count stays exact', () => {
    const many = files(120, `src/${'deep/'.repeat(20)}f`);
    const c = coverageFields([{ diffText: many.map((f) => segment(f, 1_000)).join('') }]);
    const paths = c.evidence_omitted_paths ?? [];
    expect(paths.length).toBeLessThanOrEqual(10);
    expect(Buffer.byteLength(paths.join(''), 'utf8')).toBeLessThanOrEqual(1_000);
    expect(c.evidence_omitted_files).toBeGreaterThan(paths.length);
  });

  it('names the whole-diff lens when it ties with the chunk aggregate', () => {
    // Chunks and the whole-diff lens each leave the same files out.
    const c = coverageFields([
      { diffText: bigDiff, group: 'concurrency-races', chunk: { index: 0 } },
      { diffText: bigDiff, group: 'writer-reader-contracts' },
    ]);
    expect(c.evidence_lens).toBe('writer-reader-contracts');
  });

  it('tells a shell-less judge that an absent file was deleted by the change', () => {
    expect(readFileHint('d/gone.ts')).toContain('absent if this change deleted it');
  });
});
