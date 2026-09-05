/** Row value as a computed property: every audit number is reproducible from a synthetic corpus, and
 * the two holdout rules (intended pairs are not leaks; assignment is per group) are locked here. */
import { describe, expect, it } from 'vitest';
import { auditSuite } from '../corpus/audit.mts';
import { holdoutFloorShortfalls, lintRows } from '../corpus.mts';
import { assignHoldout, unrelatedTwinProblems } from '../finalize.mts';
import {
  buildFailFixCandidate,
  findNextLensOutcome,
  findNextOutcome,
  LABEL_RULES,
} from '../mine-telemetry-lib.mts';
import { assertRepairFamilies, pairConsistency, summarize } from '../stats.mts';
import { jaccard, nearTwins, shingles, unrelatedTwins } from '../corpus/twins.mts';

const fixture = (text: string) => ({
  base: { 'src/a.ts': text },
  staged: { 'src/a.ts': `${text}\nconst z = 1;` },
});
const CODE =
  'export function f(a, b) { if (a === null) return b; const x = a.map((v) => v * 2); return x.concat(b); }';

describe('twins', () => {
  it('shingle Jaccard is 1 for identical text, 0 for unrelated text, and 0 when a side is too small to shingle', () => {
    expect(jaccard(shingles(CODE), shingles(CODE))).toBe(1);
    expect(jaccard(shingles('tiny'), shingles('tiny'))).toBe(0);
    expect(
      jaccard(shingles(CODE), shingles('completely different words here and there again')),
    ).toBe(0);
  });
  it('treats a transitive link (A–B–C) as related, same as grouping does', () => {
    const rows = [
      { id: 'a', expected: 'FAIL', repo: fixture(CODE) },
      { id: 'b', expected: 'PASS', variantOf: 'a', repo: fixture(`${CODE} // b`) },
      { id: 'c', expected: 'FAIL', variantOf: 'b', repo: fixture(`${CODE} // c`) },
    ];
    const ac = nearTwins(rows, { threshold: 0.5 }).find((t) => t.a === 'a' && t.b === 'c');
    expect(ac?.related).toBe(true);
  });
  it('flags an unrelated near-twin and exempts an intended minimal pair', () => {
    const rows = [
      { id: 'g1', expected: 'FAIL', caseId: 'c1', holdout: true, repo: fixture(CODE) },
      {
        id: 'd1',
        expected: 'PASS',
        caseId: 'c1',
        holdout: false,
        repo: fixture(`${CODE} // fixed`),
      },
      { id: 'g2', expected: 'FAIL', holdout: false, repo: fixture(`${CODE} // copy`) },
    ];
    const twins = nearTwins(rows, { threshold: 0.5 });
    const pair = twins.find((t) => t.a === 'g1' && t.b === 'd1');
    expect(pair?.related).toBe(true);
    expect(pair?.oppositeLabel).toBe(true);
    expect(pair?.straddlesHoldout).toBe(true);
    const leaky = unrelatedTwins(twins);
    expect(leaky.every((t) => t.a === 'g2' || t.b === 'g2')).toBe(true);
    expect(leaky.length).toBeGreaterThan(0);
  });
});

