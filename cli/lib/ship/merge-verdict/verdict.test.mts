import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVIDENCE_ABSTENTIONS,
  EVIDENCE_STATUSES,
  inconclusive,
  notRun,
} from '../evidence/outcome.mts';
import {
  type ChangedPath,
  type EvidenceOutcome,
  type MergeVerdict,
  mergeVerdict,
  type ShipChange,
  VERDICT_REASONS,
  type VerdictReason,
  verdictEnabled,
  verdictReasons,
} from './verdict.mts';

const HEAD = 'a'.repeat(40);
const captured: EvidenceOutcome = { status: 'captured', headSha: HEAD };

const p = (path: string, added: number | null = 1, deleted: number | null = 0): ChangedPath => ({
  path,
  added,
  deleted,
});
const change = (paths: ChangedPath[], over: Partial<ShipChange> = {}): ShipChange => ({
  headSha: HEAD,
  subject: 'Untyped subject',
  paths,
  bypasses: [],
  evidence: captured,
  ...over,
});
const fix = p('src/fix.mts', 10, 2);
interface LimitFixture {
  maxSourceLines?: number;
  maxSourceFiles?: number;
  maxSourceLine?: number;
}
/** A `mergeVerdict` value as written in guard.config.json; `maxSourceLine` is a deliberate typo. */
interface PolicyFixture {
  enabled?: boolean | string;
  consumerSurface?: string[];
  limits?: Record<string, LimitFixture>;
  maxSourceLines?: number;
}
const config = (mergeVerdict: PolicyFixture) => JSON.stringify({ mergeVerdict });
const SURFACE = config({ consumerSurface: ['./cli/commands/**', 'skills/**'] });
const TYPED = config({
  limits: { fix: { maxSourceLines: 500, maxSourceFiles: 10 }, feat: { maxSourceLines: 200 } },
});
const big = p('src/big.mts', 300, 100);

interface Row {
  name: string;
  change: ShipChange;
  config?: string;
  verdict: MergeVerdict['verdict'];
  reasons: VerdictReason[];
}

