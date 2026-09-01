import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReviewGate } from '../run-review.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  mkExec,
  writeArtifact,
} from './run-review-fixtures.mts';

let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanupReviewFixtures();
  vi.restoreAllMocks();
});

describe('multi-finding FAIL report', () => {
  it('a FAILing reviewer lists every distinct lens issue once, bounded, above the transcript', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async ({ label }) => {
      if (label.startsWith('review:api-security-reviewer')) {
        // Two distinct defects + one duplicate (same file, same 5-line bucket) across two lenses.
        writeFileSync(
          join(repo, '.claude', '.api-security-review.json'),
          JSON.stringify({
            items: [
              {
                name: 'injection',
                category: 'A',
                status: 'fail',
                issues: [
                  'interpolated SQL at src/main/db.ts:12 — user input reaches the query string',
                  'same interpolation seen at src/main/db.ts:13',
                ],
              },
              {
                name: 'auth',
                category: 'B',
                status: 'fail',
                issues: ['missing authz check at src/main/other.ts:40 for the delete route'],
              },
              { name: 'transport', category: 'C', status: 'pass', issues: [] },
            ],
          }),
        );
        return 'bad\nVERDICT: FAIL — findings recorded';
      }
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    const sink = join(repo, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    try {
      expect(await runReviewGate(repo, { exec })).toBe(1);
    } finally {
      delete process.env.DEVKIT_GATE_EVENTS;
    }
    const events = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const apiResult = events.find(
      (e) => e.type === 'review_result' && e.reviewer === 'api-security-reviewer',
    );
    expect(apiResult?.items?.length).toBeGreaterThanOrEqual(2); // the artifact reached the outcome
    const out = err.mock.calls.flat().join('\n');
    // The bounded deduped list…
    expect(out).toContain('api-security-reviewer: 2 finding(s), 1 duplicate(s) folded:');
    expect(out).toContain('injection · src/main/db.ts:12');
    expect(out).toContain('auth · src/main/other.ts:40');
  });

  it('the block survives an items spill to the sidecar (itemsRef), where res.items is absent', async () => {
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async ({ label }) => {
      if (label.startsWith('review:api-security-reviewer')) {
        // 12 failing lenses × ~180-char issues serialize past ITEMS_INLINE_BUDGET (2000 B) → spill.
        const items = Array.from({ length: 12 }, (_, i) => ({
          name: `lens-${String(i).padStart(2, '0')}`,
          category: 'A',
          status: 'fail',
          issues: [`defect ${i} at src/main/f${i}.ts:${i * 50 + 1} — ${'x'.repeat(150)}`],
        }));
        writeFileSync(
          join(repo, '.claude', '.api-security-review.json'),
          JSON.stringify({
            items: [...items, { name: 'ok', category: 'B', status: 'pass', issues: [] }],
          }),
        );
        return 'bad\nVERDICT: FAIL — findings recorded';
      }
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    const sink = join(repo, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'ship-spill-findings';
    try {
      expect(await runReviewGate(repo, { exec })).toBe(1);
    } finally {
      delete process.env.DEVKIT_GATE_EVENTS;
      delete process.env.DEVKIT_SHIP_ID;
    }
    const events = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const apiResult = events.find(
      (e) => e.type === 'review_result' && e.reviewer === 'api-security-reviewer',
    );
    expect(apiResult.items).toBeUndefined(); // proven spilled…
    expect(apiResult.items_ref).toMatch(/items-/);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('api-security-reviewer: 12 finding(s):'); // …yet the block still prints
    expect(out).toContain('lens-00 · src/main/f0.ts:1');
  });
});

// sc-2480: an agent scrolls to the findings and stops. The base has to be ABOVE them, and it has to
// be there exactly once no matter how many reviewers ran or how many lens parts one of them failed.
describe('the reviewed base precedes the findings', () => {
  it('prints the provenance line before the first FAIL block, exactly once', async () => {
    const repo = consumerRepo({ backend: true, frontend: true });
    const head = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
    const exec = mkExec(async ({ label }) => {
      if (label.startsWith('review:api-security-reviewer')) {
        writeFileSync(
          join(repo, '.claude', '.api-security-review.json'),
          JSON.stringify({
            items: [
              {
                name: 'injection',
                category: 'A',
                status: 'fail',
                issues: ['interpolated SQL at src/main/db.ts:12'],
              },
            ],
          }),
        );
        return 'bad\nVERDICT: FAIL — findings recorded';
      }
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(1);
    const printed = err.mock.calls.map((c) => String(c[0]));
    const provenance = printed.filter((l) => l.includes('reviewed against'));
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toContain(head.slice(0, 12));
    const at = printed.findIndex((l) => l.includes('reviewed against'));
    const firstFinding = printed.findIndex((l) => l.includes('finding(s)'));
    expect(firstFinding).toBeGreaterThan(at);
  });
});
