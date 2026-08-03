import { describe, expect, it } from 'vitest';
import {
  CORRECTNESS_LENSES,
  DEFAULT_LENS_GROUPS,
  deriveLensReviewer,
  lensGroupId,
  mergeLensCaptures,
  planReviewWork,
  resolveLensGroups,
} from '../lens/split.mts';
import { cacheKey, REVIEWERS, wrapPrompt } from '../reviewers.mts';

const correctness = REVIEWERS.find((r) => r.name === 'correctness-reviewer');
if (!correctness?.cmds || !correctness.stateFile || !correctness.skill)
  throw new Error('correctness-reviewer must be a checklist reviewer for these tests');
const base = correctness as typeof correctness & {
  cmds: { gen: string; check: string; fin?: string };
  stateFile: string;
  skill: string;
};

describe('resolveLensGroups', () => {
  it('is OFF by default and for the explicit off spellings', () => {
    for (const raw of [undefined, '', '0', 'off', 'OFF']) expect(resolveLensGroups(raw)).toBeNull();
  });

  it('turns on the two-group default shape', () => {
    for (const raw of ['1', 'on']) expect(resolveLensGroups(raw)).toEqual(DEFAULT_LENS_GROUPS);
  });

  it('the default groups partition all four lenses, two and two', () => {
    const flat = DEFAULT_LENS_GROUPS.flat();
    expect(DEFAULT_LENS_GROUPS).toHaveLength(2);
    expect(new Set(flat)).toEqual(new Set(CORRECTNESS_LENSES));
    for (const g of DEFAULT_LENS_GROUPS) expect(g).toHaveLength(2);
  });

  it('accepts an explicit partition, including a four-way split', () => {
    const four = CORRECTNESS_LENSES.join('|');
    expect(resolveLensGroups(four)?.map((g) => [...g])).toEqual(CORRECTNESS_LENSES.map((l) => [l]));
  });

  // A lens silently dropping out of a BLOCKING gate is the exact blindness this reviewer exists
  // to prevent, so an incomplete spec must refuse rather than review three of four classes.
  it('refuses a spec that omits a lens', () => {
    expect(() => resolveLensGroups('state-transitions|concurrency-races')).toThrow(
      /every lens must appear exactly once/,
    );
  });

  it('refuses a duplicated lens and an unknown lens', () => {
    expect(() =>
      resolveLensGroups(
        'state-transitions,state-transitions|concurrency-races|writer-reader-contracts|error-and-edge-classification',
      ),
    ).toThrow(/only one group/);
    expect(() => resolveLensGroups('nope|state-transitions')).toThrow(/unknown lens/);
  });
});

describe('deriveLensReviewer', () => {
  const group = ['writer-reader-contracts', 'error-and-edge-classification'];

  it('scopes the state file and every checklist command to the group', () => {
    const d = deriveLensReviewer(base, group);
    const arg = '--lens error-and-edge-classification,writer-reader-contracts';
    expect(d.stateFile).toBe(
      '.claude/.correctness-review-error-and-edge-classification+writer-reader-contracts.json',
    );
    expect(d.cmds.gen).toBe(`generate ${arg}`);
    expect(d.cmds.check).toBe(`check-item ${arg}`);
    // finalize MUST carry the group too: the checklist script resolves its state file from argv at
    // dispatch, so a bare `finalize` would finalize the un-lensed default file instead.
    expect(d.cmds.fin).toBe(`finalize ${arg}`);
  });

  it('keeps the reviewer NAME, so waiver fingerprints and telemetry stay keyed as before', () => {
    expect(deriveLensReviewer(base, group).name).toBe('correctness-reviewer');
  });

  it('gives a group one id regardless of the order its lenses were written', () => {
    expect(lensGroupId(['b', 'a'])).toBe(lensGroupId(['a', 'b']));
    expect(deriveLensReviewer(base, ['b', 'a'] as string[]).stateFile).toBe(
      deriveLensReviewer(base, ['a', 'b'] as string[]).stateFile,
    );
  });

  it('leaves the undivided reviewer untouched', () => {
    expect(base.stateFile).toBe('.claude/.correctness-review.json');
    expect(base.cmds.gen).toBe('generate');
  });
});

