/** corpus-lint's summary must count every diagnostic it printed. Assertions are relations, not
 * counts, so they hold whatever state the real corpora are in. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCasesText } from '../../../../decisions/eval/bench.mts';
import { REVIEWERS } from '../../../reviewers.mts';
import { casesFile } from '../corpus.mts';
import { admissionProblems } from '../corpus/admission.mts';

const SCRIPT = fileURLToPath(new URL('../corpus/corpus-lint.mts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const SUMMARY =
  /^corpus-lint: (\d+) row\(s\) across the reviewer corpora, (\d+) problem\(s\)(?:, (\d+) warning\(s\))?$/;

function lint(strict, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (strict) env.DEVKIT_HOLDOUT_FLOOR_STRICT = '1';
  else delete env.DEVKIT_HOLDOUT_FLOOR_STRICT;
  const run = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
  const lines = run.stderr.trim().split('\n');
  const m = SUMMARY.exec(lines.at(-1));
  expect(m, `summary line: ${lines.at(-1)}`).not.toBeNull();
  return {
    status: run.status,
    warningLines: lines.filter((l) => l.startsWith('corpus-lint: WARNING ')).length,
    unanchoredLines: lines.filter((l) => l.includes('unanchored corpus row')).length,
    rows: Number(m[1]),
    problems: Number(m[2]),
    suffix: m[3] !== undefined,
    warnings: Number(m[3] ?? 0),
  };
}

describe('corpus-lint summary', () => {
  const loose = lint(false);
  const strict = lint(true);

  it('counts every WARNING line it printed, and omits the suffix only when there are none', () => {
    expect(loose.warnings).toBe(loose.warningLines);
    expect(loose.suffix).toBe(loose.warningLines > 0);
  });

  it('keeps the zero-warning line unchanged: strict mode prints no WARNING lines and no suffix', () => {
    expect(strict.warningLines).toBe(0);
    expect(strict.suffix).toBe(false);
  });

  it('turns each warning into exactly one problem under strict mode, over the same rows', () => {
    expect(strict.rows).toBe(loose.rows);
    expect(strict.problems).toBe(loose.problems + loose.warnings);
  });

  it('blocks only on problems — warnings alone exit 0', () => {
    expect(loose.status !== 0).toBe(loose.problems > 0);
    expect(strict.status !== 0).toBe(strict.problems > 0);
  });
});

describe('corpus-lint admission wiring', () => {
  it('reads row ids from the base: an unchanged tree reports no unanchored row', () => {
    expect(lint(false).unanchoredLines).toBe(0);
  });

  it('finalize --check refuses an unanchored proposal before it is appended', () => {
    const suite = REVIEWERS.find((r) => existsSync(casesFile(r)));
    const [row] = parseCasesText(readFileSync(casesFile(suite), 'utf8'));
    const rest = { ...row, caseId: undefined, source: undefined, sourcePr: undefined };
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'admission-')), 'p.json');
    writeFileSync(file, JSON.stringify({ ...rest, id: 'new-unanchored', provenance: 'adapted' }));
    const finalize = fileURLToPath(new URL('../finalize.mts', import.meta.url));
    const run = spawnSync(process.execPath, [finalize, '--check', file], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
    });
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toContain('new-unanchored: unanchored corpus row');
  });

  it('fails closed when the base ref cannot be read', () => {
    const run = lint(false, {
      DEVKIT_SHIP_PR_BASE_SHA: '0000000000000000000000000000000000000000',
    });
    expect(run.status).not.toBe(0);
    expect(run.problems).toBeGreaterThan(0);
  });
});

const repo = { base: {}, staged: {} };
const anchored = (id, extra = {}) => ({
  id,
  provenance: 'adapted',
  caseId: 'case-a',
  source: { repo: 'o/r', url: 'https://example.test/pr/1' },
  repo,
  ...extra,
});
const refused = (rows, baseIds = []) =>
  admissionProblems(rows, new Set(baseIds), 'backend-performance-reviewer');

describe('admissionProblems', () => {
  it('refuses the hand-written adapted trio: no caseId, no source', () => {
    const rows = [
      { id: 'gold', provenance: 'adapted', expected: 'FAIL', variantOf: null, repo },
      { id: 'fixed', provenance: 'adapted', expected: 'PASS', variantOf: 'gold', repo },
      { id: 'decoy', provenance: 'adapted', expected: 'PASS', repo },
    ];
    const problems = refused(rows);
    expect(problems).toHaveLength(3);
    for (const p of problems) {
      expect(p).toContain('benchmarks-grow-from-telemetry');
      expect(p).toContain('docs/benchmarks/corpus-growth.md');
    }
    expect(problems[1]).toContain('variantOf gold');
  });

  it.each([
    ['authored provenance', { provenance: 'authored' }],
    ['missing provenance', { provenance: undefined }],
    ['an empty source object', { source: {} }],
    ['a source with no url or receipt', { source: { crossDomainOf: 'x' } }],
    ['a whitespace url', { source: { url: '  ' } }],
    ['a string sourcePr', { source: undefined, sourcePr: '42' }],
    ['adapted without caseId', { caseId: undefined }],
  ])('refuses a new row with %s', (_, extra) => {
    expect(refused([anchored('new', extra)])).toHaveLength(1);
  });

  it('grandfathers a row whose id is already at the base', () => {
    expect(refused([{ id: 'legacy', provenance: 'authored', repo }], ['legacy'])).toEqual([]);
  });

  it.each([
    ['source.url', {}],
    ['source.receipt', { source: { repo: 'o/r', receipt: 'sha256:abc' } }],
    ['a numeric sourcePr', { source: undefined, sourcePr: 0 }],
    ['an explicit variantOf: null', { variantOf: null }],
    ['a mined row without caseId', { provenance: 'mined', caseId: undefined }],
    ['a known-answer row', { provenance: 'known-answer' }],
  ])('admits an anchored row carrying %s', (_, extra) => {
    expect(refused([anchored('new', extra)])).toEqual([]);
  });

  it('admits a repair sibling sharing its gold caseId, refuses one that does not', () => {
    const gold = anchored('gold');
    expect(refused([gold, anchored('fix', { variantOf: 'gold' })])).toEqual([]);
    const [p] = refused([gold, anchored('fix', { variantOf: 'gold', caseId: 'case-b' })], ['gold']);
    expect(p).toContain('variantOf gold');
  });

  it('refuses a mined sibling with no caseId even when its gold has none', () => {
    const gold = anchored('gold', { provenance: 'mined', caseId: undefined });
    const fix = anchored('fix', { provenance: 'mined', caseId: undefined, variantOf: 'gold' });
    expect(refused([gold, fix], ['gold'])).toHaveLength(1);
  });

  it('does not judge a variantOf whose target is outside the rows (a one-proposal finalize check)', () => {
    expect(refused([anchored('fix', { variantOf: 'gold-in-same-batch' })])).toEqual([]);
  });

  it('refuses no committed mined, adapted or known-answer row that carries a source anchor', () => {
    for (const reviewer of REVIEWERS.filter((r) => existsSync(casesFile(r)))) {
      const rows = parseCasesText(readFileSync(casesFile(reviewer), 'utf8'));
      const legacy = rows.filter((r) => r.provenance === 'authored' || (!r.source && !r.sourcePr));
      expect(admissionProblems(rows, new Set(legacy.map((r) => r.id)), reviewer.name)).toEqual([]);
    }
  });
});
