// sc-2305 wiring: a real gate run past the evidence budget carries packet coverage through settle,
// the telemetry sink and the ship digest — fresh and cached.
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type GateEvent,
  readShipEvents,
  summarise,
} from '../../../cli/lib/ship/digest/gate-digest.mts';
import { runReviewGate } from '../run-review.mts';
import { cleanupReviewFixtures, consumerRepo, passWithArtifact } from './run-review-fixtures.mts';

const SHIP = 'ship-partial-evidence';
const envKeys = [
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'GUARD_REVIEW_MODEL',
  'GUARD_AI_STRICT',
  'FRINK_AI_STRICT',
] as const;
const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
let sink = '';

beforeEach(() => {
  for (const key of envKeys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  sink = join(mkdtempSync(join(tmpdir(), 'partial-evidence-')), 'gate-events.jsonl');
  process.env.DEVKIT_GATE_EVENTS = sink;
  process.env.DEVKIT_SHIP_ID = SHIP;
});

afterEach(() => {
  cleanupReviewFixtures();
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

/** 40 JSON files × ~3 KB ≈ 120 KB: past the 60 KB packet budget, each file under the segment cap. */
function largeRepo(): string {
  const repo = consumerRepo();
  mkdirSync(join(repo, 'src'), { recursive: true });
  for (let i = 0; i < 40; i += 1)
    writeFileSync(
      join(repo, 'src', `config-${String(i).padStart(2, '0')}.json`),
      `${JSON.stringify({ value: 'x'.repeat(3_000) })}\n`,
    );
  execSync('git add .', { cwd: repo });
  return repo;
}

// The digest's own reader: the rows exactly as the ship terminus will see them.
const events = (): GateEvent[] => readShipEvents(sink, SHIP);

describe('partial evidence wiring (sc-2305)', () => {
  it('carries a fresh partial PASS from the settle path to an unverified digest row', async () => {
    const repo = largeRepo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: passWithArtifact(repo) })).toBe(0);

    const result = events().find(
      (e) => e.type === 'review_result' && e.reviewer === 'conventions-reviewer',
    );
    expect(result).toMatchObject({ status: 'pass', evidence_file_count: 40 });
    expect(result?.evidence_omitted_files).toBeGreaterThan(0);
    expect(err.mock.calls.flat().join('\n')).toMatch(
      /conventions-reviewer — PASS .*partial evidence: \d+\/40 file\(s\) omitted/,
    );
    expect(summarise(readShipEvents(sink, SHIP), SHIP)).toEqual([
      expect.objectContaining({ gate: 'review:conventions-reviewer', state: 'unverified' }),
    ]);
  });

  it('keeps a cached replay of that PASS unverified — the cache never launders coverage', async () => {
    const repo = largeRepo();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: passWithArtifact(repo) })).toBe(0);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = passWithArtifact(repo);
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    const hit = events().find(
      (e) => e.type === 'cache_hit' && e.judge === 'review:conventions-reviewer',
    );
    expect(hit?.evidence_omitted_files).toBeGreaterThan(0);
    expect(err.mock.calls.flat().join('\n')).toMatch(/cached PASS.*partial evidence: \d+\/40/);
  });

  it('adds no coverage fields and no note when the diff fits the budget', async () => {
    const repo = consumerRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'config.json'), '{ "flag": true }\n');
    execSync('git add .', { cwd: repo });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runReviewGate(repo, { exec: passWithArtifact(repo) })).toBe(0);
    const result = events().find((e) => e.type === 'review_result');
    expect(Object.keys(result ?? {}).filter((k) => k.startsWith('evidence_'))).toEqual([]);
    expect(err.mock.calls.flat().join('\n')).not.toContain('partial evidence');
  });

  it('keeps the git-diff hint for a codex conventions judge, which has a shell', async () => {
    const repo = largeRepo();
    // After consumerRepo(), which pins haiku: this override is the model the judge spawns with.
    process.env.GUARD_REVIEW_MODEL = 'gpt-5.6-terra';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = passWithArtifact(repo);
    await runReviewGate(repo, { exec });
    const [call] = exec.mock.calls[0];
    expect(call.args[call.args.indexOf('--model') + 1]).toBe('gpt-5.6-terra');
    expect(call.input).toContain('run `git diff --cached -- src/config-');
    expect(call.input).not.toMatch(/Read `src\/config-\d+\.json` directly/);
  });
});
