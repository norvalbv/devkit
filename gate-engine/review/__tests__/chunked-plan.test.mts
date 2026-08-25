import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import { diffCacheIdentity } from '../../judge/diff-focus.mts';
import {
  FOUR_WAY_LENS_GROUPS,
  planReviewWork,
  resolveChunkCap,
  type ReviewTask,
} from '../lens/split.mts';
import { hasChecklist, REVIEWERS, type ReviewerSelection } from '../reviewers.mts';
import { cleanupReviewFixtures, consumerRepo } from './run-review-fixtures.mts';

// sc-1907: pins the two load-bearing contracts — OFF is byte-identical to the pre-chunking
// engine (the kill switch), ON fans local lenses per slice with the cross-file lens whole-diff.

const correctness = REVIEWERS.find((r) => r.name === 'correctness-reviewer');
if (!correctness || !hasChecklist(correctness))
  throw new Error('fixture: correctness-reviewer missing from REVIEWERS');

function segment(path: string, lines: number): string {
  const head = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${lines} @@\n`;
  return (
    head + Array.from({ length: lines }, (_, i) => `+const v${i} = '${'x'.repeat(30)}';\n`).join('')
  );
}

/** keyOf stub that encodes its inputs so tests can assert exact key composition. */
const keyOf = (name: string, diff: string, salt: string): string =>
  `${name}::${salt}::len${diff.length}`;

function plan(files: string[], diff: string, chunkCap: number | null) {
  const sel: ReviewerSelection = { reviewer: correctness, files };
  return planReviewWork(
    [sel],
    [diff],
    {},
    new Map([[correctness.name, 'SALT']]),
    keyOf,
    FOUR_WAY_LENS_GROUPS,
    chunkCap,
  );
}

const envKeys = ['DEVKIT_GATE_EVENTS', 'GUARD_CORRECTNESS_CHUNK'] as const;
const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  cleanupReviewFixtures();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('resolveChunkCap', () => {
  it('unset env falls to the CONFIGURED loc (passed explicitly — no ambient config read in tests)', () => {
    for (const v of ['0', 'off', 'OFF']) expect(resolveChunkCap(v, 400)).toBeNull();
    expect(resolveChunkCap(undefined, 400)).toBe(400);
    expect(resolveChunkCap('', 400)).toBe(400);
    expect(resolveChunkCap(undefined, 0)).toBeNull();
    expect(resolveChunkCap('700', 0)).toBe(700);
  });

  it('guard.config.json review.correctnessChunkLoc sets the per-install default; env still wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devkit-chunk-cfg-'));
    try {
      writeFileSync(join(dir, 'guard.config.json'), '{"review":{"correctnessChunkLoc":0}}');
      const loc = (): number => resolveGuardConfig(dir).review.correctnessChunkLoc;
      expect(resolveChunkCap(undefined, loc())).toBeNull();
      writeFileSync(join(dir, 'guard.config.json'), '{"review":{"correctnessChunkLoc":700}}');
      expect(resolveChunkCap(undefined, loc())).toBe(700);
      expect(resolveChunkCap('off', loc())).toBeNull();
      expect(resolveChunkCap('400', loc())).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on a malformed value instead of silently running unchunked', () => {
    expect(() => resolveChunkCap('four hundred')).toThrow(/GUARD_CORRECTNESS_CHUNK/);
    expect(() => resolveChunkCap('-3')).toThrow(/GUARD_CORRECTNESS_CHUNK/);
    // A byte-scale cap parses fine but would silently never trigger — must throw naming LOC.
    expect(() => resolveChunkCap('24000')).toThrow(/LOC/);
  });
});

describe('kill switch: chunking off', () => {
  it('produces byte-identical keys to the pre-chunking engine — one task per lens group, no chunk suffix, whole diff', () => {
    const files = ['src/a.ts', 'src/b.ts'];
    const diff = segment('src/a.ts', 200) + segment('src/b.ts', 200);
    const { tasks } = plan(files, diff, null);
    expect(tasks).toHaveLength(4);
    const idLen = diffCacheIdentity(diff).length;
    for (const t of tasks) {
      expect(t.key).toBe(`correctness-reviewer::SALT|split:${t.group}::len${idLen}`);
      expect(t.key).not.toContain('|chunk:');
      expect(t.chunk).toBeUndefined();
      expect(t.sel.files).toEqual(files);
    }
  });

  it('a diff UNDER the trigger stays un-chunked even with chunking on', () => {
    const files = ['src/a.ts'];
    const diff = segment('src/a.ts', 100); // ~3.4KB identity << 400 LOC cap x 1.5
    const { tasks } = plan(files, diff, 400);
    expect(tasks).toHaveLength(4);
    for (const t of tasks) expect(t.key).not.toContain('|chunk:');
  });
});

describe('chunked mode', () => {
  const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
  const bigDiff =
    segment('src/a.ts', 380) +
    segment('src/b.ts', 380) +
    segment('src/c.ts', 380) +
    segment('src/d.ts', 380);

  it('fans local lenses out per chunk; the writer-reader lens stays whole-diff on the un-chunked key', () => {
    const sink = join(consumerRepo({ backend: true }), 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    const { tasks } = plan(files, bigDiff, 400);
    const local = tasks.filter((t) => t.chunk !== undefined);
    const cross = tasks.filter((t) => t.chunk === undefined);
    expect(cross).toHaveLength(1);
    expect(cross[0].group).toBe('writer-reader-contracts');
    expect(cross[0].diffText).toBe(bigDiff);
    // Cross-file key === un-chunked key: identical judged content, verdicts transfer across the flag.
    // SAFETY: the four-way plan always contains the writer-reader group, so find() cannot miss.
    const off = plan(files, bigDiff, null).tasks.find(
      (t) => t.group === 'writer-reader-contracts',
    ) as ReviewTask;
    expect(cross[0].key).toBe(off.key);
    // 3 local lenses per chunk, every local key chunk-suffixed, every task scoped to its slice.
    expect(local.length % 3).toBe(0);
    const chunkCount = local.length / 3;
    expect(chunkCount).toBeGreaterThanOrEqual(2);
    for (const t of local) {
      expect(t.key).toContain(`|chunk:${t.chunk?.filesSha}`);
      expect(t.chunk?.count).toBe(chunkCount);
      expect(t.sel.files.length).toBeLessThan(files.length);
      expect(t.diffText.length).toBeLessThan(bigDiff.length);
      expect(t.sel.reviewer.stateFile).toContain(`+c${t.chunk?.index}`);
      // SAFETY: chunked tasks carry lens-derived CHECKLIST reviewers, which always define cmds.
      expect((t.sel.reviewer as { cmds: { check: string } }).cmds.check).toContain(
        `--chunk ${t.chunk?.index}`,
      );
    }
    // One review_chunk_plan event, entries aligned with the plan.
    const events = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => {
        // SAFETY: the sink is written exclusively by emitGateEvent in this test process.
        return JSON.parse(l) as { type: string; chunk_count?: number; chunks?: unknown[] };
      })
      .filter((e) => e.type === 'review_chunk_plan');
    expect(events).toHaveLength(1);
    expect(events[0].chunk_count).toBe(chunkCount);
    expect(events[0].chunks).toHaveLength(chunkCount);
  });

  it("packs at the configured cap — chunk count follows the cap, concurrency is the pool's job", () => {
    const many = Array.from({ length: 12 }, (_, i) => `src/m${String(i).padStart(2, '0')}.ts`);
    const diff = many.map((f) => segment(f, 380)).join('');
    const { tasks } = plan(many, diff, 400);
    const chunkCount = new Set(
      tasks.filter((t) => t.chunk !== undefined).map((t) => t.chunk?.index),
    ).size;
    // ~380-LOC files against a 400-LOC cap: near one chunk per file, NOT repacked coarser — the
    // benched granularity survives large diffs.
    expect(chunkCount).toBeGreaterThanOrEqual(10);
    expect(tasks).toHaveLength(chunkCount * 3 + 1);
  });

  it('repacks at doubled caps only past the MAX_CHUNKS safety backstop', () => {
    const many = Array.from({ length: 30 }, (_, i) => `src/p${String(i).padStart(2, '0')}.ts`);
    const diff = many.map((f) => segment(f, 380)).join('');
    const { tasks } = plan(many, diff, 400);
    const chunkCount = new Set(
      tasks.filter((t) => t.chunk !== undefined).map((t) => t.chunk?.index),
    ).size;
    expect(chunkCount).toBeGreaterThanOrEqual(2);
    expect(chunkCount).toBeLessThanOrEqual(24);
    expect(tasks).toHaveLength(chunkCount * 3 + 1);
  });
});
