import { describe, expect, it } from 'vitest';
import {
  exitCodeFor,
  renderEditAdvisory,
  renderSessionBrief,
  renderShipNotice,
  renderStatus,
} from './render.mts';
import type { BaseDriftReport } from './types.mts';

function report(overrides: Partial<BaseDriftReport> = {}): BaseDriftReport {
  return {
    schema: 1,
    root: '/repo',
    commonDir: '/repo/.git',
    base: {
      kind: 'resolved',
      base: 'main',
      ref: 'refs/remotes/origin/main',
      source: 'main',
      sha: 'abc1234def',
    },
    freshness: 'fresh',
    ageMs: null,
    mergeBase: 'mb00000',
    behind: 2,
    moved: [{ path: 'a.mts', status: 'M' }],
    overlap: [
      {
        path: 'a.mts',
        status: 'M',
        matched: 'a.mts',
        commit: {
          sha: 'c'.repeat(40),
          short: 'ccccccc',
          date: '2026-08-30T00:00:00Z',
          subject: 'fix a',
        },
        rearm: 'deadbeefdeadbeef',
      },
    ],
    truncated: false,
    silent: null,
    ...overrides,
  };
}

const RENDERERS = [renderSessionBrief, renderEditAdvisory, renderShipNotice];

describe('silence rules', () => {
  it('every advisory renderer is EMPTY for an unresolvable base', () => {
    const unresolvable = report({
      base: { kind: 'unresolvable', reason: 'no-candidate' },
      silent: 'unresolvable',
    });
    for (const render of RENDERERS) expect(render(unresolvable)).toBe('');
  });

  it('every advisory renderer is EMPTY when nothing overlapped, however far behind the base is', () => {
    // The regression that keeps this from becoming a tuned-out permanently-red indicator: in a
    // shared parallel-agent checkout HEAD never advances, so `behind` only ever grows.
    const noOverlap = report({ behind: 400, overlap: [], silent: 'no-overlap' });
    for (const render of RENDERERS) expect(render(noOverlap)).toBe('');
  });

  it('renders the drift when there IS an overlap', () => {
    for (const render of RENDERERS) expect(render(report())).toContain('a.mts');
    expect(renderEditAdvisory(report())).toContain('ccccccc');
  });
});

describe('no advisory renderer states a blocking verdict it cannot compute', () => {
  // Absence, not wording: a positive pin has the same hole that let sc-2451 leave this stale.
  const VERDICT_CLAIM =
    /not blocked|never blocks?|does not block|will (abort|block|fail|conflict)|blocks this ship|surfaces at merge|merges these three-way/i;

  it('never tells the reader the ship is safe to proceed', () => {
    // sc-2664: an agent read "not blocked" over an abort that had already fired.
    for (const render of RENDERERS) expect(render(report())).not.toMatch(VERDICT_CLAIM);
  });

  it('never promises an abort either — two arms reach staging without ever conflicting', () => {
    // Whole-file staging (patch-anchor.sh) and shallow-clone degradation both reach staging
    // without conflicting, so a guaranteed-abort claim would be as false as "not blocked".
    for (const render of RENDERERS)
      expect(render(report({ behind: 40 }))).not.toMatch(VERDICT_CLAIM);
  });

  it('says where the verdict IS taken, so "advisory" is not read as "harmless"', () => {
    // Deleting it was the alternative, rejected: here silence reads as the reassuring value.
    expect(renderShipNotice(report())).toContain('staging');
  });

  it('keeps the one thing staging cannot catch: the clean-apply revert', () => {
    expect(renderShipNotice(report())).toContain('hand-edited');
  });

  it('holds on every DEGRADED path, not only the happy one', () => {
    // The guards above render only silent:null. Degraded paths return different prose entirely,
    // and renderStatus (`devkit base-status`) is a fifth surface — neither was ever guarded.
    const degraded = [
      report({ freshness: 'unknown' }),
      report({ moved: [], overlap: [], silent: 'undetermined' }),
      report({
        base: { kind: 'unresolvable', reason: 'fetch-failed', base: 'main' },
        freshness: 'unknown',
        moved: [],
        overlap: [],
        silent: 'unresolvable',
      }),
    ];
    for (const degradedReport of degraded)
      for (const render of [...RENDERERS, renderStatus])
        expect(render(degradedReport)).not.toMatch(VERDICT_CLAIM);
  });

  it('holds its shape on a production-sized report whose attribution was capped', () => {
    // The fixture models ONE overlap with a commit; sc-2297 hit 88 files, and past the
    // attribution cap entries arrive commit:null. Neither shape was ever rendered here.
    const many = report({
      truncated: true,
      overlap: Array.from({ length: 20 }, (_, i) => ({
        path: `pkg/f${i}.mts`,
        status: 'M',
        matched: `pkg/f${i}.mts`,
        commit:
          i < 3
            ? { sha: 'd'.repeat(40), short: 'ddddddd', date: '2026-09-01T00:00:00Z', subject: 'x' }
            : null,
        rearm: `rearm-${i}`,
      })),
    });
    const out = renderShipNotice(many);
    expect(out).toContain('20 shipped path(s)');
    expect(out).toContain('…and 12 more'); // MAX_LISTED is 8
    expect(out).toContain('pkg/f3.mts — changed on the base'); // capped: listed, but no sha to name
    expect(out).not.toContain('pkg/f9.mts'); // past the cap, folded into the "…and N more" tail
    expect(out).toContain('decided at staging');
    expect(out).toContain('hand-edited');
    expect(out).not.toMatch(VERDICT_CLAIM);
  });
});

