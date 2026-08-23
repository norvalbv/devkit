import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReviewGate } from '../run-review.mts';
import { cleanupReviewFixtures, consumerRepo, passWithArtifact } from './run-review-fixtures.mts';

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

async function scopeRows(repo: string, shipId: string) {
  const sink = join(repo, 'events.jsonl');
  process.env.DEVKIT_GATE_EVENTS = sink;
  process.env.DEVKIT_SHIP_ID = shipId;
  await runReviewGate(repo, { exec: passWithArtifact(repo) });
  const lines = readFileSync(sink, 'utf8').trim().split('\n');
  const scope = lines.map((l) => JSON.parse(l)).filter((e) => e.type === 'review_scope');
  return { lines, scope };
}

describe('review_scope evidence-cap accounting', () => {
  it('under the cap the judge sees every byte: shown == diff_bytes, nothing omitted or truncated', async () => {
    const repo = consumerRepo({ backend: true });
    const { scope } = await scopeRows(repo, 'ship-scope-under-cap');
    const backend = scope.find((e) => e.reviewer === 'backend-performance-reviewer');
    expect(backend.diff_bytes).toBeGreaterThan(0);
    expect(backend.evidence_bytes_shown).toBe(backend.diff_bytes);
    expect(backend.omitted_files).toBe(0);
    expect(backend.truncated_files).toBe(0);
  });

  it('says how much of a byte-heavy diff the judge could actually see', async () => {
    const repo = consumerRepo({ backend: true });
    // 12 staged backend files of ~9 KB each: over the 60 KB evidence total AND each over the 8 KB
    // per-file segment cap (diff-evidence.mts), so the judge's stdin is a truncated window.
    for (let i = 0; i < 12; i++)
      writeFileSync(
        join(repo, 'src', 'main', `big-${String(i).padStart(2, '0')}.ts`),
        `${Array.from({ length: 120 }, (_, k) => `export const v${i}_${k} = '${'x'.repeat(60)}';`).join('\n')}\n`,
      );
    execSync('git add .', { cwd: repo });
    const { lines, scope } = await scopeRows(repo, 'ship-scope-capped');
    const backend = scope.find((e) => e.reviewer === 'backend-performance-reviewer');
    expect(backend.diff_bytes).toBeGreaterThan(60_000);
    expect(backend.evidence_bytes_shown).toBeLessThanOrEqual(60_000);
    expect(backend.evidence_bytes_shown).toBeLessThan(backend.diff_bytes);
    expect(backend.truncated_files + backend.omitted_files).toBeGreaterThan(0);
    // Three small integers: every event still fits the atomic-append window.
    for (const line of lines) expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(4096);
  });
});
