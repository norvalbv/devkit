import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  baseProvenanceLines,
  cachedBaseState,
  cachedPassLine,
  movedOnBase,
  primeReviewBaseContext,
  judgedBaseSha,
  resetReviewBaseContext,
  reviewBaseContext,
  storedBaseSchema,
} from '../evidence/base-context.mts';
import { cleanupReviewFixtures, trackReviewFixtureDir } from './run-review-fixtures.mts';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function commit(repo: string, message: string): string {
  git(repo, ['add', '-A']);
  git(repo, [
    '-c',
    'user.email=devkit@example.test',
    '-c',
    'user.name=Devkit Test',
    'commit',
    '-qm',
    message,
  ]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/** A repo whose HEAD is the REVIEWED tree, plus an earlier commit standing in for the caller's own
 * worktree HEAD. Only `moved.ts` differs between them. */
function divergedRepo() {
  const repo = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'guard-review-base-')));
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'moved.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'untouched.ts'), 'export const b = 1;\n');
  const caller = commit(repo, 'caller cut here');
  writeFileSync(join(repo, 'moved.ts'), 'export const a = 2;\n');
  const base = commit(repo, 'the base moved on');
  return { repo, caller, base };
}

const shipEnv = (base: string, caller: string): NodeJS.ProcessEnv => ({
  DEVKIT_SHIP_BASE_SHA: base,
  DEVKIT_SHIP_SOURCE_HEAD: caller,
});

describe('review base context (sc-2480)', () => {
  beforeEach(() => resetReviewBaseContext());
  afterEach(() => {
    resetReviewBaseContext();
    cleanupReviewFixtures();
  });

  it('names the reviewed tree on a plain commit, with no divergence clause', () => {
    const { repo, base } = divergedRepo();
    const lines = baseProvenanceLines(repo, ['moved.ts'], {});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`reviewed against ${base.slice(0, 12)}`);
    expect(lines[0]).toContain('local HEAD');
    expect(lines[0]).not.toContain('behind');
  });

  it('does NOT warn when the base moved but no reviewed path moved with it', () => {
    const { repo, caller, base } = divergedRepo();
    const lines = baseProvenanceLines(repo, ['untouched.ts'], shipEnv(base, caller));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ship base');
    expect(lines.join('\n')).not.toContain('ALSO changed');
  });

  it('warns and NAMES the path when a reviewed path also moved on the base', () => {
    const { repo, caller, base } = divergedRepo();
    const lines = baseProvenanceLines(repo, ['moved.ts', 'untouched.ts'], shipEnv(base, caller));
    const warning = lines.find((l) => l.includes('ALSO changed'));
    expect(warning).toBeDefined();
    expect(warning).toContain('moved.ts');
    expect(warning).not.toContain('untouched.ts');
  });

  it('reports a base the invoking ship disagrees with, rather than believing the hint', () => {
    const { repo, caller, base } = divergedRepo();
    const lines = baseProvenanceLines(repo, ['moved.ts'], {
      DEVKIT_SHIP_BASE_SHA: caller,
      DEVKIT_SHIP_SOURCE_HEAD: caller,
    });
    expect(lines[0]).toContain(base.slice(0, 12));
    expect(lines[1]).toContain(caller.slice(0, 12));
    expect(lines[1]).toContain('the reviewed tree is what the findings describe');
  });

  it('degrades LOUDLY when the reviewed tree has no readable HEAD', () => {
    const repo = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'guard-review-base-unborn-')));
    git(repo, ['init', '-q']);
    const lines = baseProvenanceLines(repo, ['moved.ts'], {});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('base UNKNOWN');
    expect(lines[0]).toContain('rather than refuted');
  });

  it('keeps the behind count as a diagnostic on the provenance line, never as a trigger', () => {
    const { repo, caller, base } = divergedRepo();
    const ctx = reviewBaseContext(repo, shipEnv(base, caller));
    expect(ctx.behind).toBe(1);
    expect(ctx.callerHead).toBe(caller);
    // The count is non-zero and a reviewed path did NOT move: still no warning.
    expect(baseProvenanceLines(repo, ['untouched.ts'], shipEnv(base, caller))).toHaveLength(1);
  });

  it('ignores a caller head that is not a resolvable commit', () => {
    const { repo, base } = divergedRepo();
    const ctx = reviewBaseContext(repo, {
      DEVKIT_SHIP_BASE_SHA: base,
      DEVKIT_SHIP_SOURCE_HEAD: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    expect(ctx.callerHead).toBeNull();
    expect(movedOnBase(repo, ctx)).toEqual([]);
  });
});