describe('pairConsistency', () => {
  const r = (
    id: string,
    caseId: string | undefined,
    expected: string,
    okFirst: boolean,
    okFinal = okFirst,
  ) => ({
    id,
    caseId,
    expected,
    firstVerdict: okFirst === (expected === 'FAIL') ? 'FAIL' : 'PASS',
    okFirst,
    okFinal,
    escalateLive: false,
    ms: { first: 0, escalate: 0 },
  });
  it('counts a pair only when both members are correct and reports singletons separately', () => {
    const results = [
      r('g1', 'c1', 'FAIL', true),
      r('d1', 'c1', 'PASS', true),
      r('g2', 'c2', 'FAIL', true),
      r('d2', 'c2', 'PASS', false),
      r('g3', undefined, 'FAIL', true),
      r('x1', 'c3', 'FAIL', true),
      r('x2', 'c3', 'FAIL', true),
    ];
    expect(pairConsistency(results)).toEqual({
      k: 1,
      n: 2,
      families: 2,
      familyK: 1,
      singletons: 1,
      malformedGroups: 1,
    });
  });
  it('groups a variantOf-only pair the same way holdout does, and leaves unlinked rows singletons', () => {
    const results = [
      { ...r('g1', undefined, 'FAIL', true), variantOf: undefined },
      { ...r('d1', undefined, 'PASS', true), variantOf: 'g1' },
      { ...r('g2', undefined, 'FAIL', false), variantOf: undefined },
      { ...r('d2', undefined, 'PASS', true), variantOf: 'g2' },
      { ...r('lone', undefined, 'FAIL', true), variantOf: 'not-in-this-run' },
      {
        expected: 'PASS',
        okFirst: true,
        okFinal: true,
        escalateLive: false,
        ms: { first: 0, escalate: 0 },
      },
    ];
    expect(pairConsistency(results)).toEqual({
      k: 1,
      n: 2,
      families: 2,
      familyK: 1,
      singletons: 2,
      malformedGroups: 0,
    });
  });
  it('counts explicit repairs within a shared family and exposes malformed links', () => {
    const rows = [
      r('g1', 'shared', 'FAIL', true),
      r('g2', 'shared', 'FAIL', true),
      { ...r('d1', 'shared', 'PASS', true), variantOf: 'g1' },
      { ...r('d2', 'shared', 'PASS', false), variantOf: 'g2' },
    ];
    expect(pairConsistency(rows)).toEqual({
      k: 1,
      n: 2,
      families: 1,
      familyK: 0,
      singletons: 0,
      malformedGroups: 0,
    });
    expect(
      pairConsistency([...rows.slice(0, 3), { ...rows[3], variantOf: 'd1' }]).malformedGroups,
    ).toBe(1);
    expect(() =>
      assertRepairFamilies([...rows.slice(0, 3), { ...rows[3], variantOf: 'd1' }]),
    ).toThrow(/malformed or unmatched/);
    expect(() => assertRepairFamilies(rows)).not.toThrow();
    expect(() => assertRepairFamilies([{ ...rows[0], variantOf: 'missing' }])).toThrow(
      /dangling variantOf missing/,
    );
    expect(() =>
      assertRepairFamilies([
        { ...rows[0], variantOf: 'd1' },
        { ...rows[2], variantOf: null },
      ]),
    ).toThrow(/malformed/);
    expect(() => assertRepairFamilies([{ ...rows[0], variantOf: 'd1' }, rows[2]])).toThrow(
      /malformed/,
    );
    expect(pairConsistency([{ ...rows[2], variantOf: 'missing' }]).malformedGroups).toBe(1);
  });
  it('uses okFinal under a cascade and lands in summarize beside the marginal', () => {
    const results = [r('g1', 'c1', 'FAIL', true, false), r('d1', 'c1', 'PASS', true, true)];
    expect(pairConsistency(results, { cascade: true }).k).toBe(0);
    expect(pairConsistency(results, { cascade: false }).k).toBe(1);
    const s = summarize(results, { cascade: false });
    expect(s.firstFailRecall).toEqual({ k: 1, n: 1 });
    expect(s.pairConsistency).toEqual({
      k: 1,
      n: 1,
      families: 1,
      familyK: 1,
      singletons: 0,
      malformedGroups: 0,
    });
  });
});

describe('assignHoldout by caseId group', () => {
  it('never splits a pair across the boundary and alternates gold groups', () => {
    const rows = [
      { id: 'b-gold', expected: 'FAIL', caseId: 'B' },
      { id: 'b-decoy', expected: 'PASS', caseId: 'B' },
      { id: 'a-gold', expected: 'FAIL', caseId: 'A' },
      { id: 'a-decoy', expected: 'PASS', caseId: 'A' },
      { id: 'lone-decoy', expected: 'PASS' },
      { id: 'lone-gold', expected: 'FAIL' },
    ];
    assignHoldout(rows);
    const by = Object.fromEntries(rows.map((r) => [r.id, r.holdout]));
    expect(by['a-gold']).toBe(by['a-decoy']);
    expect(by['b-gold']).toBe(by['b-decoy']);
    expect(by['a-gold']).not.toBe(by['b-gold']);
    expect(by['lone-decoy']).toBe(false);
    expect([by['a-gold'], by['b-gold'], by['lone-gold']].filter(Boolean)).toHaveLength(2);
  });
  it("a batch row linked to a row already in the corpus inherits that member's holdout", () => {
    const existing = [{ id: 'old-gold', expected: 'FAIL', holdout: true }];
    const batch = [
      { id: 'new-decoy', expected: 'PASS', variantOf: 'old-gold' },
      { id: 'other-gold', expected: 'FAIL' },
    ];
    assignHoldout(batch, existing);
    expect(batch[0].holdout).toBe(true);
    expect([true, false]).toContain(batch[1].holdout);
  });
  it('follows a variantOf link with no caseId, so the twin never straddles', () => {
    const rows = [
      { id: 'gold', expected: 'FAIL' },
      { id: 'decoy', expected: 'PASS', variantOf: 'gold' },
      { id: 'other', expected: 'FAIL' },
    ];
    assignHoldout(rows);
    expect(rows[0].holdout).toBe(rows[1].holdout);
    expect(rows[0].holdout).not.toBe(rows[2].holdout);
  });
});