describe('unknown freshness is spoken, never swallowed', () => {
  const unknown = report({ freshness: 'unknown', overlap: [], silent: 'no-overlap' });

  it('says so even when there is no drift to report', () => {
    // Silence is indistinguishable from "the base is fresh" — the exact inference behind sc-2297.
    for (const render of RENDERERS) expect(render(unknown)).toContain('UNKNOWN');
  });

  it('still says nothing when the base never resolved — there is no claim to qualify', () => {
    const nothing = report({
      base: { kind: 'unresolvable', reason: 'no-origin' },
      freshness: 'unknown',
      silent: 'unresolvable',
    });
    for (const render of RENDERERS) expect(render(nothing)).toBe('');
  });
});

describe('renderStatus', () => {
  it('always answers — a query must not be silent', () => {
    expect(renderStatus(report())).toContain('origin/main');
    expect(
      renderStatus(
        report({ base: { kind: 'unresolvable', reason: 'no-origin' }, silent: 'unresolvable' }),
      ),
    ).toContain('unresolvable');
  });
});

describe('exitCodeFor', () => {
  it('0 when the base is current and nothing overlapped', () => {
    expect(exitCodeFor(report({ overlap: [], silent: 'no-overlap' }))).toBe(0);
  });

  it('3 on drift', () => {
    expect(exitCodeFor(report())).toBe(3);
  });

  it('4 when the base could not be resolved', () => {
    expect(
      exitCodeFor(
        report({ base: { kind: 'unresolvable', reason: 'no-candidate' }, silent: 'unresolvable' }),
      ),
    ).toBe(4);
  });

  it('4 — NOT 0 — when the fetch failed but nothing overlapped', () => {
    // A green computed from refs of unknown age is the false confidence this feature exists to kill.
    expect(exitCodeFor(report({ freshness: 'unknown', overlap: [], silent: 'no-overlap' }))).toBe(
      4,
    );
  });

  it('0 for the is-ancestor early-out, where a null merge-base is CORRECT', () => {
    // The early-out returns before a merge-base is computed; null there is not "could not determine".
    expect(
      exitCodeFor(report({ mergeBase: null, moved: [], overlap: [], silent: 'no-drift' })),
    ).toBe(0);
  });

  it('4 when a merge-base genuinely could not be computed', () => {
    expect(exitCodeFor(report({ mergeBase: null, overlap: [], silent: 'no-overlap' }))).toBe(4);
  });
});

describe('an incomplete comparison is never a clean pass', () => {
  const undetermined = report({ moved: [], overlap: [], silent: 'undetermined' });

  it('exits 4, not 0', () => {
    // The base HAS moved and we could not find out what changed. A green here would be a pass
    // produced by a failure.
    expect(exitCodeFor(undetermined)).toBe(4);
  });

  it('says so on every surface rather than going quiet', () => {
    for (const render of RENDERERS) expect(render(undetermined)).toContain('UNKNOWN');
  });

  it('is reported by the status block too', () => {
    expect(renderStatus(undetermined)).toContain('UNKNOWN');
  });
});

describe('an unreachable origin is loud even when the base never resolved', () => {
  const unreachable = report({
    base: { kind: 'unresolvable', reason: 'fetch-failed', base: 'main' },
    freshness: 'unknown',
    moved: [],
    overlap: [],
    silent: 'unresolvable',
  });

  it('names the base and refuses to read as "unchanged"', () => {
    for (const render of RENDERERS) {
      expect(render(unreachable)).toContain('UNKNOWN');
      expect(render(unreachable)).toContain('origin/main');
    }
    expect(renderStatus(unreachable)).toContain('UNKNOWN');
  });

  it('still exits 4', () => {
    expect(exitCodeFor(unreachable)).toBe(4);
  });

  it('stays silent for reasons that ARE an answer, not a failure to get one', () => {
    // "origin has no such branch" and "this is not a repo" are conclusions; only an unreachable
    // remote leaves the question open, so only it is worth interrupting an agent for.
    for (const reason of ['no-origin', 'no-candidate', 'explicit-missing', 'not-a-repo'] as const) {
      const answered = report({
        base: { kind: 'unresolvable', reason },
        moved: [],
        overlap: [],
        silent: 'unresolvable',
      });
      for (const render of RENDERERS) expect(render(answered)).toBe('');
    }
  });
});

describe('a stale-ref ancestry result is not a clean pass', () => {
  it('exits 4 when the fetch failed, even though ancestry said no drift', () => {
    // is-ancestor answers the question only if the ref it measured is current. After a failed fetch
    // it is whatever was last cached, so a 0 here would be earned from a failure.
    const stale = report({
      freshness: 'unknown',
      mergeBase: null,
      moved: [],
      overlap: [],
      silent: 'undetermined',
    });
    expect(exitCodeFor(stale)).toBe(4);
    for (const render of RENDERERS) expect(render(stale)).toContain('UNKNOWN');
  });
});
