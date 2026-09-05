import { describe, expect, it } from 'vitest';
import { REVIEWERS } from '../../../../../reviewers.mts';
import { planChunkedParts } from '../../../../../lens/chunk-tasks.mts';
import { buildCappedDiffEvidence } from '../../../../../diff-evidence.mts';
import { sha256 } from '../../claim-inventory.mts';
import { measureSpan } from '../visibility.mts';

const groups = [
  ['state-transitions'],
  ['concurrency-races'],
  ['error-and-edge-classification'],
  ['writer-reader-contracts'],
];
// Artificial volume exercises planner boundaries only; these are never candidate bug labels.
function volumeFixture(files: number, lines: number) {
  const post = Object.fromEntries(
    Array.from({ length: files }, (_, index) => {
      const file = `src/module-${String(index).padStart(3, '0')}.ts`;
      return [
        file,
        Array.from(
          { length: lines },
          (_, line) =>
            `export const module${index}Value${line} = { number: ${line}, description: 'shape fixture' };`,
        ).join('\n') + '\n',
      ];
    }),
  );
  const diff = Object.entries(post)
    .map(
      ([file, content]) =>
        `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines} @@\n${content
          .trimEnd()
          .split('\n')
          .map((line) => `+${line}\n`)
          .join('')}`,
    )
    .join('');
  const selection = {
    reviewer: REVIEWERS.find((reviewer) => reviewer.name === 'correctness-reviewer'),
    files: Object.keys(post),
  };
  const plan = planChunkedParts(
    selection,
    diff,
    diff,
    '',
    (...parts) => sha256(parts.join('|')),
    groups,
    400,
  );
  return { post, diff, plan };
}

describe('native shape controls (not corpus rows)', () => {
  it('packs 100 small changed files into multi-file chunks', () => {
    const { plan } = volumeFixture(100, 10);
    expect(plan.facts.count).toBeGreaterThan(1);
    expect(plan.facts.count).toBeLessThan(100);
    expect(plan.parts).toHaveLength(plan.facts.count * 3 + 1);
    expect(plan.planEntries.some((entry) => entry.file_count > 1)).toBe(true);
  });
  it('keeps a single oversized 5k-line file intact', () => {
    expect(volumeFixture(1, 5000).plan).toBeNull();
  });
  it('distinguishes counterpart absence in local chunks from whole-diff initial supply at 2k lines', () => {
    const { post, plan } = volumeFixture(4, 500);
    expect(plan.facts.count).toBe(4);
    const file = 'src/module-003.ts';
    const span = {
      file,
      side: 'post',
      start: 1,
      end: 1,
      fileSha256: sha256(post[file]),
      spanSha256: sha256(post[file].split('\n')[0]),
    };
    const local = plan.parts.find((task) => task.chunk?.index === 0);
    const whole = plan.parts.find((task) => task.group === 'writer-reader-contracts');
    const observe = (task) =>
      measureSpan(span, {
        base: {},
        post,
        selectedFiles: task.sel.files,
        diff: task.diffText,
        rendered: buildCappedDiffEvidence(task.diffText, 'inventory'),
      });
    expect(observe(local).status).toBe('out-of-scope');
    expect(observe(whole).status).toBe('supplied');
  });
});