describe('unrelatedTwinProblems (the --check / --append admission rule)', () => {
  const existing = [
    { id: 'g1', expected: 'FAIL', caseId: 'c1', holdout: true, repo: fixture(CODE) },
    { id: 'd1', expected: 'PASS', caseId: 'c1', holdout: false, repo: fixture(`${CODE} // fixed`) },
  ];
  it('refuses an unlinked copy of an existing row and admits the same row once it is linked', () => {
    const copy = { id: 'g2', expected: 'FAIL', repo: fixture(`${CODE} // copy`) };
    const refused = unrelatedTwinProblems([copy], existing);
    expect(
      refused.map((m) => m.match(/^g2: near-twin of existing row (\w+) /)?.[1]).sort(),
    ).toEqual(['d1', 'g1']);
    expect(unrelatedTwinProblems([{ ...copy, variantOf: 'g1' }], existing)).toEqual([]);
  });
  it('refuses two unlinked near-twins inside the same batch, naming the sibling as a batch row', () => {
    const batch = [
      { id: 'n1', expected: 'FAIL', repo: fixture(`${CODE} // one`) },
      { id: 'n2', expected: 'PASS', repo: fixture(`${CODE} // two`) },
    ];
    const other = [
      { id: 'far', expected: 'PASS', repo: fixture('nothing alike in here at all today') },
    ];
    const refused = unrelatedTwinProblems(batch, other);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/near-twin of batch row/);
  });
});

describe('lintRows id contract', () => {
  it('refuses a row id containing a colon (the checkpoint key seam)', () => {
    expect(() =>
      lintRows(
        [{ id: 'a:b', reviewer: 'r', expected: 'PASS', note: 'n', repo: { base: {}, staged: {} } }],
        'r',
      ),
    ).toThrow(/must not contain/);
  });
});

describe('holdoutFloorShortfalls', () => {
  it('names each class under the floor and stays silent when met', () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `g${i}`, expected: 'FAIL', holdout: true })),
      { id: 'd0', expected: 'PASS', holdout: true },
      { id: 'd1', expected: 'PASS', holdout: false },
    ];
    expect(holdoutFloorShortfalls(rows)).toEqual(['PASS: 1 holdout row(s), floor 3']);
    expect(holdoutFloorShortfalls(rows.filter((r) => r.expected === 'FAIL'))).toEqual([]);
  });
});

describe('label rule stamps (sc-2497)', () => {
  const chain = [
    { ship_id: 'fail', exit_code: 1 },
    { ship_id: 'still', exit_code: 1 },
    { ship_id: 'fixed', exit_code: 0 },
  ];
  it('names the tier that minted the label at both reviewer and lens level', () => {
    const statusOf = (ship: string) =>
      ship === 'still' ? 'fail' : ship === 'fixed' ? 'pass' : undefined;
    expect(findNextOutcome(chain, 'fail', 'r', statusOf)).toEqual({
      kind: 'fixed',
      nextShipId: 'fixed',
      rule: 'reviewer-pass',
    });
    const lensPass = findNextLensOutcome(chain, 'fail', 'r', 'l', statusOf, (ship: string) =>
      ship === 'still' ? 'pass' : undefined,
    );
    expect(lensPass).toEqual({ kind: 'fixed', nextShipId: 'still', rule: 'lens-pass' });
    const absent = findNextLensOutcome(
      chain,
      'fail',
      'r',
      'l',
      () => undefined,
      () => undefined,
    );
    expect(absent).toEqual({ kind: 'fixed', nextShipId: 'fixed', rule: 'absence-exit0' });
    expect(findNextOutcome(chain, 'fail', 'r', () => 'fail')).toEqual({
      kind: 'no-fix-found',
      nextShipId: null,
      rule: null,
    });
  });
  it('stamps labelRule, sameDiffGuardArmable and evidenceShrunk on the candidate', () => {
    const c = buildFailFixCandidate({
      shipId: 's',
      repo: 'devkit',
      branch: 'b',
      reviewer: 'r',
      lens: 'l',
      tsFail: 't',
      diffSha256: 'a'.repeat(64),
      bytesAvailable: true,
      diffPayload: { diffText: 'x', diffPath: null },
      failReason: null,
      nextShipId: 'n',
      nextDiffSha256: null,
      nextBytesAvailable: false,
      nextDiffPayload: null,
      tsFix: 't2',
      labelRule: 'absence-exit0',
    });
    expect(c).toMatchObject({
      labelRule: 'absence-exit0',
      sameDiffGuardArmable: false,
      evidenceShrunk: true,
    });
    expect(
      buildFailFixCandidate({ shipId: 's', reviewer: 'r', nextShipId: 'n', labelRule: 'bogus' })
        .labelRule,
    ).toBe('fallback');
    expect(LABEL_RULES).toContain('lens-pass');
  });
});