// The break this test exists for: with an assetRoot, wrapPrompt used to hand command authority to
// the brief — and agents/correctness-reviewer.md spells out bare `generate`/`check-item`/`finalize`
// with no --lens. Every group judge would then write the SAME un-lensed state file, clobber the
// others, and leave each group-scoped artifact missing → contract retry → error → exit 1.
describe('wrapPrompt under a lens group', () => {
  const group = ['concurrency-races', 'state-transitions'];
  const files = ['src/a.ts'];

  it('spells the group-scoped commands out even in review mode (assetRoot set)', () => {
    const p = wrapPrompt('# brief', deriveLensReviewer(base, group), files, '.devkit/assets');
    expect(p).toContain('generate --lens concurrency-races,state-transitions');
    expect(p).toContain('check-item --lens concurrency-races,state-transitions');
    expect(p).toContain('finalize --lens concurrency-races,state-transitions');
    expect(p).not.toContain('The reviewer brief owns checklist enumeration');
  });

  it('still defers to the brief in review mode when NOT split (prompt bytes unchanged)', () => {
    const p = wrapPrompt('# brief', base, files, '.devkit/assets');
    expect(p).toContain('The reviewer brief owns checklist enumeration');
    expect(p).not.toContain('--lens');
  });

  it('renders the explicit contract on the commit path either way', () => {
    expect(wrapPrompt('# brief', base, files)).toContain('MANDATORY CHECKLIST WORKFLOW');
    expect(wrapPrompt('# brief', deriveLensReviewer(base, group), files)).toContain(
      'finalize --lens concurrency-races,state-transitions',
    );
  });
});

// The other break: the PASS cache key carries an EMPTY identity salt outside review mode, so
// without the group in the key a monolith PASS would be served to the split arm (and vice versa on
// rollback) for any repeated diff — silently contaminating the very A/B the flag exists to enable.
describe('cache identity across the split flag', () => {
  const diff = 'diff --git a/src/a.ts b/src/a.ts\n+const x = 1;\n';

  it('separates monolith from each group for identical diff bytes', () => {
    const mono = cacheKey('correctness-reviewer', diff, '');
    const keys = DEFAULT_LENS_GROUPS.map((g) =>
      cacheKey('correctness-reviewer', diff, `|split:${lensGroupId(g)}`),
    );
    expect(new Set([mono, ...keys]).size).toBe(1 + keys.length);
  });

  it('is stable for the same group across runs', () => {
    const g = DEFAULT_LENS_GROUPS[0];
    expect(cacheKey('correctness-reviewer', diff, `|split:${lensGroupId(g)}`)).toBe(
      cacheKey('correctness-reviewer', diff, `|split:${lensGroupId([...g].reverse())}`),
    );
  });
});

