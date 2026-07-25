import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { leakJaccard, lintRecallCases, storeHash } from '../eval/recall/bench.mts';
import {
  abstained,
  type Envelope,
  type RecallCase,
  scoreCase,
  summarize,
} from '../eval/recall/scoring.mts';

const env = (slugs: string[], over: Partial<Envelope['rows'][number]>[] = []): Envelope => ({
  state: slugs.length ? 'RULED' : 'NO_RULING',
  rows: slugs.map((slug, i) => ({
    rank: i + 1,
    slug,
    score: 10 - i,
    liveRulingId: `target:2026-01-0${i + 1}`,
    ruling: `${slug} ruling text`,
    ...over[i],
  })),
});

const single = (over: Partial<RecallCase> = {}): RecallCase => ({
  id: 's1',
  q: 'q',
  type: 'SINGLE',
  gold: ['wanted'],
  ...over,
});

describe('abstained', () => {
  it('treats an empty row set as an abstain WHATEVER state claims', () => {
    // Keying on state alone would let a retriever dodge the false-answer metric by returning
    // RULED with no rows. What the caller actually receives is what gets scored.
    expect(abstained({ state: 'RULED', rows: [] })).toBe(true);
    expect(abstained(env(['a']))).toBe(false);
  });
});

describe('scoreCase — SINGLE', () => {
  it('HIT records the gold rank; rank 1 is not buried', () => {
    const s = scoreCase(single(), env(['wanted', 'other']));
    expect(s.outcome).toBe('HIT');
    expect(s.goldRank).toBe(1);
    expect(s.buriedByRank).toBe(false);
  });

  it('gold below rank 1 is buried-by-rank', () => {
    const s = scoreCase(single(), env(['noise', 'wanted']));
    expect(s).toMatchObject({ outcome: 'HIT', goldRank: 2, buriedByRank: true });
  });

  it('a labelled distractor outranking gold is buried-by-distractor, counted separately', () => {
    const s = scoreCase(single({ distractors: ['decoy'] }), env(['decoy', 'wanted']));
    expect(s.buriedByRank).toBe(true);
    expect(s.buriedByDistractor).toBe(true);
    const clean = scoreCase(single({ distractors: ['decoy'] }), env(['wanted', 'decoy']));
    expect(clean.buriedByDistractor).toBe(false);
  });

  it('MISS when gold is absent — and it is NOT counted as un-buried', () => {
    const s = scoreCase(single(), env(['a', 'b']));
    expect(s.outcome).toBe('MISS');
    expect(s.goldRank).toBeNull();
    // summarize() excludes it from the buried denominator; see the aggregation test below.
  });
});

describe('scoreCase — abstention', () => {
  it('ABSTAIN + abstained is correct; ABSTAIN + rows is a false answer', () => {
    const c: RecallCase = { id: 'a1', q: 'q', type: 'ABSTAIN', gold: [] };
    expect(scoreCase(c, env([])).outcome).toBe('ABSTAINED_CORRECTLY');
    expect(scoreCase(c, env(['anything'])).outcome).toBe('FALSE_ANSWER');
  });

  it('an answerable case that abstains is a FALSE_ABSTAIN — never a safe outcome', () => {
    expect(scoreCase(single(), env([])).outcome).toBe('FALSE_ABSTAIN');
  });

  it('a null envelope (CLI failed / unparseable) is ERROR, not a miss', () => {
    expect(scoreCase(single(), null).outcome).toBe('ERROR');
  });
});

describe('scoreCase — MULTI', () => {
  const multi = (): RecallCase => ({
    id: 'm1',
    q: 'q',
    type: 'MULTI',
    gold: ['a', 'b', 'c', 'd'],
    goldRequired: ['a', 'b', 'c', 'd'],
  });

  it('partial recall is a fraction of REQUIRED; set recall is all-or-nothing', () => {
    const some = scoreCase(multi(), env(['a', 'b', 'x']));
    expect(some.partialRecall).toBeCloseTo(0.5);
    expect(some.setRecall).toBe(false);
    const all = scoreCase(multi(), env(['a', 'b', 'c', 'd']));
    expect(all.partialRecall).toBe(1);
    expect(all.setRecall).toBe(true);
  });

  it('a MULTI case with |G| > k can never set-recall — the honest ceiling, not a bug', () => {
    const s = scoreCase(multi(), env(['a', 'b', 'c'])); // k=3 < |G|=4
    expect(s.setRecall).toBe(false);
    expect(s.partialRecall).toBeCloseTo(0.75);
  });
});

describe('scoreCase — CURRENT_STATE', () => {
  const cs = (): RecallCase => ({
    id: 'c1',
    q: 'q',
    type: 'CURRENT_STATE',
    gold: ['hooks'],
    currentState: {
      axis: 'hooks',
      liveId: 'target:2026-06-17',
      staleId: 'target:2026-06-08',
      mustSurface: ['nothing executable to bridge'],
      mustNotAssert: ['hooks FOLLOW the user'],
    },
  });

  it('CSA needs all three: right axis, LIVE block, live content without an unqualified stale claim', () => {
    const good = scoreCase(
      cs(),
      env(
        ['hooks'],
        [
          {
            liveRulingId: 'target:2026-06-17',
            ruling: 'there is nothing executable to bridge yet',
          },
        ],
      ),
    );
    expect(good.csa).toBe(true);
    expect(good.sfer).toBe(false);
  });

  it('returning the STALE block fails CSA even when the wording looks fine', () => {
    const stale = scoreCase(
      cs(),
      env(
        ['hooks'],
        [{ liveRulingId: 'target:2026-06-08', ruling: 'nothing executable to bridge' }],
      ),
    );
    expect(stale.csa).toBe(false); // structural check (ii), not a wording judgement
  });

  it('SFER fires when the stale ruling is asserted with no supersession marker nearby', () => {
    const bad = scoreCase(
      cs(),
      env(
        ['hooks'],
        [
          {
            liveRulingId: 'target:2026-06-17',
            ruling: 'hooks FOLLOW the user via deliver+enforce',
          },
        ],
      ),
    );
    expect(bad.sfer).toBe(true);
    expect(bad.csa).toBe(false);
  });

  it('the same claim QUALIFIED by a nearby supersession marker does not count as stale', () => {
    const ok = scoreCase(
      cs(),
      env(
        ['hooks'],
        [
          {
            liveRulingId: 'target:2026-06-17',
            ruling:
              'the earlier ruling that hooks FOLLOW the user is superseded — nothing executable to bridge',
          },
        ],
      ),
    );
    expect(ok.sfer).toBe(false);
    expect(ok.csa).toBe(true);
  });

  it('axis not returned at all is a Containment miss, not a staleness failure', () => {
    const s = scoreCase(cs(), env(['unrelated']));
    expect(s.outcome).toBe('MISS');
    expect(s.sfer).toBe(false); // it asserted nothing stale — it asserted nothing
  });
});