describe('auditSuite', () => {
  it('reports never-measured, constant-correct, always-wrong, flipped, pairs and the holdout floor', () => {
    const reviewer = { name: 'correctness-reviewer' };
    const rows = [
      {
        id: 'g1',
        expected: 'FAIL',
        expectItems: ['state-transitions'],
        caseId: 'c1',
        holdout: true,
        repo: fixture('one two three four five six'),
      },
      {
        id: 'd1',
        expected: 'PASS',
        caseId: 'c1',
        holdout: false,
        repo: fixture('seven eight nine ten eleven twelve'),
      },
      {
        id: 'g2',
        expected: 'FAIL',
        expectItems: ['concurrency-races'],
        holdout: false,
        repo: fixture('alpha beta gamma delta epsilon zeta'),
      },
      {
        id: 'g3',
        expected: 'FAIL',
        expectItems: ['state-transitions'],
        holdout: false,
        repo: fixture('eta theta iota kappa lambda mu'),
      },
    ];
    const obs = new Map([
      [
        'g1',
        [
          { ok: true, arm: 'correctness-reviewer@sonnet@cascade-off' },
          { ok: true, arm: 'correctness-reviewer@sonnet@cascade-off' },
        ],
      ],
      [
        'g2',
        [
          { ok: false, arm: 'correctness-reviewer@sonnet@cascade-off' },
          { ok: false, arm: 'correctness-reviewer@sonnet@cascade-off' },
        ],
      ],
      [
        'g3',
        [
          { ok: true, arm: 'correctness-reviewer@sonnet@cascade-off' },
          { ok: false, arm: 'correctness-reviewer@sonnet@cascade-off' },
        ],
      ],
    ]);
    const a = auditSuite(reviewer, rows, obs);
    expect(a.neverMeasured).toEqual(['d1']);
    expect(a.constantCorrect).toEqual(['g1']);
    expect(a.alwaysWrong).toEqual(['g2']);
    expect(a.flipped).toEqual(['g3']);
    expect(a.perLensGold).toEqual({ 'state-transitions': 2, 'concurrency-races': 1 });
    expect(a.pairs).toEqual({
      groups: 1,
      oneMemberUnmeasured: 1,
      straddlingHoldout: 1,
      singletons: 2,
      largerGroups: 0,
    });
    expect(a.holdout.FAIL.meetsFloor).toBe(false);
    expect(a.nearTwins.unrelated).toBe(0);
  });
  it("ignores another reviewer's observations of the same row id (ids are unique per corpus only)", () => {
    const reviewer = { name: 'api-security-reviewer' };
    const rows = [
      {
        id: 'shared-id',
        expected: 'FAIL',
        expectItems: ['auth'],
        repo: fixture('one two three four five six'),
      },
    ];
    const obs = new Map([
      [
        'shared-id',
        [
          { ok: false, arm: 'correctness-reviewer@sonnet@cascade-off' },
          { ok: false, arm: 'correctness-reviewer@sonnet@cascade-off' },
          { ok: true, arm: 'api-security-reviewer@haiku@cascade-on' },
        ],
      ],
    ]);
    const a = auditSuite(reviewer, rows, obs);
    expect(a.alwaysWrong).toEqual([]);
    expect(a.multiObserved).toBe(0);
    expect(a.neverMeasured).toEqual([]);
    expect(a.measuredArms).toEqual(['api-security-reviewer@haiku@cascade-on']);
    expect(auditSuite({ name: 'api-security' }, rows, obs).neverMeasured).toEqual(['shared-id']);
  });
});
