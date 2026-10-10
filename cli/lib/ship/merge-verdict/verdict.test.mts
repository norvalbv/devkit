import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChangedPath,
  type EvidenceOutcome,
  type MergeVerdict,
  mergeVerdict,
  type ShipChange,
  VERDICT_REASONS,
  type VerdictReason,
  verdictLine,
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
  paths,
  bypasses: [],
  evidence: captured,
  ...over,
});
const fix = p('src/fix.mts', 10, 2);
/** A `mergeVerdict` value as written in guard.config.json; `maxSourceLine` is a deliberate typo. */
interface PolicyFixture {
  consumerSurface?: string[];
  maxSourceLines?: number;
  maxSourceFiles?: number;
  maxSourceLine?: number;
}
const config = (mergeVerdict: PolicyFixture) => JSON.stringify({ mergeVerdict });
const SURFACE = config({ consumerSurface: ['./cli/commands/**', 'skills/**'] });

interface Row {
  name: string;
  change: ShipChange;
  config?: string;
  verdict: MergeVerdict['verdict'];
  reasons: VerdictReason[];
}

const ABSTENTIONS = [
  'no-test-change',
  'docs-only',
  'declared-no-behaviour-change',
  'platform-skipped',
  'not-configured',
];

const ROWS: Row[] = [
  {
    name: 'empty diff',
    change: change([]),
    verdict: 'human-review',
    reasons: [{ code: 'no-change' }],
  },
  {
    name: 'unreadable bypass record',
    change: change([fix], { bypasses: 'unknown' }),
    verdict: 'human-review',
    reasons: [{ code: 'bypass-unknown' }, { code: 'captured-proof' }],
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
    reasons: [{ code: 'over-size', detail: '51/50 lines, 1/4 files' }, { code: 'captured-proof' }],
  },
  {
    name: '5 files',
    change: change(['a', 'b', 'c', 'd', 'e'].map((n) => p(`${n}.mts`))),
    verdict: 'human-review',
    reasons: [{ code: 'over-size', detail: '5/50 lines, 5/4 files' }, { code: 'captured-proof' }],
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
    name: 'maxSourceLines 0 admits only test-only changes',
    change: change([fix]),
    config: config({ maxSourceLines: 0 }),
    verdict: 'human-review',
    reasons: [{ code: 'over-size', detail: '12/0 lines, 1/4 files' }, { code: 'captured-proof' }],
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
  ...ABSTENTIONS.map((abstention): Row => ({
    name: `not-run: ${abstention}`,
    change: change([fix], { evidence: { status: 'not-run', headSha: HEAD, abstention } }),
    verdict: 'human-review',
    reasons: [{ code: 'no-captured-proof', detail: `not-run: ${abstention}` }],
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
      { code: 'over-size', detail: '60/50 lines, 1/4 files' },
      { code: 'no-captured-proof', detail: 'missing' },
    ],
  },
  ...[
    ['an unknown key', config({ maxSourceLine: 10 }), 'mergeVerdict'],
    ['a fractional threshold', config({ maxSourceLines: 1.5 }), 'mergeVerdict.maxSourceLines'],
    ['an escaping glob', config({ consumerSurface: ['../x'] }), 'mergeVerdict.consumerSurface.0'],
    [
      'a character class',
      config({ consumerSurface: ['[ab]/**'] }),
      'mergeVerdict.consumerSurface.0',
    ],
    ['malformed JSON', '{', 'guard.config.json is not valid JSON'],
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
    expect(verdictLine(result)).toMatch(
      new RegExp(`^${row.verdict} \\(${result.reasons[0].code}[:)]`),
    );
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

  it.each(['guard.config.json', 'guard.config.example.json'])('parses the shipped %s', (file) => {
    const text = readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');
    expect(mergeVerdict(change([p('templates/x.md')]), text).reasons).toEqual([
      { code: 'consumer-surface' },
    ]);
  });

  it('honours an env-relocated decision log, as every other gate does', () => {
    vi.stubEnv('GUARD_DECISIONS_DIR', 'records');
    expect(mergeVerdict(change([p('records/x.md')]), null).reasons).toEqual([
      { code: 'decision-record' },
    ]);
  });
});

describe('verdictLine', () => {
  it('prints the deciding reason and its detail', () => {
    expect(verdictLine(mergeVerdict(change([p('a.mts', 51)]), null))).toBe(
      'human-review (over-size: 51/50 lines, 1/4 files)',
    );
    expect(verdictLine(mergeVerdict(change([p('a.test.mts')]), null))).toBe(
      'auto-merge-eligible (test-only)',
    );
  });

  it('cannot close the evidence markers or break the line', () => {
    const hostile = 'x --> <!-- y\n`z`‮';
    const line = verdictLine(mergeVerdict(change([fix], { bypasses: [hostile] }), null));
    expect(line).toBe('human-review (gate-bypassed: x --_ _!-- y__z__)');
  });
});