describe('summarize', () => {
  it('keeps the five denominators separate and excludes ERROR everywhere', () => {
    const scored = [
      scoreCase(single({ id: 'hit' }), env(['wanted'])),
      scoreCase(single({ id: 'miss' }), env(['nope'])),
      scoreCase(single({ id: 'buried' }), env(['noise', 'wanted'])),
      scoreCase(single({ id: 'err' }), null),
      scoreCase({ id: 'ab', q: 'q', type: 'ABSTAIN', gold: [] }, env(['noise'])),
      scoreCase({ id: 'ab2', q: 'q', type: 'ABSTAIN', gold: [] }, env([])),
      scoreCase(single({ id: 'fa' }), env([])),
    ];
    const sum = summarize(scored);

    expect(sum.errors).toBe(1);
    // 4 answerable SINGLE rows survive (hit, miss, buried, fa) — the ERROR row is gone entirely.
    expect(sum.containment.SINGLE).toEqual({ hit: 2, total: 4 });
    // Buried denominator is only the rows that CONTAINED gold — miss and false-abstain excluded.
    expect(sum.buried).toEqual({ rank: 1, distractor: 0, total: 2 });
    expect(sum.abstention.fanr).toEqual({ bad: 1, total: 2 });
    // The false abstain shows up in BOTH tables: as a FAR event and as a containment miss.
    expect(sum.abstention.far).toEqual({ bad: 1, total: 4 });
    expect(sum.rows.err).toBeUndefined();
  });

  it('partial recall is MACRO-averaged so a big case cannot dominate a small one', () => {
    const big: RecallCase = {
      id: 'big',
      q: 'q',
      type: 'MULTI',
      gold: [],
      goldRequired: ['a', 'b', 'c', 'd'],
    };
    const small: RecallCase = {
      id: 'small',
      q: 'q',
      type: 'MULTI',
      gold: [],
      goldRequired: ['x', 'y'],
    };
    const sum = summarize([
      scoreCase(big, env(['a', 'b', 'c', 'd'])), // 1.0
      scoreCase(small, env(['x'])), // 0.5
    ]);
    // Macro: (1.0 + 0.5) / 2 = 0.75. Micro-pooling would give 5/6 = 0.83 and hide the small miss.
    expect(sum.multi.partialRecall).toBeCloseTo(0.75);
    expect(sum.multi.setRecall).toEqual({ hit: 1, total: 2 });
  });
});

describe('bench helpers', () => {
  it('leakJaccard flags a question that rewrites its own ruling', () => {
    const ruling = '**Ruling:** retries draw from a per-caller token budget and fail fast';
    // An engineer's phrasing shares almost nothing with the ruling's vocabulary.
    expect(
      leakJaccard('can I keep hammering a flaky service until it works?', ruling),
    ).toBeLessThan(0.2);
    // A paraphrase of the ruling is the leaky case the gate exists to reject.
    expect(
      leakJaccard('retries draw from a per-caller token budget and fail fast', ruling),
    ).toBeGreaterThan(0.5);
  });

  it('lintRecallCases enforces the gold/type contract in both directions', () => {
    expect(lintRecallCases([{ id: 'a', q: 'q', type: 'SINGLE', gold: ['x'] }])).toEqual([]);
    // An answerable case with no gold would otherwise be scored as a correct abstain — inverted.
    expect(lintRecallCases([{ id: 'b', q: 'q', type: 'SINGLE', gold: [] }])).toEqual([
      'row 1 (b): SINGLE needs gold',
    ]);
    expect(lintRecallCases([{ id: 'c', q: 'q', type: 'ABSTAIN', gold: ['x'] }])).toEqual([
      'row 1 (c): ABSTAIN must have empty gold',
    ]);
    expect(lintRecallCases([{ id: 'd', q: 'q', type: 'MULTI', gold: ['x'] }])).toEqual([
      'row 1 (d): MULTI needs goldRequired',
    ]);
    expect(lintRecallCases([{ id: 'e', q: 'q', type: 'CURRENT_STATE', gold: ['x'] }])).toEqual([
      'row 1 (e): CURRENT_STATE needs a currentState block',
    ]);
  });

  it('storeHash changes when the frozen corpus changes — the label-rot tripwire', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-corpus-'));
    try {
      writeFileSync(join(dir, 'a.md'), 'one');
      const before = storeHash(dir);
      writeFileSync(join(dir, 'a.md'), 'two');
      expect(storeHash(dir)).not.toBe(before);
      // Stable across calls with no change — it must not be time- or order-dependent.
      expect(storeHash(dir)).toBe(storeHash(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