describe('review base context — degradation and boundaries (sc-2480)', () => {
  beforeEach(() => resetReviewBaseContext());
  afterEach(() => {
    resetReviewBaseContext();
    cleanupReviewFixtures();
  });

  // The whole feature exists because silence read as "verified". An overlap that CANNOT be computed
  // must not render identically to one that was computed and came back empty.
  it('says so LOUDLY when the overlap cannot be computed at all', () => {
    const repo = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'guard-review-base-orphan-')));
    git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'moved.ts'), 'a\n');
    const caller = commit(repo, 'caller');
    git(repo, ['checkout', '-q', '--orphan', 'unrelated']);
    git(repo, ['rm', '-q', '-rf', '.']);
    writeFileSync(join(repo, 'moved.ts'), 'b\n');
    const base = commit(repo, 'unrelated history');
    // `git diff <a>...<b>` exits 128 with "no merge base" — the shape a shallow CI clone also hits.
    const lines = baseProvenanceLines(repo, ['moved.ts'], shipEnv(base, caller));
    expect(lines.join('\n')).toMatch(/could not be determined|UNDETERMINED/i);
    expect(lines.join('\n')).not.toContain('ALSO changed');
  });

  it('never fabricates a commit distance it could not compute', () => {
    const repo = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'guard-review-base-ahead-')));
    git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'moved.ts'), 'a\n');
    const base = commit(repo, 'base');
    writeFileSync(join(repo, 'moved.ts'), 'b\n');
    const caller = commit(repo, 'caller is AHEAD of the base');
    git(repo, ['checkout', '-q', base]);
    // The base is 0 commits ahead of the caller: printing "0 commit(s) ahead" reads as a measured
    // fact about a worktree that is in truth in front of the base.
    const lines = baseProvenanceLines(repo, ['moved.ts'], shipEnv(base, caller));
    expect(lines[0]).not.toContain('0 commit(s)');
  });

  it('does not report a mismatch when the ship names the SAME base in short form', () => {
    const { repo, base } = divergedRepo();
    const lines = baseProvenanceLines(repo, ['moved.ts'], {
      DEVKIT_SHIP_BASE_SHA: base.slice(0, 12),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ship base');
  });

  it('treats a caller head that resolves to the base itself as no divergence', () => {
    const { repo, base } = divergedRepo();
    const ctx = reviewBaseContext(repo, {
      DEVKIT_SHIP_BASE_SHA: base,
      DEVKIT_SHIP_SOURCE_HEAD: base.slice(0, 10),
    });
    expect(ctx.callerHead).toBeNull();
  });

  // The -z parsing exists for exactly these names; nothing proved it until now.
  it('names a moved path containing a space and a quote', () => {
    const repo = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'guard-review-base-odd-')));
    const odd = 'src/a file "quoted".ts';
    git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'keep.ts'), 'k\n');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, odd), 'a\n');
    const caller = commit(repo, 'one');
    writeFileSync(join(repo, odd), 'b\n');
    const base = commit(repo, 'two');
    const lines = baseProvenanceLines(repo, [odd], shipEnv(base, caller));
    expect(lines.join('\n')).toContain(odd);
  });

  // A path DELETED on the base is the sharpest case: the agent reads it from its own HEAD, finds it
  // present, and concludes the reviewer invented its removal.
  it('reports a path DELETED on the base as moved', () => {
    const repo = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'guard-review-base-del-')));
    git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'gone.ts'), 'a\n');
    writeFileSync(join(repo, 'keep.ts'), 'k\n');
    const caller = commit(repo, 'one');
    rmSync(join(repo, 'gone.ts'));
    const base = commit(repo, 'two');
    const lines = baseProvenanceLines(repo, ['gone.ts'], shipEnv(base, caller));
    expect(lines.join('\n')).toContain('gone.ts');
    expect(lines.join('\n')).toContain('ALSO changed');
  });

  it('caps the named paths and states how many it withheld', () => {
    const repo = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'guard-review-base-many-')));
    git(repo, ['init', '-q']);
    const files = Array.from({ length: 14 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`);
    for (const f of files) writeFileSync(join(repo, f), 'a\n');
    const caller = commit(repo, 'one');
    for (const f of files) writeFileSync(join(repo, f), 'b\n');
    const base = commit(repo, 'two');
    const warning = baseProvenanceLines(repo, files, shipEnv(base, caller)).find((l) =>
      l.includes('ALSO changed'),
    );
    expect(warning).toContain('14 reviewed path(s)');
    expect(warning).toContain('…and 4 more');
  });

  it('does not let a reviewed file match a sibling that merely shares its prefix', () => {
    const repo = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'guard-review-base-prefix-')));
    git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'ship.ts'), 'a\n');
    writeFileSync(join(repo, 'shipwreck.ts'), 'a\n');
    const caller = commit(repo, 'one');
    writeFileSync(join(repo, 'shipwreck.ts'), 'b\n');
    const base = commit(repo, 'two');
    expect(baseProvenanceLines(repo, ['ship.ts'], shipEnv(base, caller))).toHaveLength(1);
  });
});

describe('base provenance hardening (reviewer findings)', () => {
  beforeEach(() => resetReviewBaseContext());
  afterEach(() => {
    resetReviewBaseContext();
    cleanupReviewFixtures();
  });

  it('treats a malformed base hint as a mismatch, not as an abbreviation that happens to match', () => {
    const { repo, base } = divergedRepo();
    const ctx = reviewBaseContext(repo, { DEVKIT_SHIP_BASE_SHA: base.slice(0, 1) });
    expect(ctx.envHintMismatch).not.toBeNull();
  });

  it('reports the head it was PINNED to, not one re-read after the evidence was captured', () => {
    const { repo, caller, base } = divergedRepo();
    // The caller's tree advanced after the gate snapshotted its evidence; the provenance must
    // still describe the tree the reviewers saw.
    primeReviewBaseContext(repo, caller, shipEnv(base, caller));
    expect(reviewBaseContext(repo, shipEnv(base, caller)).baseSha).toBe(caller);
    expect(baseProvenanceLines(repo, ['moved.ts'], shipEnv(base, caller))[0]).toContain(
      caller.slice(0, 12),
    );
  });
});

// sc-3468: a cached PASS replayed across a rebase must name the base it was JUDGED against. HEAD of
// the fixture is this run's base; `caller` stands in for the earlier base the PASS was stored on.
describe('cached PASS base state (sc-3468)', () => {
  beforeEach(() => resetReviewBaseContext());
  afterEach(() => {
    resetReviewBaseContext();
    cleanupReviewFixtures();
  });

  it('a PASS judged on this very base keeps the historical line byte-for-byte', () => {
    const { repo, base } = divergedRepo();
    const verdict = cachedBaseState(repo, [base], ['moved.ts'], {});
    expect(verdict.state).toBe('current');
    expect(cachedPassLine('commit-guard', verdict)).toBe(
      'guard-review: commit-guard — cached PASS (identical diff)',
    );
  });

  // An abbreviation can name a different commit than the one judged, so it is never prefix-matched.
  it.each([
    ['this base', 'base'],
    ['the earlier base', 'caller'],
  ] as const)(
    'an abbreviated stored sha of %s is unknown, never matched by prefix',
    (_l, which) => {
      const shas = divergedRepo();
      const verdict = cachedBaseState(shas.repo, [shas[which].slice(0, 12)], ['moved.ts'], {});
      expect(verdict.state).toBe('unknown');
    },
  );

  it('names both bases when the base moved but no reviewed path changed between them', () => {
    const { repo, caller, base } = divergedRepo();
    const verdict = cachedBaseState(repo, [caller], ['untouched.ts'], {});
    expect(verdict).toEqual({
      state: 'moved-clear',
      judged: [caller],
      current: base,
      overlapping: [],
    });
    expect(cachedPassLine('commit-guard', verdict)).toBe(
      `guard-review: commit-guard — cached PASS (identical diff; judged against ${caller.slice(0, 12)}, ` +
        `base now ${base.slice(0, 12)} — no reviewed path changed between them; not re-judged)`,
    );
  });

  it('names the reviewed paths that changed between the judged base and this one', () => {
    const { repo, caller } = divergedRepo();
    const verdict = cachedBaseState(repo, [caller], ['moved.ts', 'untouched.ts'], {});
    expect(verdict.state).toBe('moved-overlap');
    expect(verdict.overlapping).toEqual(['moved.ts']);
    expect(cachedPassLine('commit-guard', verdict)).toContain(
      '1 reviewed path(s) changed between them: moved.ts; NOT re-judged against them)',
    );
  });

  it('answers for a force-pushed base that is no descendant of the judged one', () => {
    const { repo, caller } = divergedRepo();
    git(repo, ['checkout', '-q', '-b', 'rewritten', caller]);
    writeFileSync(join(repo, 'untouched.ts'), 'export const b = 9;\n');
    const rewritten = commit(repo, 'history rewritten');
    git(repo, ['checkout', '-q', '--detach', caller]);
    writeFileSync(join(repo, 'moved.ts'), 'export const a = 7;\n');
    const judged = commit(repo, 'the abandoned base');
    git(repo, ['checkout', '-q', 'rewritten']);
    const verdict = cachedBaseState(repo, [judged], ['untouched.ts'], {});
    expect(verdict.current).toBe(rewritten);
    expect(verdict.state).toBe('moved-overlap');
  });

  it.each([
    ['absent (a PASS stored before sc-3468)', null],
    ['an empty string', ''],
    ['a non-hex string', 'not-a-sha'],
  ])('treats %s stored base as unknown', (_label, stored) => {
    const { repo, base } = divergedRepo();
    const verdict = cachedBaseState(repo, [stored], ['moved.ts'], {});
    expect(verdict.state).toBe('unknown');
    expect(cachedPassLine('commit-guard', verdict)).toBe(
      `guard-review: commit-guard — cached PASS (identical diff; judged base UNKNOWN — not re-judged against ${base.slice(0, 12)})`,
    );
  });

  it.each([
    ['absent', undefined],
    ['a number', 42],
    ['an object', { sha: 'a'.repeat(40) }],
    ['option-shaped', '--output=/tmp/x'],
    ['uppercase hex', 'A'.repeat(40)],
  ])('the cache-read schema rejects a stored base that is %s', (_label, raw) => {
    expect(storedBaseSchema.safeParse(raw).success).toBe(false);
  });

  it('the cache-read schema keeps only a full SHA-1 or SHA-256 object id', () => {
    expect(storedBaseSchema.safeParse('a'.repeat(40)).data).toBe('a'.repeat(40));
    expect(storedBaseSchema.safeParse('b'.repeat(64)).data).toBe('b'.repeat(64));
    for (const partial of ['abc1234', 'a'.repeat(39), 'a'.repeat(41), 'b'.repeat(65)])
      expect(storedBaseSchema.safeParse(partial).success).toBe(false);
  });

  it('a split part keeps its historical `(identical)` wording, and names bases the same way', () => {
    const { repo, caller, base } = divergedRepo();
    const current = cachedBaseState(repo, [base], ['moved.ts'], {});
    expect(cachedPassLine('correctness-reviewer [x]', current, 'identical')).toBe(
      'guard-review: correctness-reviewer [x] — cached PASS (identical)',
    );
    const moved = cachedBaseState(repo, [caller], ['untouched.ts'], {});
    expect(cachedPassLine('correctness-reviewer [x]', moved, 'identical')).toContain(
      `cached PASS (identical; judged against ${caller.slice(0, 12)}`,
    );
  });

  it('classifies a SHA-256 object-format repository like a SHA-1 one', () => {
    const repo = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'guard-review-sha256-')));
    git(repo, ['init', '-q', '--object-format=sha256']);
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'b.ts'), 'export const b = 1;\n');
    const judged = commit(repo, 'judged');
    writeFileSync(join(repo, 'b.ts'), 'export const b = 2;\n');
    const now = commit(repo, 'moved');
    expect(judged).toHaveLength(64);
    expect(cachedBaseState(repo, [now], ['a.ts'], {}).state).toBe('current');
    expect(cachedBaseState(repo, [judged], ['a.ts'], {}).state).toBe('moved-clear');
    expect(cachedBaseState(repo, [judged], ['b.ts'], {}).state).toBe('moved-overlap');
  });

  it('judgedBaseSha names the current base for a current hit and the single old one otherwise', () => {
    const { repo, caller, base } = divergedRepo();
    expect(judgedBaseSha(cachedBaseState(repo, [base], ['moved.ts'], {}))).toBe(base);
    expect(judgedBaseSha(cachedBaseState(repo, [caller], ['untouched.ts'], {}))).toBe(caller);
    expect(judgedBaseSha(cachedBaseState(repo, [null], ['moved.ts'], {}))).toBeNull();
  });

  it('never hands a stored option-shaped value to git argv', () => {
    const { repo } = divergedRepo();
    const out = join(repo, 'pwned.txt');
    expect(cachedBaseState(repo, [`--output=${out}`], ['moved.ts'], {}).state).toBe('unknown');
    expect(existsSync(out)).toBe(false);
  });

  it('a well-formed sha git cannot read (gc, shallow clone) is unknown, never clear', () => {
    const { repo } = divergedRepo();
    const ghost = 'deadbeef'.repeat(5);
    expect(cachedBaseState(repo, [ghost], ['untouched.ts'], {}).state).toBe('unknown');
  });

  it('an unborn HEAD has no current base to compare against', () => {
    const repo = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'guard-review-unborn-')));
    git(repo, ['init', '-q']);
    const verdict = cachedBaseState(repo, ['a'.repeat(40)], ['x.ts'], {});
    expect(verdict).toMatchObject({ state: 'unknown', current: null });
  });

  it('split parts on mixed bases report the WORST state and every distinct earlier base', () => {
    const { repo, caller, base } = divergedRepo();
    const clearThenCurrent = cachedBaseState(repo, [base, caller, caller], ['untouched.ts'], {});
    expect(clearThenCurrent).toMatchObject({ state: 'moved-clear', judged: [caller] });
    expect(cachedBaseState(repo, [caller, base], ['moved.ts'], {}).state).toBe('moved-overlap');
    expect(cachedBaseState(repo, [caller, null], ['moved.ts'], {}).state).toBe('unknown');
  });

  it('caps the named paths and counts the rest', () => {
    const { repo, caller } = divergedRepo();
    const verdict = cachedBaseState(repo, [caller], ['moved.ts'], {});
    const many = { ...verdict, overlapping: Array.from({ length: 13 }, (_, i) => `f${i}.ts`) };
    expect(cachedPassLine('x', many)).toContain('13 reviewed path(s) changed between them: f0.ts');
    expect(cachedPassLine('x', many)).toContain('f9.ts …and 3 more;');
  });
});

describe('base provenance line scoped to the reviewers that ran (sc-3468)', () => {
  beforeEach(() => resetReviewBaseContext());
  afterEach(() => {
    resetReviewBaseContext();
    cleanupReviewFixtures();
  });

  it('claims no review of this base when every verdict was served from cache', () => {
    const { repo, base } = divergedRepo();
    const [first] = baseProvenanceLines(repo, ['moved.ts'], {}, { fresh: 0, cached: 3 });
    expect(first).not.toContain('reviewed against');
    expect(first).toBe(
      `guard-review: no reviewer ran this attempt — this run's base is ${base.slice(0, 12)} ` +
        '(local HEAD), and each cached PASS above names the base it was judged against.',
    );
  });

  it('scopes the claim to the reviewers that ran when some were served from cache', () => {
    const { repo, base } = divergedRepo();
    const [first] = baseProvenanceLines(repo, ['moved.ts'], {}, { fresh: 2, cached: 1 });
    expect(first).toContain(`reviewed against ${base.slice(0, 12)} (local HEAD)`);
    expect(first).toContain(
      'Only the reviewers run this attempt; each cached PASS above names its own base.',
    );
  });

  it('an all-fresh run keeps the historical line', () => {
    const { repo, base } = divergedRepo();
    const [first] = baseProvenanceLines(repo, ['moved.ts'], {}, { fresh: 3, cached: 0 });
    expect(first).toBe(
      `guard-review: reviewed against ${base.slice(0, 12)} (local HEAD) — findings below name lines in THAT tree.`,
    );
  });
});