const ROWS: Row[] = [
  {
    name: 'empty diff',
    change: change([]),
    verdict: 'human-review',
    reasons: [{ code: 'no-change' }],
  },
  {
    name: 'unreadable bypass record',
    change: change([fix], { bypasses: { unknown: 'no ship record' } }),
    verdict: 'human-review',
    reasons: [{ code: 'bypass-unknown', detail: 'no ship record' }, { code: 'captured-proof' }],
  },
  {
    name: 'a bypass and a waived finding, deduplicated',
    change: change([fix], {
      bypasses: ['GUARD_COVERAGE_OK', 'waived:correctness', 'GUARD_COVERAGE_OK'],
    }),
    verdict: 'human-review',
    reasons: [
      { code: 'gate-bypassed', detail: 'GUARD_COVERAGE_OK, waived:correctness' },
      { code: 'captured-proof' },
    ],
  },
  {
    name: 'package.json',
    change: change([p('package.json')]),
    verdict: 'policy',
    reasons: [{ code: 'dependency' }],
  },
  {
    name: 'nested bun.lock',
    change: change([p('pkgs/a/bun.lock')]),
    verdict: 'policy',
    reasons: [{ code: 'dependency' }],
  },
  {
    name: 'Cargo.toml',
    change: change([p('crates/x/Cargo.toml')]),
    verdict: 'policy',
    reasons: [{ code: 'dependency' }],
  },
  {
    name: 'go.sum',
    change: change([p('go.sum')]),
    verdict: 'policy',
    reasons: [{ code: 'dependency' }],
  },
  {
    name: 'requirements-dev.txt',
    change: change([p('requirements-dev.txt')]),
    verdict: 'policy',
    reasons: [{ code: 'dependency' }],
  },
  {
    name: 'a test fixture package.json stays a test',
    change: change([p('cli/__tests__/fixtures/package.json')]),
    verdict: 'auto-merge-eligible',
    reasons: [{ code: 'test-only' }],
  },
  ...[
    'guard.config.json',
    'pkg/guard.config.json',
    '.github/workflows/gate.yml',
    '.github/workflows/smoke.test.yml',
    '.husky/pre-commit',
    '.devkit/config.json',
    '.devkit/correctness-overrides.json',
    '.devkit/oxc/oxlint.json',
    '.anti-slop-baseline.json',
    '.co-occurrence-allowlist.json',
  ].map((path): Row => ({
    name: `governance: ${path}`,
    change: change([p(path)]),
    verdict: 'policy',
    reasons: [{ code: 'merge-governance' }],
  })),
  {
    name: 'a raised size ceiling beside a small proven fix',
    change: change([fix, p('.devkit/baselines/size-lines.json')]),
    verdict: 'policy',
    reasons: [{ code: 'merge-governance' }, { code: 'captured-proof' }],
  },
  {
    name: 'decision record',
    change: change([p('docs/decisions/x.md')]),
    verdict: 'human-review',
    reasons: [{ code: 'decision-record' }],
  },
  {
    name: 'relocated decisionsDir',
    change: change([p('adr/x.md'), p('docs/decisions/x.md')]),
    config: JSON.stringify({ decisionsDir: 'adr' }),
    verdict: 'human-review',
    reasons: [{ code: 'decision-record' }, { code: 'captured-proof' }],
  },
  {
    name: 'consumer surface',
    change: change([p('cli/commands/ship.mts')]),
    config: SURFACE,
    verdict: 'human-review',
    reasons: [{ code: 'consumer-surface' }],
  },
  {
    name: 'a test under a surface glob is a test',
    change: change([p('cli/commands/__tests__/ship.test.mts')]),
    config: SURFACE,
    verdict: 'auto-merge-eligible',
    reasons: [{ code: 'test-only' }],
  },
  {
    name: 'test-only of any size, with no evidence',
    change: change([p('src/a.test.mts', 3000, 0), p('src/__tests__/b.mts', 0, 400)], {
      evidence: null,
    }),
    verdict: 'auto-merge-eligible',
    reasons: [{ code: 'test-only' }],
  },
  {
    name: '50 lines in 4 files with captured proof',
    change: change([
      p('a.mts', 20, 5),
      p('b.mts', 10),
      p('c.mts', 10),
      p('d.mts', 0, 5),
      p('a.test.mts', 99),
    ]),
    verdict: 'auto-merge-eligible',
    reasons: [{ code: 'captured-proof' }],
  },
  {
    name: 'SHA-256 heads',
    change: change([fix], {
      headSha: 'c'.repeat(64),
      evidence: { status: 'captured', headSha: 'c'.repeat(64) },
    }),
    verdict: 'auto-merge-eligible',
    reasons: [{ code: 'captured-proof' }],
  },
  {
    name: '51 lines',
    change: change([p('a.mts', 51, 0)]),
    verdict: 'human-review',
    reasons: [
      { code: 'over-size', detail: '51/50 lines, 1/4 files, default limit' },
      { code: 'captured-proof' },
    ],
  },
  {
    name: '5 files',
    change: change(['a', 'b', 'c', 'd', 'e'].map((n) => p(`${n}.mts`))),
    verdict: 'human-review',
    reasons: [
      { code: 'over-size', detail: '5/50 lines, 5/4 files, default limit' },
      { code: 'captured-proof' },
    ],
  },
  {
    name: 'binary source',
    change: change([p('logo.png', null, null)]),
    verdict: 'human-review',
    reasons: [{ code: 'over-size', detail: 'unknown line count' }, { code: 'captured-proof' }],
  },
  {
    name: 'a negative count',
    change: change([p('a.mts', 60, -30)]),
    verdict: 'human-review',
    reasons: [{ code: 'over-size', detail: 'unknown line count' }, { code: 'captured-proof' }],
  },
  {
    name: 'a default maxSourceLines of 0 admits only test-only changes',
    change: change([fix]),
    config: config({ limits: { default: { maxSourceLines: 0 } } }),
    verdict: 'human-review',
    reasons: [
      { code: 'over-size', detail: '12/0 lines, 1/4 files, default limit' },
      { code: 'captured-proof' },
    ],
  },
  {
    name: 'a fix subject gets the fix limit',
    change: change([big], { subject: 'fix(ship): keep the block' }),
    config: TYPED,
    verdict: 'auto-merge-eligible',
    reasons: [{ code: 'captured-proof' }],
  },
  {
    name: 'a feat subject gets the feat limit, its files falling back to the built-in 4',
    change: change([big], { subject: 'feat: a new verb' }),
    config: TYPED,
    verdict: 'human-review',
    reasons: [
      { code: 'over-size', detail: '400/200 lines, 1/4 files, feat limit' },
      { code: 'captured-proof' },
    ],
  },
  {
    name: 'the commit type is case-insensitive',
    change: change([big], { subject: 'FIX: shout' }),
    config: TYPED,
    verdict: 'auto-merge-eligible',
    reasons: [{ code: 'captured-proof' }],
  },
  ...[
    ['a breaking change', 'fix(ship)!: drop a flag'],
    ['a type with no entry', 'chore: tidy'],
    ['no type', 'Release v1.2.3'],
  ].map(([name, subject]): Row => ({
    name: `${name} gets the default limit`,
    change: change([big], { subject }),
    config: TYPED,
    verdict: 'human-review',
    reasons: [
      { code: 'over-size', detail: '400/50 lines, 1/4 files, default limit' },
      { code: 'captured-proof' },
    ],
  })),
  {
    name: 'a type entry inherits the fields it omits from the default entry',
    change: change([big, p('src/b.mts'), p('src/c.mts')], { subject: 'fix: x' }),
    config: config({
      limits: { default: { maxSourceFiles: 2 }, fix: { maxSourceLines: 500 } },
    }),
    verdict: 'human-review',
    reasons: [
      { code: 'over-size', detail: '402/500 lines, 3/2 files, fix limit' },
      { code: 'captured-proof' },
    ],
  },
  {
    name: 'a fix subject never stands in for captured proof',
    change: change([fix], { subject: 'fix: x', evidence: null }),
    config: TYPED,
    verdict: 'human-review',
    reasons: [{ code: 'no-captured-proof', detail: 'missing' }],
  },
  ...[
    ['evidence at another head', HEAD, 'b'.repeat(40)],
    ['empty SHAs', '', ''],
    ['abbreviated SHAs', 'abc1234', 'abc1234'],
  ].map(([name, headSha, evidenceSha]): Row => ({
    name,
    change: change([fix], { headSha, evidence: { status: 'captured', headSha: evidenceSha } }),
    verdict: 'human-review',
    reasons: [{ code: 'no-captured-proof', detail: 'stale' }],
  })),
  {
    name: 'inconclusive',
    change: change([fix], { evidence: { status: 'inconclusive', headSha: HEAD } }),
    verdict: 'human-review',
    reasons: [{ code: 'no-captured-proof', detail: 'inconclusive' }],
  },
  ...EVIDENCE_ABSTENTIONS.map((reason): Row => ({
    name: `not-run: ${reason}`,
    change: change([fix], { evidence: notRun(reason, 'why', HEAD, null) }),
    verdict: 'human-review',
    reasons: [{ code: 'no-captured-proof', detail: `not-run: ${reason}` }],
  })),
  {
    name: 'no evidence',
    change: change([fix], { evidence: null }),
    verdict: 'human-review',
    reasons: [{ code: 'no-captured-proof', detail: 'missing' }],
  },
  {
    name: 'a bypass outranks a dependency',
    change: change([p('package.json')], { bypasses: ['GUARD_NO_REVIEW'] }),
    verdict: 'human-review',
    reasons: [{ code: 'gate-bypassed', detail: 'GUARD_NO_REVIEW' }, { code: 'dependency' }],
  },
  {
    name: 'every reason is kept: decision, surface, size and proof',
    change: change([p('docs/decisions/x.md'), p('skills/x/SKILL.md'), p('a.mts', 60)], {
      evidence: null,
    }),
    config: SURFACE,
    verdict: 'human-review',
    reasons: [
      { code: 'decision-record' },
      { code: 'consumer-surface' },
      { code: 'over-size', detail: '60/50 lines, 1/4 files, default limit' },
      { code: 'no-captured-proof', detail: 'missing' },
    ],
  },
  ...[
    ['a removed top-level threshold', config({ maxSourceLines: 50 }), 'mergeVerdict'],
    [
      'an unknown limit key',
      config({ limits: { fix: { maxSourceLine: 10 } } }),
      'mergeVerdict.limits.fix',
    ],
    [
      'a fractional limit',
      config({ limits: { default: { maxSourceLines: 1.5 } } }),
      'mergeVerdict.limits.default.maxSourceLines',
    ],
    ['an uppercase type', config({ limits: { Fix: {} } }), 'mergeVerdict.limits.Fix'],
    ['a non-boolean enabled', config({ enabled: 'no' }), 'mergeVerdict.enabled'],
    ['an escaping glob', config({ consumerSurface: ['../x'] }), 'mergeVerdict.consumerSurface.0'],
    [
      'a character class',
      config({ consumerSurface: ['[ab]/**'] }),
      'mergeVerdict.consumerSurface.0',
    ],
    [
      'an extglob group',
      config({ consumerSurface: ['src/@(a|b)/**'] }),
      'mergeVerdict.consumerSurface.0',
    ],
    ['malformed JSON', '{', 'guard.config.json is not valid JSON'],
    [
      'a mergeVerdict block declared twice',
      `{"mergeVerdict": {"limits": {"fix": {"maxSourceLines": 1}}}, ${config({}).slice(1)}`,
      'guard.config.json declares "mergeVerdict" twice',
    ],
  ].map(([name, text, prefix]): Row => ({
    name: `config-invalid: ${name}`,
    change: change([p('a.test.mts')]),
    config: text,
    verdict: 'human-review',
    reasons: [{ code: 'config-invalid', detail: expect.stringContaining(prefix) }],
  })),
];