// Both of these were caught by the repo's OWN correctness gate reviewing this feature.
describe('planReviewWork — the two defects the gate caught', () => {
  const sel = { reviewer: base, files: ['src/a.ts'] };
  const key = (n: string, d: string, salt: string) => `${n}|${d}|${salt}`;
  const groups = DEFAULT_LENS_GROUPS;

  // hashReviewerIdentity hashes JSON.stringify(reviewer), and the identity salt is pre-computed per
  // reviewer NAME from the undivided table entry — so verifying a derived clone against it always
  // mismatches and would flip EVERY split PASS to `error` under DEVKIT_RUN_MODE=review.
  it('every task carries the UNDIVIDED selection for asset-identity verification', () => {
    const plan = planReviewWork([sel], ['d'], {}, new Map(), key, groups);
    expect(plan.tasks).toHaveLength(2);
    for (const t of plan.tasks) {
      expect(t.base.reviewer).toBe(base); // the table entry, not the clone
      expect(t.sel.reviewer).not.toBe(base); // the clone is what actually runs
      expect(t.sel.reviewer.lens).toBeDefined();
    }
  });

  it('the un-split path still carries its own selection as base', () => {
    const plan = planReviewWork([sel], ['d'], {}, new Map(), key, null);
    expect(plan.tasks[0].base).toBe(plan.tasks[0].sel);
  });

  // On the kill-then-resume path one group's PASS is cached while its sibling re-runs live. Without
  // re-seeding, the merged review_result silently omits the cached group's items — violating the
  // module's own "one merged row carrying the FULL per-lens vector" invariant.
  it('re-seeds a cached group so a resumed run still emits the full per-lens vector', () => {
    const cachedKey = key('correctness-reviewer', 'd', `|split:${lensGroupId(groups[0])}`);
    const cache = {
      [cachedKey]: { at: 'now', model: 'sonnet', items: [{ name: 'concurrency-races' }] },
    };
    const plan = planReviewWork([sel], ['d'], cache, new Map(), key, groups);
    expect(plan.tasks).toHaveLength(1); // only the uncached group re-runs
    const held = plan.splitParts.get('correctness-reviewer');
    expect(held).toHaveLength(1);
    expect(held?.[0].res.items).toEqual([{ name: 'concurrency-races' }]);
    expect(held?.[0].res.status).toBe('pass');
  });

  it('a fully cached split reviewer reports one cache hit and seeds nothing', () => {
    const cache = Object.fromEntries(
      groups.map((g) => [
        key('correctness-reviewer', 'd', `|split:${lensGroupId(g)}`),
        { at: 'n' },
      ]),
    );
    const plan = planReviewWork([sel], ['d'], cache, new Map(), key, groups);
    expect(plan.tasks).toHaveLength(0);
    expect(plan.fullyCached).toHaveLength(1);
    expect(plan.splitParts.size).toBe(0);
  });
});

// The third defect the gate caught: deriveLensReviewer keeps the reviewer NAME, so both groups'
// judge passes land in the bench capture under the SAME label. `.find()` scored only the first,
// silently dropping the other group's verdict and artifact from the exact A/B metrics this pilot
// exists to produce.
describe('mergeLensCaptures', () => {
  const pass = { label: 'review:correctness-reviewer', out: 'VERDICT: PASS — clean', ms: 10 };
  const fail = { label: 'review:correctness-reviewer', out: 'VERDICT: FAIL — a race', ms: 20 };

  it('passes 0 or 1 entries straight through (un-split path unchanged)', () => {
    expect(mergeLensCaptures([])).toBeUndefined();
    expect(mergeLensCaptures([pass])).toBe(pass);
  });

  it('takes the FAILING verdict whichever group produced it', () => {
    expect(mergeLensCaptures([pass, fail])?.out).toContain('FAIL');
    expect(mergeLensCaptures([fail, pass])?.out).toContain('FAIL');
  });

  it('unions the groups’ checklist items so right-reason attribution sees every failed lens', () => {
    const merged = mergeLensCaptures([
      { ...pass, snapshot: { items: [{ name: 'concurrency-races', status: 'pass' }] } },
      { ...fail, snapshot: { items: [{ name: 'writer-reader-contracts', status: 'fail' }] } },
    ]);
    expect(merged?.snapshot).toEqual({
      items: [
        { name: 'concurrency-races', status: 'pass' },
        { name: 'writer-reader-contracts', status: 'fail' },
      ],
    });
    expect(merged?.ms).toBe(30); // total judge time, the honest cost of the split
  });

  it('is synthetic only when every group was', () => {
    expect(mergeLensCaptures([{ ...pass, synthetic: true }, fail])?.synthetic).toBe(false);
    expect(
      mergeLensCaptures([
        { ...pass, synthetic: true },
        { ...fail, synthetic: true },
      ])?.synthetic,
    ).toBe(true);
  });
});
