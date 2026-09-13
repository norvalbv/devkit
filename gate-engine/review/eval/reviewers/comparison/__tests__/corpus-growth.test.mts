import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { loadComparison, ROOT } from '../manifest.mts';
import { comparisonFixture } from './comparison-fixtures.mts';

const corpus = 'gate-engine/review/eval/reviewers/cases-correctness.jsonl';
const preparation = 'docs/benchmarks/experiments/2026-09-13-source-qualification';

it('accepts append-only growth without changing the frozen roster, and rejects historical edits', () => {
  const { root, protocol, cleanup } = comparisonFixture();
  const original = execFileSync('git', ['show', `${protocol.sourceRevision}:${corpus}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  try {
    const dest = path.join(root, corpus);
    writeFileSync(dest, original);
    const before = loadComparison(root);
    const appended = readFileSync(path.join(ROOT, corpus), 'utf8');
    expect(appended.startsWith(original)).toBe(true);
    expect(appended.length).toBeGreaterThan(original.length);
    writeFileSync(dest, appended);
    const after = loadComparison(root);
    expect(after.rows).toEqual(before.rows);
    expect(after.protocolSha256).toBe(before.protocolSha256);
    expect(after.assets).toEqual(before.assets);
    expect(after.historicalSources[corpus].current).not.toBe(
      before.historicalSources[corpus].current,
    );
    const lines = original.trimEnd().split('\n');
    for (const changed of [
      ` ${original}`,
      lines.slice(1).join('\n') + '\n',
      [lines[1], lines[0], ...lines.slice(2)].join('\n') + '\n',
    ]) {
      writeFileSync(dest, changed);
      expect(() => loadComparison(root)).toThrow(/historical prefix/);
    }
  } finally {
    cleanup();
  }
});

it('binds the admitted pair to the source-qualified inputs and executes all twelve controls', () => {
  const proposals = JSON.parse(
    readFileSync(path.join(ROOT, preparation, 'vue-proposals.json'), 'utf8'),
  );
  const rows = readFileSync(path.join(ROOT, corpus), 'utf8').trim().split('\n').map(JSON.parse);
  for (const proposal of proposals) {
    const admitted = rows.find((row) => row.id === proposal.id);
    expect(admitted).toMatchObject({
      repo: proposal.repo,
      expected: proposal.expected,
      caseId: proposal.caseId,
      variantOf: proposal.variantOf,
      source: proposal.source,
      provenance: 'adapted',
      holdout: true,
      qualification: { lifecycle: 'admitted', exposure: 'development-exposed' },
    });
    expect(admitted.repo).toEqual(proposal.repo);
  }
  const observed = JSON.parse(
    execFileSync(process.execPath, [path.join(ROOT, preparation, 'controls.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    }),
  );
  expect(observed).toMatchObject({ scenarios: 12, modelCalls: 0 });
  expect(observed.results.map(({ view, observed }) => [view, observed.remount.attempts])).toEqual([
    ['base', 2],
    ['bug', 1],
    ['repair', 2],
  ]);
});

it('keeps historical arm instructions pinned when current reviewer instructions evolve', () => {
  const { root, protocol, cleanup } = comparisonFixture();
  try {
    const before = loadComparison(root);
    for (const file of ['agents/correctness-reviewer.md', 'skills/correctness/SKILL.md']) {
      writeFileSync(path.join(root, file), 'Different current reviewer instructions.\n');
    }
    const after = loadComparison(root);
    expect(after.rows).toEqual(before.rows);
    expect(after.assets).toEqual(before.assets);
    for (const file of ['agents/correctness-reviewer.md', 'skills/correctness/SKILL.md']) {
      const pinned = execFileSync('git', ['show', `${protocol.sourceRevision}:${file}`], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      for (const arm of ['B', 'C'])
        expect(after.assets[arm].overrides[`.claude/${file}`]).toBe(pinned);
    }
    for (const arm of ['B', 'C', 'P', 'L']) {
      expect(Object.keys(after.assets[arm].overrides).sort()).toEqual([
        '.claude/agents/correctness-reviewer.md',
        '.claude/skills/correctness/SKILL.md',
      ]);
    }
    expect(after.assets.P.overrides['.claude/skills/correctness/SKILL.md']).toBe(
      after.assets.B.overrides['.claude/skills/correctness/SKILL.md'],
    );
    const helper = 'skills/_devkit/checklist-store.mjs';
    writeFileSync(path.join(root, helper), readFileSync(path.join(root, helper), 'utf8') + '\n');
    expect(() => loadComparison(root)).toThrow(/fixed experiment source changed/);
  } finally {
    cleanup();
  }
});

it('still rejects runtime drift with valid historical instructions', () => {
  const { root, cleanup } = comparisonFixture();
  try {
    expect(loadComparison(root).rows).toHaveLength(8);
    const runtime = path.join(root, 'gate-engine/review/reviewers.mts');
    writeFileSync(runtime, readFileSync(runtime, 'utf8') + '\n');
    expect(() => loadComparison(root)).toThrow(
      'fixed experiment source changed: gate-engine/review/reviewers.mts',
    );
  } finally {
    cleanup();
  }
});