beforeEach(() => {
  for (const name of ['DECISIONS_DIR', 'ALLOWLIST_PATH']) {
    vi.stubEnv(`GUARD_${name}`, undefined);
    vi.stubEnv(`FRINK_${name}`, undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());

describe('mergeVerdict', () => {
  it.each(ROWS)('$name', (row) => {
    const result = mergeVerdict(row.change, row.config ?? null);
    expect(result).toEqual({ verdict: row.verdict, reasons: row.reasons });
    expect(verdictReasons(result)[0]).toMatch(new RegExp(`^\\*\\*${result.reasons[0].code}[:*]`));
  });

  it('treats only a capture at this head as proof, for every evidence status', () => {
    const proof = EVIDENCE_STATUSES.map((status) => {
      const evidence = { status, reason: null, detail: '', headSha: HEAD, baseSha: null };
      return [status, mergeVerdict(change([fix], { evidence }), null).reasons.at(-1)?.code];
    });
    expect(proof).toEqual([
      ['captured', 'captured-proof'],
      ['inconclusive', 'no-captured-proof'],
      ['not-run', 'no-captured-proof'],
    ]);
    expect(mergeVerdict(change([fix], { evidence: inconclusive('x', HEAD, null) }), null)).toEqual({
      verdict: 'human-review',
      reasons: [{ code: 'no-captured-proof', detail: 'inconclusive' }],
    });
  });

  it('has a row for every reason code', () => {
    const fired = new Set(ROWS.flatMap((row) => row.reasons.map((r) => r.code)));
    expect([...fired].sort()).toEqual(Object.keys(VERDICT_REASONS).sort());
  });

  it('reads defaults from a config without the key', () => {
    expect(mergeVerdict(change([fix]), '{"scanRoots":["src"]}').verdict).toBe(
      'auto-merge-eligible',
    );
  });

  const shipped = (file: string) =>
    readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');

  it.each([
    ['guard.config.json', 'cli/lib/ship/merge-verdict/verdict.mts'],
    ['guard.config.example.json', 'templates/x.md'],
  ])('parses the shipped %s', (file, surface) => {
    expect(mergeVerdict(change([p(surface)]), shipped(file)).reasons).toEqual([
      { code: 'consumer-surface' },
    ]);
  });

  it("devkit's own limits pass a 400-line fix and hold a 400-line feat", () => {
    const text = shipped('guard.config.json');
    expect(mergeVerdict(change([big], { subject: 'fix: x' }), text).verdict).toBe(
      'auto-merge-eligible',
    );
    expect(mergeVerdict(change([big], { subject: 'feat: x' }), text).verdict).toBe('human-review');
  });

  it('honours an env-relocated decision log, as every other gate does', () => {
    vi.stubEnv('GUARD_DECISIONS_DIR', 'records');
    expect(mergeVerdict(change([p('records/x.md')]), null).reasons).toEqual([
      { code: 'decision-record' },
    ]);
  });
});

describe('verdictEnabled', () => {
  it.each([
    ['no config', null, true],
    ['a config without the key', '{"scanRoots":["src"]}', true],
    ['enabled true', config({ enabled: true }), true],
    ['enabled false', config({ enabled: false, consumerSurface: ['templates/**'] }), false],
    ['a non-boolean enabled, which still prints config-invalid', config({ enabled: 'no' }), true],
    ['malformed JSON, which still prints config-invalid', '{', true],
  ])('%s', (_name, text, expected) => {
    expect(verdictEnabled(text)).toBe(expected);
  });

  it('accepts enabled alongside the other keys without reading as config-invalid', () => {
    const text = config({ enabled: false, limits: { fix: { maxSourceLines: 10 } } });
    expect(mergeVerdict(change([p('a.test.mts')]), text).verdict).toBe('auto-merge-eligible');
  });
});

describe('verdictReasons', () => {
  it('lists every reason that yields the verdict, deciding one first, with its detail', () => {
    expect(verdictReasons(mergeVerdict(change([p('a.mts', 51)]), null))).toEqual([
      '**over-size:** 51/50 lines, 1/4 files, default limit',
    ]);
    expect(verdictReasons(mergeVerdict(change([p('a.test.mts')]), null))).toEqual([
      '**test-only**',
    ]);
    const both = mergeVerdict(change([p('docs/decisions/x.md'), p('a.mts', 51)]), null);
    expect(both.reasons.at(-1)?.code).toBe('captured-proof');
    expect(verdictReasons(both)).toEqual([
      '**decision-record**',
      '**over-size:** 51/50 lines, 1/4 files, default limit',
    ]);
  });

  it('cannot close the evidence markers or break the line', () => {
    const hostile = 'x --> <!-- y\n`z`‮';
    const reasons = verdictReasons(mergeVerdict(change([fix], { bypasses: [hostile] }), null));
    expect(reasons).toEqual(['**gate-bypassed:** x --_ _!-- y__z__']);
  });
});
