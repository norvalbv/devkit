import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  brokenLabels,
  leakJaccard,
  lintRecallCases,
  staleLabels,
  storeHash,
} from '../eval/recall/bench.mts';
import {
  abstained,
  type Envelope,
  type RecallCase,
  scoreCase,
  summarize,
} from '../eval/recall/scoring.mts';
import { corpusIdf, orderQualifiers } from '../recall/retrieval.mts';

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
  // Hoisted (not inlined into `cs()`) so a case can vary ONE field off the same baseline without
  // reaching back through the optional `currentState` of a freshly built case.
  const CURRENT_STATE: NonNullable<RecallCase['currentState']> = {
    axis: 'hooks',
    liveId: 'target:2026-06-17',
    staleId: 'target:2026-06-08',
    mustSurface: ['nothing executable to bridge'],
    mustNotAssert: ['hooks FOLLOW the user'],
  };
  const cs = (): RecallCase => ({
    id: 'c1',
    q: 'q',
    type: 'CURRENT_STATE',
    gold: ['hooks'],
    currentState: { ...CURRENT_STATE },
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

  it('surfacing the qualifiers makes a stale claim non-misleading, WITHOUT any marker word', () => {
    // The structural rule that replaced the keyword window. Real qualifiers do not say
    // "superseded" — the seed corpus's own notes say "PARKED" / "still blocked" / "unscheduled" —
    // so a vocabulary test would score a correct, fully-qualified answer as a stale assertion.
    const ok = scoreCase(
      cs(),
      env(
        ['hooks'],
        [
          {
            liveRulingId: 'target:2026-06-17',
            ruling: 'hooks FOLLOW the user via deliver+enforce',
            qualifiedBy: [
              {
                id: 'note:2026-06-19',
                date: '2026-06-19',
                text: 'PARKED: nothing executable to bridge',
              },
            ],
          },
        ],
      ),
    );
    expect(ok.sfer).toBe(false);
    expect(ok.csa).toBe(true); // mustSurface is satisfied by the qualifier text
  });

  it('an UNRELATED qualifier does not suppress SFER — the check keys on the live content', () => {
    // Regression guard for a metric that could not fail: gating on "does this axis have any notes"
    // meant one irrelevant note hid a genuinely stale ruling. Real axes carry ~20 unrelated notes,
    // so SFER would have read 0 forever while regressions passed the gate.
    const bad = scoreCase(
      cs(),
      env(
        ['hooks'],
        [
          {
            liveRulingId: 'target:2026-06-17',
            ruling: 'hooks FOLLOW the user via deliver+enforce',
            qualifiedBy: [
              {
                id: 'note:2026-06-20',
                date: '2026-06-20',
                text: 'unrelated: renamed a settings panel',
              },
            ],
          },
        ],
      ),
    );
    expect(bad.sfer).toBe(true); // the live content was never surfaced
    expect(bad.csa).toBe(false);
  });

  it('an EMPTY mustSurface cannot silently disable SFER (vacuous [].every)', () => {
    // `[].every()` is true, which would claim the live content surfaced and switch staleness off.
    // An empty list is evidence of nothing, so it must read as NOT surfaced.
    const empty = { ...cs(), currentState: { ...CURRENT_STATE, mustSurface: [] } };
    const s = scoreCase(
      empty,
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
    expect(s.sfer).toBe(true);
    expect(s.csa).toBe(false);
  });

  it('a note QUOTING the stale ruling back does not itself trigger SFER', () => {
    // Real notes quote the ruling they contradict: "NOT a reversal of Target #2's 'hooks now
    // FOLLOW'". Scanning the composite for the claim would fail an answer that correctly surfaced
    // the correcting note — the claim belongs to the ruling, so only the ruling is scanned.
    const ok = scoreCase(
      cs(),
      env(
        ['hooks'],
        [
          {
            liveRulingId: 'target:2026-06-17',
            ruling: 'delivery is parked pending an executable bridge',
            qualifiedBy: [
              {
                id: 'note:2026-06-19',
                date: '2026-06-19',
                text: 'NOT a reversal of the earlier hooks FOLLOW the user ruling — nothing executable to bridge',
              },
            ],
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
    // The lint rejects the vacuous-truth shapes outright, so a case can never quietly score nothing.
    const hollow = {
      id: 'f',
      q: 'q',
      type: 'CURRENT_STATE',
      gold: ['x'],
      currentState: {
        axis: 'x',
        liveId: 'target:1',
        staleId: 'target:0',
        mustSurface: [],
        mustNotAssert: [],
      },
    };
    expect(lintRecallCases([hollow])).toEqual([
      'row 1 (f): currentState.mustSurface must be non-empty (an empty list disables SFER)',
      'row 1 (f): currentState.mustNotAssert must be non-empty (an empty list disables SFER)',
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

describe('staleLabels (the label-rot tripwire)', () => {
  it('flags cases labelled against a different corpus, and unstamped ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-drift-'));
    try {
      writeFileSync(join(dir, 'a.md'), 'original');
      const h = storeHash(dir);
      const cases = [
        { id: 'fresh', q: 'q', type: 'SINGLE', gold: ['a'], storeHash: h },
        { id: 'unstamped', q: 'q', type: 'SINGLE', gold: ['a'] },
      ];
      expect(staleLabels(dir, cases).map((d) => d.id)).toEqual(['unstamped']);

      // Editing the corpus rots every label that was validated against the old bytes. An ABSTAIN
      // case is the dangerous one: it stays syntactically valid and silently starts scoring a
      // correct retriever as broken the day someone records a ruling on its topic.
      writeFileSync(join(dir, 'a.md'), 'a ruling was added here');
      expect(staleLabels(dir, cases).map((d) => d.id)).toEqual(['fresh', 'unstamped']);
      expect(staleLabels(dir, cases)[0]).toMatchObject({ was: h, now: storeHash(dir) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('orderQualifiers (shared by every retrieval tier)', () => {
  const note = (date: string, text: string) => ({
    id: `note:${date}`,
    kind: 'note' as const,
    date,
    text,
  });

  it('puts the query-relevant note first even when it is far from the newest', () => {
    // The real shape: the note that falsifies a ruling is 4th of 20 by date, and callers show 3.
    const quals = [
      note('2026-06-08', 'follow-up restatus after the re-target'),
      note('2026-06-09', 'go-live: flipped the delivery flag on'),
      note('2026-06-09', 'hooks-follow PARKED post-MVP, nothing executable to bridge'),
      note('2026-07-25', 'isolated config dir staged only skills and agents'),
    ];
    const idf = corpusIdf([
      {
        slug: 'a',
        ruling: '',
        why: '',
        updated: '',
        liveRulingId: null,
        qualifiers: [],
        entries: quals,
      },
      {
        slug: 'b',
        ruling: '',
        why: '',
        updated: '',
        liveRulingId: null,
        qualifiers: [],
        entries: [
          note('2026-01-01', 'the user after each of the follow up items across the board'),
        ],
      },
    ]);
    const top = orderQualifiers('do hooks follow the user across tools', quals, idf);
    expect(top[0].text).toContain('hooks-follow PARKED');
  });

  it('falls back to newest-first when nothing matches, and never mutates the input', () => {
    const quals = [note('2026-01-01', 'alpha'), note('2026-05-05', 'beta')];
    const copy = [...quals];
    expect(
      orderQualifiers('unrelated kubernetes helm', quals, new Map()).map((q) => q.date),
    ).toEqual(['2026-05-05', '2026-01-01']);
    expect(quals).toEqual(copy);
  });

  it('length-normalises so a long rambling note cannot win on bulk alone', () => {
    const terse = note('2026-01-01', 'retry budget exhausted');
    const padded = note('2026-02-02', `retry ${'filler words here '.repeat(40)}`);
    const idf2 = new Map([
      ['retry', 1],
      ['budget', 2],
      ['filler', 0.1],
      ['words', 0.1],
      ['here', 0.1],
    ]);
    expect(orderQualifiers('retry budget', [padded, terse], idf2)[0].date).toBe('2026-01-01');
  });
});

describe('brokenLabels (labels must still describe the corpus)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-labels-'));
  writeFileSync(
    join(dir, 'axis.md'),
    '# axis\n\n## Target · 2026-01-01 — r\n\n**Ruling:** the guarantee holds\n- 2026-02-02 — PARKED, it does not\n',
  );

  it('passes when every referenced slug and substring is present', () => {
    expect(
      brokenLabels(dir, [
        {
          id: 'ok',
          q: 'q',
          type: 'CURRENT_STATE',
          gold: ['axis'],
          currentState: {
            axis: 'axis',
            liveId: 'target:2026-01-01',
            staleId: 'target:2026-01-01',
            mustSurface: ['PARKED'],
            mustNotAssert: ['the guarantee holds'],
          },
        },
      ]),
    ).toEqual([]);
  });

  it('catches every way a label stops describing the corpus', () => {
    // The hash tripwire only says the corpus MOVED; re-stamping it silences that. These checks are
    // what say the labels still mean something — a rotted one scores a CORRECT retriever as broken.
    const errors = brokenLabels(dir, [
      {
        id: 'rotted',
        q: 'q',
        type: 'CURRENT_STATE',
        gold: ['vanished-axis'],
        currentState: {
          axis: 'axis',
          liveId: 'target:1999-01-01',
          staleId: 'x',
          mustSurface: ['TEXT THAT IS GONE'],
          mustNotAssert: ['ALSO GONE'],
        },
      },
    ]);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain('vanished-axis');
    expect(errors.some((e) => e.includes('mustSurface'))).toBe(true);
    expect(errors.some((e) => e.includes('mustNotAssert'))).toBe(true);
    expect(errors.some((e) => e.includes('liveId'))).toBe(true);
  });
});

// ─── Degradation warning (regression: sc-1236 correctness review) ─────────────────
// The "embedding model unavailable — ranking LEXICALLY ONLY" warning fired whenever embed() returned
// null, but null ALSO means "deliberately switched off" (DECISIONS_NO_EMBED), which every test and
// the default CI bench tier set. So the expected path accused the machine of a broken install and
// told the reader to pull a model they had disabled — noise, which is how a real warning gets ignored.
describe('dense-tier degradation warning', () => {
  const load = async () => await import('../recall/embeddings.mts');

  afterEach(() => {
    delete process.env.DECISIONS_NO_EMBED;
    vi.restoreAllMocks();
  });

  it('reports a deliberate opt-out as disabled, NOT as unavailable', async () => {
    const { embedDisabled, embed } = await load();
    process.env.DECISIONS_NO_EMBED = '1';
    expect(embedDisabled()).toBe(true);
    // embed() still returns null — the two situations are indistinguishable at THAT return value,
    // which is exactly why the warning must consult embedDisabled() rather than the null.
    await expect(embed('anything')).resolves.toBeNull();
  });

  it('reports an absent opt-out as not-disabled, so a real outage still warns', async () => {
    const { embedDisabled } = await load();
    delete process.env.DECISIONS_NO_EMBED;
    expect(embedDisabled()).toBe(false);
  });
});
