import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCache } from '../cache.mts';
import {
  DEFAULT_LENS_GROUPS,
  FOUR_WAY_LENS_GROUPS,
  type LensPart,
  lensGroupId,
  planReviewWork,
  type ReviewTask,
} from '../lens/split.mts';
import { REVIEWERS, type ReviewerSelection } from '../reviewers.mts';
import { runReviewGate } from '../run-review.mts';
import { narrowTasks, parseRecheckTarget, recheckHint } from '../valve/recheck.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  mkExec,
  writeArtifact,
} from './run-review-fixtures.mts';

// `guard-review lens`: only the target is judged, its PASS lands on the gate's own part key, and a
// run that judged nothing (or one lens of four) never reads as a reviewer-level PASS.

const ENV_KEYS = [
  'GUARD_CORRECTNESS_SPLIT',
  'GUARD_REVIEW_SKIP',
  'FRINK_REVIEW_SKIP',
  'GUARD_NO_REVIEW',
  'GUARD_AI_STRICT',
  'GUARD_NO_LOG',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'DEVKIT_RUN_MODE',
  'DEVKIT_REVIEW_PROGRESS',
  'DEVKIT_COMMIT_MSG_FILE',
  'DEVKIT_SHIP_BRANCH',
  'SHIP_COMMIT_TIMEOUT',
  'DEVKIT_GATE_DEADLINE_MS',
  'DECISIONS_NO_EMBED',
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.DECISIONS_NO_EMBED = '1';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanupReviewFixtures();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

const TARGET_LENS = 'error-and-edge-classification';
const CORRECTNESS = 'correctness-reviewer';

const correctness = REVIEWERS.find((r) => r.name === CORRECTNESS);
if (!correctness) throw new Error('fixture: correctness-reviewer missing from REVIEWERS');
const selection = (files: string[]): ReviewerSelection => ({ reviewer: correctness, files });
const task = (group?: string): ReviewTask => ({
  sel: selection([]),
  key: 'k',
  diffText: '',
  group,
  base: selection([]),
});

/** Lens judges write their own group-scoped artifact; the label doesn't carry the group, so the
 * fake judge writes all four (same trick as run-review.test's split describe). */
function writeLensArtifacts(repo: string, failing: string | null = null): void {
  for (const group of FOUR_WAY_LENS_GROUPS) {
    const status = group[0] === failing ? 'fail' : 'pass';
    writeFileSync(
      join(repo, `.claude/.correctness-review-${lensGroupId(group)}.json`),
      JSON.stringify({
        items: [{ name: group[0], category: 'X', status, issues: status === 'fail' ? ['b'] : [] }],
      }),
    );
  }
}

/** Which lens a correctness judge was asked for — the wrapped prompt names its `--lens`. */
const lensOf = (call: { args: string[] }): string | undefined =>
  FOUR_WAY_LENS_GROUPS.map(lensGroupId).find((id) => call.args[1].includes(`--lens ${id}`));

function lensExec(repo: string, failing: string | null = null) {
  return mkExec(async ({ label, args }) => {
    writeArtifact(repo, label);
    writeLensArtifacts(repo, failing);
    return label === `review:${CORRECTNESS}` && failing && args[1].includes(`--lens ${failing}`)
      ? 'found one\nVERDICT: FAIL — wedged'
      : 'checked\nVERDICT: PASS';
  });
}

const events = (sink: string) =>
  readFileSync(sink, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

const stderr = (): string =>
  vi
    .mocked(console.error)
    .mock.calls.map((c) => c.join(' '))
    .join('\n');

describe('parseRecheckTarget', () => {
  it('accepts a bare reviewer and a shipped four-way lens', () => {
    expect(parseRecheckTarget('api-security-reviewer', FOUR_WAY_LENS_GROUPS)).toEqual({
      reviewer: 'api-security-reviewer',
      lens: null,
    });
    expect(parseRecheckTarget(`${CORRECTNESS}:${TARGET_LENS}`, FOUR_WAY_LENS_GROUPS)).toEqual({
      reviewer: CORRECTNESS,
      lens: TARGET_LENS,
    });
  });

  it('under the paired arm accepts the group id the FAIL hint prints, and refuses a bare member', () => {
    const paired = lensGroupId(DEFAULT_LENS_GROUPS[1]);
    expect(parseRecheckTarget(`${CORRECTNESS}:${paired}`, DEFAULT_LENS_GROUPS).lens).toBe(paired);
    // A member alone is not a runnable part under pairing — running "half a group" has no cache key.
    expect(() => parseRecheckTarget(`${CORRECTNESS}:${TARGET_LENS}`, DEFAULT_LENS_GROUPS)).toThrow(
      paired,
    );
  });

  it('names every valid reviewer on an unknown one (incl. empty and case-mangled input)', () => {
    for (const bad of ['nope', '', 'Correctness-Reviewer', ':error-and-edge-classification'])
      expect(() => parseRecheckTarget(bad, FOUR_WAY_LENS_GROUPS)).toThrow(
        REVIEWERS.map((r) => r.name).join(', '),
      );
  });

  it('refuses a lens on a reviewer that has none, and an unknown or empty lens', () => {
    expect(() => parseRecheckTarget('api-security-reviewer:x', FOUR_WAY_LENS_GROUPS)).toThrow(
      /has no lenses — re-check it whole: guard-review lens api-security-reviewer/,
    );
    for (const lens of ['nope', '', `${TARGET_LENS}:extra`])
      expect(() => parseRecheckTarget(`${CORRECTNESS}:${lens}`, FOUR_WAY_LENS_GROUPS)).toThrow(
        /unknown lens .* expected one of: .*state-transitions/,
      );
  });

  it('refuses a lens while the split is off, pointing at the whole-reviewer form', () => {
    expect(() => parseRecheckTarget(`${CORRECTNESS}:${TARGET_LENS}`, null)).toThrow(
      /split is off .* guard-review lens correctness-reviewer$/,
    );
    expect(parseRecheckTarget(CORRECTNESS, null)).toEqual({ reviewer: CORRECTNESS, lens: null });
  });
});

describe('narrowTasks — chunked correctness (cap on)', () => {
  const segment = (path: string, lines: number): string =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${lines} @@\n` +
    Array.from({ length: lines }, (_, i) => `+const v${i} = '${'x'.repeat(30)}';\n`).join('');

  it('keeps every chunk of the target lens and nothing else; the whole-diff lens stays one task', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    const sel = selection(files);
    const diff = files.map((f) => segment(f, 60)).join('');
    const { tasks } = planReviewWork(
      [sel],
      [diff],
      {},
      new Map([[CORRECTNESS, 'S']]),
      (n, d, s) => `${n}::${s}::${d.length}`,
      FOUR_WAY_LENS_GROUPS,
      40,
    );
    const chunks = narrowTasks(tasks, { reviewer: CORRECTNESS, lens: TARGET_LENS });
    expect(chunks.length).toBeGreaterThan(1); // the fixture really chunked
    expect(chunks.every((t) => t.group === TARGET_LENS && t.chunk)).toBe(true);
    expect(chunks).toHaveLength(tasks.filter((t) => t.group === TARGET_LENS).length);
    // writer-reader-contracts never chunks: re-checking it is exactly one whole-diff task.
    const cross = narrowTasks(tasks, { reviewer: CORRECTNESS, lens: 'writer-reader-contracts' });
    expect(cross).toHaveLength(1);
    expect(cross[0].chunk).toBeUndefined();
  });

  it('a bare reviewer target keeps every task', () => {
    const tasks = [task('a'), task()];
    expect(narrowTasks(tasks, { reviewer: CORRECTNESS, lens: null })).toBe(tasks);
  });
});

describe('recheckHint', () => {
  const part = (status: string, group?: string): LensPart => ({
    res: { status, name: CORRECTNESS },
    secs: 0,
    task: task(group),
  });

  it('names each FAILING group once — two failing chunks of one lens are one command', () => {
    const hint = recheckHint(
      CORRECTNESS,
      [part('fail', TARGET_LENS), part('fail', TARGET_LENS), part('pass', 'state-transitions')],
      false,
    );
    expect(hint.match(/guard-review lens/g)).toHaveLength(1);
    expect(hint).toContain(`guard-review lens ${CORRECTNESS}:${TARGET_LENS}`);
    expect(hint).not.toContain('state-transitions');
  });

  it('an unsplit reviewer (or a split one that failed outside any part) gets the whole form', () => {
    expect(recheckHint('api-security-reviewer', undefined, false)).toContain(
      'guard-review lens api-security-reviewer',
    );
    expect(recheckHint(CORRECTNESS, [part('pass', TARGET_LENS)], false)).toMatch(
      /guard-review lens correctness-reviewer$/,
    );
  });

  it('under ship says the command judges the caller index and what must match to seed the cache', () => {
    expect(recheckHint('api-security-reviewer', undefined, false)).not.toContain('ship briefed');
    const ship = recheckHint('api-security-reviewer', undefined, true);
    expect(ship).toContain("YOUR checkout's staged index");
    expect(ship).toContain('GUARD_REVIEW_* model env');
  });
});

describe('runReviewGate({ only }) — the recheck lane', () => {
  it('judges exactly the target lens, records every other reviewer as recheck-skipped, and emits no partial review_result', async () => {
    const repo = consumerRepo({ backend: true });
    const sink = join(repo, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'recheck-narrow';
    const exec = lensExec(repo);
    const only = { reviewer: CORRECTNESS, lens: TARGET_LENS };
    expect(await runReviewGate(repo, { exec, only })).toBe(0);

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0].label).toBe(`review:${CORRECTNESS}`);
    expect(lensOf(exec.mock.calls[0][0])).toBe(TARGET_LENS);

    const evs = events(sink);
    const skipped = evs.filter((e) => e.type === 'review_skipped');
    const recheck = skipped.filter((e) => e.reason === 'recheck').map((e) => e.reviewer);
    // The backend fixture selects these beside correctness — never mislabelled `not_selected`.
    expect(recheck).toEqual(expect.arrayContaining(['api-security-reviewer', 'commit-guard']));
    expect(skipped.filter((e) => e.reason === 'not_selected').map((e) => e.reviewer)).not.toEqual(
      expect.arrayContaining(recheck),
    );
    // gate-verdict-attribution: one lens of four is not a correctness-reviewer verdict.
    expect(evs.filter((e) => e.type === 'review_result' && e.reviewer === CORRECTNESS)).toEqual([]);
  });

  it('its PASS seeds the exact part key a full gate computes — the next full run judges only the other lenses', async () => {
    const repo = consumerRepo({ backend: true });
    const only = { reviewer: CORRECTNESS, lens: TARGET_LENS };
    expect(await runReviewGate(repo, { exec: lensExec(repo), only })).toBe(0);
    const seeded = Object.keys(loadCache(repo));
    expect(seeded).toHaveLength(1); // one part key — never a reviewer-level key
    expect(seeded[0].startsWith(`${CORRECTNESS}:`)).toBe(true);

    const full = lensExec(repo);
    expect(await runReviewGate(repo, { exec: full })).toBe(0);
    const judgedLenses = full.mock.calls
      .filter((c) => c[0].label === `review:${CORRECTNESS}`)
      .map((c) => lensOf(c[0]));
    expect(judgedLenses).toHaveLength(FOUR_WAY_LENS_GROUPS.length - 1);
    expect(judgedLenses).not.toContain(TARGET_LENS);
    expect(stderr()).toMatch(new RegExp(`${CORRECTNESS} \\[${TARGET_LENS}\\].*cached PASS`));
  });

  it('a full-gate PASS already cached for the lens → exit 0 with zero judges (re-running a recheck is free)', async () => {
    const repo = consumerRepo({ backend: true });
    expect(await runReviewGate(repo, { exec: lensExec(repo) })).toBe(0);
    const again = lensExec(repo);
    const only = { reviewer: CORRECTNESS, lens: TARGET_LENS };
    expect(await runReviewGate(repo, { exec: again, only })).toBe(0);
    expect(again).not.toHaveBeenCalled();
  });

  it('a whole-reviewer recheck of an unsplit reviewer seeds the same key the full gate hits', async () => {
    process.env.GUARD_CORRECTNESS_SPLIT = 'off';
    const repo = consumerRepo({ backend: true });
    const only = { reviewer: 'api-security-reviewer', lens: null };
    expect(await runReviewGate(repo, { exec: lensExec(repo), only })).toBe(0);
    const full = lensExec(repo);
    expect(await runReviewGate(repo, { exec: full })).toBe(0);
    expect(full.mock.calls.map((c) => c[0].label)).not.toContain('review:api-security-reviewer');
  });

  it('a FAILing recheck blocks (exit 1), keeps the finding, caches nothing, and prints no self-referential hint', async () => {
    const repo = consumerRepo({ backend: true });
    const only = { reviewer: CORRECTNESS, lens: TARGET_LENS };
    expect(await runReviewGate(repo, { exec: lensExec(repo, TARGET_LENS), only })).toBe(1);
    expect(loadCache(repo)).toEqual({});
    expect(stderr()).toContain(`${CORRECTNESS} FAILED`);
    expect(stderr()).not.toContain('Re-check a fix locally');
  });

  it('a target the staged files do not select exits 1 without judging — never a silent PASS', async () => {
    const repo = consumerRepo({ frontend: true });
    const sink = join(repo, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'recheck-unselected';
    const exec = lensExec(repo);
    const only = { reviewer: 'api-security-reviewer', lens: null };
    expect(await runReviewGate(repo, { exec, only })).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(stderr()).toContain('api-security-reviewer is not selected by the staged files');
    // gate-verdict-attribution: even this early exit gives EVERY reviewer exactly one skip row.
    const skipped = events(sink).filter((e) => e.type === 'review_skipped');
    expect(skipped.map((e) => e.reviewer).sort()).toEqual(REVIEWERS.map((r) => r.name).sort());
    expect(skipped.find((e) => e.reviewer === 'api-security-reviewer')?.reason).toBe(
      'not_selected',
    );
  });

  it('a target dropped by an exported GUARD_REVIEW_SKIP says so instead of blaming the staged set', async () => {
    process.env.GUARD_REVIEW_SKIP = CORRECTNESS;
    const repo = consumerRepo({ backend: true });
    const exec = lensExec(repo);
    const only = { reviewer: CORRECTNESS, lens: TARGET_LENS };
    expect(await runReviewGate(repo, { exec, only })).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(stderr()).toContain('dropped by GUARD_REVIEW_SKIP');
  });
});

describe('the full gate names the recheck command under each FAIL (AC1)', () => {
  it('a failing correctness lens prints its exact reviewer:lens once', async () => {
    const repo = consumerRepo({ backend: true });
    expect(await runReviewGate(repo, { exec: lensExec(repo, TARGET_LENS) })).toBe(1);
    const lines = stderr().match(/guard-review lens \S+/g) ?? [];
    expect(lines).toEqual([`guard-review lens ${CORRECTNESS}:${TARGET_LENS}`]);
  });

  it('a cascade-confirmed domain FAIL prints the whole-reviewer form beside the skip remedy', async () => {
    process.env.GUARD_CORRECTNESS_SPLIT = 'off';
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async ({ label }) => {
      writeArtifact(repo, label, label.startsWith('review:api-security') ? { failed: 1 } : {});
      return label.startsWith('review:api-security')
        ? 'bad\nVERDICT: FAIL — injection'
        : 'VERDICT: PASS';
    });
    expect(await runReviewGate(repo, { exec })).toBe(1);
    expect(stderr()).toContain('guard-review lens api-security-reviewer');
  });
});

describe('guard-review lens — CLI argument contract', () => {
  const cli = fileURLToPath(new URL('../cli.mts', import.meta.url));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env } });

  it('an unknown target is a usage error (exit 2) naming the valid choices — never runs a gate', () => {
    const r = run('lens', `${CORRECTNESS}:nope`);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('guard-review lens: unknown lens');
  });

  // A recheck that judges nothing must not exit 0: a leftover GUARD_NO_REVIEW=1 from an earlier
  // approved bypass, or a noLlm install, would otherwise read as "the fix cleared the lens".
  it.each([
    ['GUARD_NO_REVIEW', { GUARD_NO_REVIEW: '1' }],
    ['noLlm', { GUARD_DECISION_NO_LLM: '1' }],
  ])('refuses (exit 1) when %s disables review instead of passing vacuously', (_, env) => {
    const repo = consumerRepo({ backend: true });
    const r = spawnSync(process.execPath, [cli, 'lens', CORRECTNESS], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('review is disabled');
  });

  it('a missing target falls through to the usage line, which lists the lens mode', () => {
    const r = run('lens');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('lens <reviewer>[:<lens>]');
  });
});
