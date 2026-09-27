// sc-3468 end to end: a PASS replayed after a rebase names the OLD base it was judged against on its
// line, scope row and cache_hit, and no "reviewed against <new base>" claim is printed for it.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedBaseState, resetReviewBaseContext } from '../evidence/base-context.mts';
import { emitReviewScope } from '../evidence/scope.mts';
import { REVIEWERS } from '../reviewers.mts';
import { runReviewGate } from '../run-review.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  passWithArtifact,
  syncSkillAssets,
} from './run-review-fixtures.mts';

const envKeys = [
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'DEVKIT_SHIP_BASE_SHA',
  'DEVKIT_SHIP_SOURCE_HEAD',
  'DEVKIT_REVIEW_MERGE_BASE',
  'GUARD_CORRECTNESS_SPLIT',
] as const;
const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
let err: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // The fixture's writeArtifact satisfies the undivided correctness contract only; split parts'
  // stored bases are covered by lens-split.test.mts.
  process.env.GUARD_CORRECTNESS_SPLIT = 'off';
  resetReviewBaseContext();
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanupReviewFixtures();
  resetReviewBaseContext();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

const git = (repo: string, args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

/** Commit ONLY `paths`, leaving the rest of the index staged — the base moving under a staged diff. */
function commitOnly(repo: string, message: string, paths: string[]): string {
  git(repo, ['add', '--', ...paths]);
  git(repo, [
    '-c',
    'user.email=devkit@example.test',
    '-c',
    'user.name=Devkit Test',
    'commit',
    '-qm',
    message,
    '--',
    ...paths,
  ]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/** One gate run: its stderr, and this run's events from the sink. The base context is per-run state
 * in the real gate (one process per hook), so it is reset between runs here. */
async function gateRun(repo: string, shipId: string) {
  resetReviewBaseContext();
  err.mockClear();
  const sink = join(repo, `events-${shipId}.jsonl`);
  process.env.DEVKIT_GATE_EVENTS = sink;
  process.env.DEVKIT_SHIP_ID = shipId;
  const code = await runReviewGate(repo, { exec: passWithArtifact(repo) });
  const stderr = err.mock.calls.map((c) => String(c[0]));
  const events = readFileSync(sink, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  return { code, stderr, events };
}

/** The slice of the verdict store these tests read or rewrite. */
interface StoredCache {
  entries: Record<string, { base_sha?: string }>;
}

const cacheEntries = (repo: string): StoredCache['entries'] => {
  const store: StoredCache = JSON.parse(
    readFileSync(join(repo, '.devkit', 'review-cache.json'), 'utf8'),
  );
  return store.entries;
};

const BACKEND = 'backend-performance-reviewer';

/** A consumer whose every selected reviewer can PASS, so a re-run is served wholly from cache. */
function passingRepo(): string {
  const repo = consumerRepo({ backend: true });
  syncSkillAssets(repo);
  return repo;
}
const lineFor = (stderr: string[], reviewer: string) =>
  stderr.find((l) => l.startsWith(`guard-review: ${reviewer} — cached PASS`));

describe('a replayed PASS names the base it was judged against (sc-3468)', () => {
  it('base moved on an unreviewed path: names both bases, keeps it a clear hit, claims no review of the new base', async () => {
    const repo = passingRepo();
    const first = await gateRun(repo, 'ship-first');
    expect(first.code).toBe(0);
    const oldBase = git(repo, ['rev-parse', 'HEAD']);
    // Every PASS the gate saved records the tree its judge saw.
    const saved = Object.values(cacheEntries(repo));
    expect(saved.length).toBeGreaterThan(0);
    for (const meta of saved) expect(meta.base_sha).toBe(oldBase);

    writeFileSync(join(repo, 'NOTES.md'), 'main moved on\n');
    const newBase = commitOnly(repo, 'main moved', ['NOTES.md']);
    const retry = await gateRun(repo, 'ship-retry');

    expect(retry.code).toBe(0);
    expect(lineFor(retry.stderr, BACKEND)).toBe(
      `guard-review: ${BACKEND} — cached PASS (identical diff; judged against ${oldBase.slice(0, 12)}, ` +
        `base now ${newBase.slice(0, 12)} — no reviewed path changed between them; not re-judged)`,
    );
    expect(retry.stderr.some((l) => l.includes('reviewed against'))).toBe(false);
    expect(retry.stderr).toContain(
      `guard-review: no reviewer ran this attempt — this run's base is ${newBase.slice(0, 12)} ` +
        '(local HEAD), and each cached PASS above names the base it was judged against.',
    );
    const scope = retry.events.find((e) => e.type === 'review_scope' && e.reviewer === BACKEND);
    expect(scope).toMatchObject({
      cached: true,
      base_sha: oldBase,
      current_base_sha: newBase,
      base_state: 'moved-clear',
    });
    const hit = retry.events.find((e) => e.type === 'cache_hit' && e.judge === `review:${BACKEND}`);
    expect(hit).toMatchObject({ judged_base_sha: oldBase, base_state: 'moved-clear' });

    // A replay never re-stamps the stored base: a third run still names the tree actually judged.
    for (const meta of Object.values(cacheEntries(repo))) expect(meta.base_sha).toBe(oldBase);
    const third = await gateRun(repo, 'ship-third');
    expect(lineFor(third.stderr, BACKEND)).toContain(`judged against ${oldBase.slice(0, 12)}`);
  });

  it('base changed a reviewed file away from the hunk: identical diff identity, reported as overlap', async () => {
    const repo = passingRepo();
    const db = join(repo, 'src', 'main', 'db.ts');
    const lines = Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`);
    const render = (edits: Record<number, string>) =>
      `${lines.map((l, i) => edits[i] ?? l).join('\n')}\n`;
    writeFileSync(db, render({}));
    commitOnly(repo, 'base A', ['src/main/db.ts']);
    writeFileSync(db, render({ 1: 'export const v1 = 100;' }));
    git(repo, ['add', 'src/main/db.ts']);
    expect((await gateRun(repo, 'ship-a')).code).toBe(0);
    const oldBase = git(repo, ['rev-parse', 'HEAD']);

    // The rebase: main edits line 28 of the same file; the branch's own hunk (line 1) is replayed.
    writeFileSync(db, render({ 28: 'export const v28 = -1;' }));
    const newBase = commitOnly(repo, 'base B', ['src/main/db.ts']);
    writeFileSync(db, render({ 1: 'export const v1 = 100;', 28: 'export const v28 = -1;' }));
    git(repo, ['add', 'src/main/db.ts']);
    const retry = await gateRun(repo, 'ship-b');

    expect(retry.code).toBe(0);
    expect(lineFor(retry.stderr, BACKEND)).toBe(
      `guard-review: ${BACKEND} — cached PASS (identical diff; judged against ${oldBase.slice(0, 12)}, ` +
        `base now ${newBase.slice(0, 12)} — 1 reviewed path(s) changed between them: src/main/db.ts; ` +
        'NOT re-judged against them)',
    );
    const hit = retry.events.find((e) => e.type === 'cache_hit' && e.judge === `review:${BACKEND}`);
    expect(hit).toMatchObject({ judged_base_sha: oldBase, base_state: 'moved-overlap' });
  });

  it('a PASS stored before base recording existed is reported unknown, never attributed to this base', async () => {
    const repo = passingRepo();
    expect((await gateRun(repo, 'ship-legacy-a')).code).toBe(0);
    const file = join(repo, '.devkit', 'review-cache.json');
    const store: StoredCache = JSON.parse(readFileSync(file, 'utf8'));
    for (const meta of Object.values(store.entries)) delete meta.base_sha;
    writeFileSync(file, JSON.stringify(store));
    const retry = await gateRun(repo, 'ship-legacy-b');
    expect(lineFor(retry.stderr, BACKEND)).toContain('judged base UNKNOWN — not re-judged against');
    const scope = retry.events.find((e) => e.type === 'review_scope' && e.reviewer === BACKEND);
    expect(scope).toMatchObject({ base_sha: null, base_state: 'unknown' });
  });

  it('an unmoved base keeps the historical wording and the base claim', async () => {
    const repo = passingRepo();
    expect((await gateRun(repo, 'ship-same-a')).code).toBe(0);
    const head = git(repo, ['rev-parse', 'HEAD']);
    const retry = await gateRun(repo, 'ship-same-b');
    expect(lineFor(retry.stderr, BACKEND)).toBe(
      `guard-review: ${BACKEND} — cached PASS (identical diff)`,
    );
    const scope = retry.events.find((e) => e.type === 'review_scope' && e.reviewer === BACKEND);
    expect(scope).toMatchObject({ base_sha: head, base_state: 'current' });
    // A current-base hit still names the base its PASS was judged against on cache_hit.
    const hit = retry.events.find((e) => e.type === 'cache_hit' && e.judge === `review:${BACKEND}`);
    expect(hit).toMatchObject({ judged_base_sha: head, base_state: 'current' });
  });

  it('a partly replayed reviewer keeps this base for its live parts and flags the replayed ones', () => {
    const repo = passingRepo();
    const judged = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'NOTES.md'), 'main moved on\n');
    const live = commitOnly(repo, 'main moved', ['NOTES.md']);
    const sink = join(repo, 'events-partial.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'ship-partial';
    const sel = { reviewer: REVIEWERS[0], files: ['src/main/db.ts'] };
    const verdict = cachedBaseState(repo, [judged], sel.files, {});
    emitReviewScope(sel, 'diff', null, false, null, repo, { cachedBase: verdict });
    const [row] = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(row).toMatchObject({
      cached: false,
      base_sha: live,
      current_base_sha: live,
      cached_parts_base_state: 'moved-clear',
    });
    expect(row.base_state).toBeUndefined();
  });
});
