import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChunkPlanEntry, emitReviewChunkPlan } from '../evidence/chunk-plan.mts';
import type { ChunkAssignment } from '../lens/chunk.mts';
import {
  deriveLensReviewer,
  emitMergedLensResults,
  type LensPart,
  type ReviewTask,
} from '../lens/split.mts';
import { hasChecklist, REVIEWERS, type ReviewerSelection } from '../reviewers.mts';
import { runReviewGate } from '../run-review.mts';
import { cleanupReviewFixtures, consumerRepo, passWithArtifact } from './run-review-fixtures.mts';

// sc-1999 wire format: the chunk-telemetry fields the warehouse's chunk-grain child tables ingest.
// Production chunking (sc-1907) is what starts filling them; until then every run is un-chunked
// and these tests pin BOTH sides of the contract — nulls on the live path, real values when a
// task carries a ChunkAssignment, and the review_chunk_plan event shape.

/** The slice of the emitted event stream these tests read — the wire contract under test. */
interface WireLensPart {
  lens: string;
  status: string;
  chunk_index: number | null;
  chunk_files_sha: string | null;
}

interface WireEvent {
  type: string;
  reviewer?: string;
  armed?: number;
  chunk_count?: number;
  chunk_cap_bytes?: number;
  chunk_plan_hash?: string;
  chunks?: ChunkPlanEntry[];
  lens_parts?: WireLensPart[];
}

const envKeys = ['DEVKIT_GATE_EVENTS', 'DEVKIT_SHIP_ID'] as const;
const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanupReviewFixtures();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

function readEvents(sink: string): WireEvent[] {
  return readFileSync(sink, 'utf8')
    .trim()
    .split('\n')
    .map((l) => {
      // SAFETY: the sink is written exclusively by emitGateEvent in this test process, so every
      // line is one event under test; WireEvent reads all fields optionally.
      return JSON.parse(l) as WireEvent;
    });
}

describe('un-chunked runs (today: every production run)', () => {
  it('every review_result lens_part carries explicit null chunk fields and NO review_chunk_plan is emitted', async () => {
    const repo = consumerRepo({ backend: true });
    const sink = join(repo, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'ship-chunk-telemetry-null';
    await runReviewGate(repo, { exec: passWithArtifact(repo) });
    const events = readEvents(sink);
    expect(events.filter((e) => e.type === 'review_chunk_plan')).toHaveLength(0);
    const results = events.filter((e) => e.type === 'review_result');
    expect(results.length).toBeGreaterThan(0);
    const parts = results.flatMap((e) => e.lens_parts ?? []);
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      // Explicit nulls, not absent keys: the collector distinguishes "old emitter" (key missing)
      // from "un-chunked run under the new format" (null) by presence.
      expect(part).toHaveProperty('chunk_index', null);
      expect(part).toHaveProperty('chunk_files_sha', null);
    }
  });
});

describe('chunk-assigned tasks (the sc-1907 path, exercised directly)', () => {
  // A REAL lens-derived reviewer, not a shaped stand-in: the emitter reads reviewer.lens and the
  // reviewer name, and deriveLensReviewer is the one production path that assigns them.
  const correctness = REVIEWERS.find((r) => r.name === 'correctness-reviewer');
  if (!correctness || !hasChecklist(correctness))
    throw new Error('fixture: correctness-reviewer missing from REVIEWERS');

  const partFor = (lens: string, chunk?: ChunkAssignment): LensPart => {
    const sel: ReviewerSelection = {
      reviewer: deriveLensReviewer(correctness, [lens]),
      files: ['src/a.ts'],
    };
    const task: ReviewTask = { sel, key: `chunk-telemetry-${lens}`, diffText: '', base: sel };
    if (chunk) task.chunk = chunk;
    return {
      res: { status: 'pass', name: 'correctness-reviewer', items: [] },
      secs: 1,
      task,
    };
  };

  const assign = (index: number, filesSha: string): ChunkAssignment => ({
    index,
    filesSha,
    count: 2,
    capBytes: 40_000,
    planHash: 'plan123456ab',
  });

  it("lens_parts carry each part's chunk index AND membership hash", () => {
    const sink = join(consumerRepo({ backend: true }), 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    const parts = new Map([
      [
        'correctness-reviewer',
        [
          partFor('state-transitions', assign(0, 'aaaaaaaaaaaa')),
          partFor('concurrency-races', assign(1, 'bbbbbbbbbbbb')),
          partFor('writer-reader-contracts'),
        ],
      ],
    ]);
    emitMergedLensResults(parts, 'sonnet');
    const [result] = readEvents(sink).filter((e) => e.type === 'review_result');
    const lensParts = result.lens_parts ?? [];
    expect(lensParts.map((p) => [p.chunk_index, p.chunk_files_sha])).toEqual([
      [0, 'aaaaaaaaaaaa'],
      [1, 'bbbbbbbbbbbb'],
      [null, null],
    ]);
  });

  it('review_chunk_plan carries the plan facts and per-chunk membership entries', () => {
    const sink = join(consumerRepo({ backend: true }), 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    emitReviewChunkPlan(
      'correctness-reviewer',
      { count: 2, capBytes: 40_000, planHash: 'plan123456ab' },
      [
        { index: 0, files_sha: 'aaaaaaaaaaaa', file_count: 3, bytes: 30_000 },
        { index: 1, files_sha: 'bbbbbbbbbbbb', file_count: 2, bytes: 12_000 },
      ],
    );
    const [plan] = readEvents(sink).filter((e) => e.type === 'review_chunk_plan');
    expect(plan).toMatchObject({
      reviewer: 'correctness-reviewer',
      armed: 1,
      chunk_count: 2,
      chunk_cap_bytes: 40_000,
      chunk_plan_hash: 'plan123456ab',
    });
    expect(plan.chunks).toEqual([
      { index: 0, files_sha: 'aaaaaaaaaaaa', file_count: 3, bytes: 30_000 },
      { index: 1, files_sha: 'bbbbbbbbbbbb', file_count: 2, bytes: 12_000 },
    ]);
  });
});
