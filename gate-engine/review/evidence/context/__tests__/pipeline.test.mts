import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeFixture } from '../../../../decisions/eval/bench.mts';
import { resolveGuardConfig } from '../../../../config.mts';
import { runCascade } from '../../../cascade/reviewer.mts';
import { BENCH_REVIEWERS, buildAssets } from '../../../eval/reviewers/corpus.mts';
import { executionHash, planFixture } from '../../../eval/reviewers/corpus/chunk-guard.mts';
import { FOUR_WAY_LENS_GROUPS, resolveLensGroups, lensGroupId } from '../../../lens/groups.mts';
import { packDiffIntoChunks } from '../../../lens/chunk.mts';
import { planReviewWork } from '../../../lens/split.mts';
import { gitCached } from '../../staged-git.mts';
import { prepareContext } from '../packets.mts';
import { prepareContextSource, relatedFileOrder } from '../source.mts';

const reviewer = BENCH_REVIEWERS.find((r) => r.name === 'correctness-reviewer')!;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(base: Record<string, string>, staged: Record<string, string>) {
  const fx = materializeFixture({ repo: { base: { ...buildAssets(reviewer), ...base }, staged } });
  cleanups.push(fx.cleanup);
  return fx;
}
describe('native evidence delivery and identity', () => {
  it('delivers the exact planned packet through initial, internal and deferred attempts', async () => {
    const fx = fixture(
      { 'api/a.ts': 'export const a = 1;\n' },
      { 'api/a.ts': 'export const a = 2;\n' },
    );
    const { tasks } = planFixture({ reviewer, files: fx.staged }, fx.repo, {
      contextMode: 'bounded-v1',
    });
    const task = tasks[0];
    const captured: string[] = [];
    const prompts: string[] = [];
    const opts = {
      cwd: fx.repo,
      cfg: resolveGuardConfig(fx.repo),
      retryFirst: true,
      recovery: 'defer' as const,
      exec: async (o) => {
        captured.push(o.input);
        prompts.push(o.args[1]);
        writeFileSync(join(fx.repo, 'api/a.ts'), 'export const UNREVIEWED_REPAIR = true;');
        execFileSync('git', ['add', 'api/a.ts'], { cwd: fx.repo });
        return captured.length === 1 ? null : 'VERDICT: PASS — no issue';
      },
    };
    const initial = await runCascade(task.sel, opts);
    expect(initial.status).toBe('inconclusive'); // Missing checklist: park, never accept an unearned PASS.
    await runCascade(task.sel, { ...opts, recovery: 'final', retryFirst: false });
    expect(captured.length).toBeGreaterThanOrEqual(3);
    expect(captured.every((input) => input === task.sel.evidencePacket.input)).toBe(true);
    expect(captured.join('\n')).not.toContain('UNREVIEWED_REPAIR');
    expect(prompts.every((p) => p.includes(`Assigned lens(es): ${task.group}`))).toBe(true);
    expect(prompts.every((p) => p.includes(task.sel.evidencePacket.receipt.staged))).toBe(true);
  });
  it('invalidates dependent context only, while snapshot provenance follows unrelated staged changes', () => {
    const fx = fixture(
      {
        'api/a.ts': "import '../helper'; export const a = 1;",
        'api/b.ts': 'export const b = 1;',
        'helper.ts': 'export const helper = 1;',
      },
      { 'api/a.ts': "import '../helper'; export const a = 2;", 'api/b.ts': 'export const b = 2;' },
    );
    const plan = (file: string) =>
      planFixture({ reviewer, files: [file] }, fx.repo, { contextMode: 'bounded-v1' }).tasks[0];
    const a = plan('api/a.ts');
    const b = plan('api/b.ts');
    writeFileSync(join(fx.repo, 'unrelated.txt'), 'unrelated staged edit');
    execFileSync('git', ['add', 'unrelated.txt'], { cwd: fx.repo });
    const next = plan('api/a.ts');
    expect(next.key).toBe(a.key);
    expect(next.sel.evidencePacket.receipt.staged).not.toBe(a.sel.evidencePacket.receipt.staged);
    writeFileSync(join(fx.repo, 'helper.ts'), 'export const helper = 999;');
    execFileSync('git', ['add', 'helper.ts'], { cwd: fx.repo });
    expect(plan('api/a.ts').key).not.toBe(a.key);
    expect(plan('api/b.ts').key).toBe(b.key);
    expect(
      executionHash({ gateHash: 'g', model: 'sol', cascade: false, contextMode: null }),
    ).not.toBe(
      executionHash({ gateHash: 'g', model: 'sol', cascade: false, contextMode: 'bounded-v1' }),
    );
  });
});

describe('context-aware ownership packing', () => {
  it.each([
    'default',
    'on',
    'off',
    'state-transitions,error-and-edge-classification|concurrency-races,writer-reader-contracts',
  ])('preserves whole-file ownership and whole-selection contracts for %s grouping', (mode) => {
    const base = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `api/${i}.js`,
        `import './${(i + 1) % 5}.js';\nexport function f${i}() {\n${'  // function context\n'.repeat(60)}  return 0;\n}\n`,
      ]),
    );
    const staged = Object.fromEntries(
      Object.entries(base).map(([f, c]) => [f, c.replace('return 0', 'return 1')]),
    );
    const fx = fixture(base, staged);
    const groups = mode === 'default' ? FOUR_WAY_LENS_GROUPS : resolveLensGroups(mode);
    const sel = { reviewer, files: fx.staged };
    const plan = planFixture(sel, fx.repo, { contextMode: 'bounded-v1', cap: 100, groups });
    if (!groups) {
      expect(plan.tasks).toHaveLength(1);
      expect(plan.tasks[0].sel.files).toEqual(fx.staged);
    } else
      for (const group of groups) {
        const tasks = plan.tasks.filter((t) => t.group === lensGroupId(group));
        expect(tasks.flatMap((t) => t.sel.files).sort()).toEqual([...fx.staged].sort());
        if (group.includes('writer-reader-contracts')) expect(tasks).toHaveLength(1);
        else expect(tasks.length).toBeGreaterThan(1);
      }
    expect(plan.tasks.every((t) => t.sel.evidencePacket)).toBe(true);
    const source = prepareContextSource(fx.repo, fx.staged);
    const ordered = relatedFileOrder(source);
    expect(new Set(ordered).size).toBe(fx.staged.length); // Cycles terminate without dropping ownership.
    const diff = gitCached(fx.repo, [], fx.staged);
    const evidence = prepareContext(source, diff);
    const packed = packDiffIntoChunks(fx.staged, diff, 1, evidence);
    expect(packed.chunks.every((files) => files.length === 1)).toBe(true); // Oversized files stay intact.
    const control = planReviewWork(
      [sel],
      [diff],
      {},
      new Map(),
      (...v) => v.join('|'),
      groups,
      100,
      () => {},
    );
    const explicitOff = planReviewWork(
      [sel],
      [diff],
      {},
      new Map(),
      (...v) => v.join('|'),
      groups,
      100,
      () => {},
      new Map(),
    );
    expect(explicitOff).toEqual(control);
    expect(control.tasks.every((t) => !t.sel.evidencePacket)).toBe(true);
  });
});
