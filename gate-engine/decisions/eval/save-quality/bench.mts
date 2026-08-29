#!/usr/bin/env node

/**
 * decisions-save-quality: is the decision log's WRITE path getting better or worse?
 *
 * The read path (recall/) has a 29-case benchmark; this is the write-path counterpart. Unlike the
 * depth judge (an LLM call per Target), every check here is deterministic string/AST work over
 * already-loaded text — zero LLM calls, a few milliseconds — so, like decisions-recall, this can gate
 * on every commit rather than sample.
 *
 * TWO SEPARATE REPORTS, never pooled (see scoring.mts's docstring for why):
 *
 *   (1) PERTURBATION corpus (cases-save.jsonl + corpus/adapted/**) — a small, neutralised, ADAPTED
 *       fixture set (never verbatim real docs/decisions content) with one mechanical mutation per
 *       check (perturb.mts). This is where recall and false-positive rate are actually MEASURABLE —
 *       headline: FPR@R80 (recall must clear an 80% floor before the FPR number means anything; see
 *       scoring.mts).
 *   (2) REAL corpus (docs/decisions/**, this repo's own) — scanned fresh, no fixtures. A standing
 *       zero-findings assertion, except the one NAMED historical exception this suite already knows
 *       about (see KNOWN_REAL_EXCEPTIONS). Any OTHER finding here is a live regression, not a scoring
 *       exercise — there is no "recall" to measure against a corpus that manufactures no defects.
 *
 *   node bench.mts                 # perturbation scoring + real-corpus regression check
 *   node bench.mts coverage        # corpus composition, zero scans
 *   node bench.mts --json          # machine-readable summary
 */

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveFromCwd, resolveGuardConfig } from '../../../config.mts';
import {
  parseDecision,
  parseIndex,
  renderDecision,
  renderIndex,
  upsertRow,
} from '../../decision-format.mts';
import {
  INTEGRITY_CHECK_IDS,
  type IntegrityCheckId,
  integrityFindingKey,
} from '../../integrity/checks.mts';
import type { Fixture } from '../../integrity/perturb.mts';
import { MUTATIONS } from '../../integrity/perturb.mts';
import { scanCorpus } from '../../integrity/scan.mts';
import { BenchAbort, parseCasesText } from '../cases.mts';
import { wilson } from '../compare.mts';
import {
  type CaseResult,
  FPR_CEILING,
  gatePassed,
  RECALL_FLOOR,
  type SaveQualityCase,
  scoreCase,
  summarize,
} from './scoring.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CORPUS = path.join(here, 'corpus', 'adapted');
const CASES = path.join(here, 'cases-save.jsonl');
const BASELINE = path.join(here, 'results.baseline.json');

/**
 * The ONE known, named exception on the real corpus (see integrity/checks.mts's docstring):
 * overlay-self-heal's 2026-07-14 re-target predates this check and is append-only, so it can never be
 * fixed in place.
 *
 * Keyed on the BLOCK, not just the axis. retarget-missing-evidence-change reports per Target block,
 * so a (slug, check) key would be coarser than the finding it excepts: the moment overlay-self-heal is
 * re-targeted again without Evidence-change, that genuinely new regression would carry the identical
 * key and be swallowed as "known". Any other (slug, check, block) triple is a real regression.
 */
export const KNOWN_REAL_EXCEPTIONS = [
  { slug: 'overlay-self-heal', check: 'retarget-missing-evidence-change', block: '2026-07-14' },
];

const exceptionKey = integrityFindingKey;

export function loadCases(): SaveQualityCase[] {
  if (!existsSync(CASES)) throw new BenchAbort(2, `save-quality: missing ${path.basename(CASES)}`);
  const rows = parseCasesText(readFileSync(CASES, 'utf8')) as SaveQualityCase[];
  if (!rows.length) throw new BenchAbort(2, 'save-quality: case file is empty');
  const errors = lintSaveCases(rows);
  if (errors.length)
    throw new BenchAbort(2, `save-quality: malformed cases —\n  ${errors.join('\n  ')}`);
  return rows;
}

/** Structural contract, checked before any scan runs. */
export function lintSaveCases(rows: SaveQualityCase[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const checkIds = new Set<string>(INTEGRITY_CHECK_IDS);
  for (const [i, r] of rows.entries()) {
    const at = `row ${i + 1}${r?.id ? ` (${r.id})` : ''}`;
    if (!r?.id) errors.push(`${at}: missing id`);
    if (r?.id && seen.has(r.id)) errors.push(`${at}: duplicate id`);
    if (r?.id) seen.add(r.id);
    if (r?.provenance !== 'adapted') errors.push(`${at}: provenance must be "adapted"`);
    if (!r?.baseSlug || !existsSync(path.join(CORPUS, `${r.baseSlug}.md`)))
      errors.push(`${at}: baseSlug "${r?.baseSlug}" is not a corpus/adapted fixture`);
    if (r?.mutation !== 'none' && !checkIds.has(r?.mutation))
      errors.push(`${at}: mutation "${r?.mutation}" is not "none" or a known check id`);
    if (r?.mutation === 'none' && (r.expected?.length ?? 0) !== 0)
      errors.push(`${at}: mutation "none" must have an empty expected[]`);
    if (r?.mutation !== 'none' && JSON.stringify(r.expected) !== JSON.stringify([r.mutation]))
      errors.push(`${at}: expected must be exactly [mutation] for a mutated case`);
  }
  return errors;
}

/** One case's isolated corpus copy: the clean fixture set, with EXACTLY this case's mutation applied
 * to its own baseSlug. Nothing else in the copy differs from `corpus/adapted/` — any OTHER finding
 * this produces is collateral damage from the mutation, scored as a false positive. */
function materializeMutatedCorpus(
  tmpRoot: string,
  baseSlug: string,
  mutation: IntegrityCheckId,
): string {
  const dest = mkdtempSync(path.join(tmpRoot, 'save-quality-'));
  cpSync(CORPUS, dest, { recursive: true });
  const { fm, body } = parseDecision(readFileSync(path.join(CORPUS, `${baseSlug}.md`), 'utf8'));
  const indexRows = parseIndex(readFileSync(path.join(CORPUS, 'INDEX.md'), 'utf8'));
  const indexRow = indexRows.find((r) => r.slug === baseSlug);
  if (!indexRow) throw new BenchAbort(2, `save-quality: no INDEX row for base "${baseSlug}"`);
  const fixture: Fixture = { axis: { slug: baseSlug, fm, body }, indexRow };
  const mutated = MUTATIONS[mutation](fixture);
  writeFileSync(
    path.join(dest, `${baseSlug}.md`),
    renderDecision(mutated.axis.fm, mutated.axis.body),
  );
  writeFileSync(path.join(dest, 'INDEX.md'), renderIndex(upsertRow(indexRows, mutated.indexRow)));
  return dest;
}

function runCase(tmpRoot: string, c: SaveQualityCase): CaseResult {
  if (c.mutation === 'none') return scoreCase(c, scanCorpus(CORPUS).findings);
  const dest = materializeMutatedCorpus(tmpRoot, c.baseSlug, c.mutation);
  try {
    return scoreCase(c, scanCorpus(dest).findings);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

export function runPerturbation(cases: SaveQualityCase[]) {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'decisions-save-quality-'));
  try {
    const results = cases.map((c) => runCase(tmpRoot, c));
    return summarize(results);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export interface RealCorpusReport {
  filesScanned: number;
  known: { slug: string; check: string; block?: string }[];
  /** Carries `block` for the same reason KNOWN_REAL_EXCEPTIONS does: the filter above matches on the
   * full (slug, check, block) key, so dropping it here would report a new finding in a shape that
   * cannot be pasted back into the allowlist to grandfather it. */
  unexpected: { slug: string; check: string; block?: string; detail: string }[];
}

/** Scan THIS repo's own live docs/decisions/** — no fixtures, no mutation. A standing assertion, not
 * a scored corpus (see this file's top docstring for why the two are never pooled). */
export function runRealCorpus(cwd = process.cwd()): RealCorpusReport | null {
  const cfg = resolveGuardConfig(cwd);
  const dir = resolveFromCwd(cfg, 'decisionsDir');
  if (!dir || !existsSync(dir)) return null;
  const { findings, filesScanned } = scanCorpus(dir);
  const known = new Set(KNOWN_REAL_EXCEPTIONS.map(exceptionKey));
  return {
    filesScanned,
    known: KNOWN_REAL_EXCEPTIONS,
    unexpected: findings
      .filter((f) => !known.has(exceptionKey(f)))
      .map((f) => ({ slug: f.slug, check: f.check, block: f.block, detail: f.detail })),
  };
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
const ci = (k: number, n: number) => {
  if (!n) return '—';
  const { lo, hi } = wilson(k, n);
  return `${k}/${n} = ${pct(k, n)} [${(lo * 100).toFixed(0)}, ${(hi * 100).toFixed(0)}]`;
};

function report(summary: ReturnType<typeof summarize>, real: RealCorpusReport | null) {
  console.log('\n── decisions-save-quality: perturbation corpus ──');
  console.log(
    `recall (defect cases) ${ci(summary.recall.hit, summary.recall.total)}  (floor ${RECALL_FLOOR * 100}%)`,
  );
  for (const [check, r] of Object.entries(summary.perCheck)) {
    console.log(`    ${check.padEnd(34)} ${ci(r.hit, r.total)}`);
  }
  console.log(
    summary.headlineFpr === null
      ? `FPR@R80  — recall floor not met; FPR is not a meaningful number below it`
      : `FPR@R80  ${ci(summary.fpr.bad, summary.fpr.total)}  (ceiling ${FPR_CEILING * 100}%)`,
  );
  // Named before the verdict: a pooled percentage that still clears its floor would otherwise make a
  // wholly dead check look like a rounding error (see gatePassed's docstring).
  if (summary.checksRegressed.length)
    console.log(
      `  ✗ check(s) that missed a mutation built for them: ${summary.checksRegressed.join(', ')}`,
    );
  if (summary.checksUncovered.length)
    console.log(`  ✗ declared check(s) with no defect case: ${summary.checksUncovered.join(', ')}`);
  console.log(`gate: ${gatePassed(summary) ? 'PASS' : 'FAIL'}`);
  const bad = Object.entries(summary.rows).filter(([, r]) => !r.recallHit || r.falsePositive);
  if (bad.length) {
    console.log('\n  failing cases:');
    for (const [id, r] of bad)
      console.log(
        `    ${id}: ${!r.recallHit ? 'MISS' : ''}${r.falsePositive ? ` FALSE-POSITIVE [${r.unexpected.join(', ')}]` : ''}`,
      );
  }

  console.log('\n── decisions-save-quality: real corpus (docs/decisions/**) ──');
  if (!real) {
    console.log('  no decisions directory found — skipped');
  } else {
    console.log(`  ${real.filesScanned} files scanned`);
    console.log(
      `  known exceptions: ${
        real.known
          .map((e) => `${e.slug}[${e.check}${e.block ? ` @ ${e.block}` : ''}]`)
          .join(', ') || '(none)'
      }`,
    );
    if (real.unexpected.length) {
      console.log(`  ✗ ${real.unexpected.length} NEW finding(s) beyond the known exceptions:`);
      for (const u of real.unexpected) console.log(`      ${u.slug} [${u.check}] — ${u.detail}`);
    } else {
      console.log('  ✓ no findings beyond the known exceptions');
    }
  }
}

/**
 * The publishable baseline: the numbers this suite already computed, stated in the `deterministic`
 * adapter's shape so the dashboard renders them verbatim rather than inferring them.
 *
 * Both directions are published, not just the flattering one. Recall alone would look perfect while a
 * check quietly false-fired; FPR alone would look perfect while a check detected nothing. The real
 * corpus is a third, separate number — never pooled with the perturbation ones (see this file's
 * docstring), because a manufactured-defect corpus and a live log answer different questions.
 */
export function baselineOf(summary: ReturnType<typeof summarize>, real: RealCorpusReport | null) {
  return {
    metrics: [
      {
        id: 'defect-recall',
        label: 'Defect recall (perturbation corpus)',
        k: summary.recall.hit,
        n: summary.recall.total,
      },
      {
        id: 'false-positive-rate',
        label: 'False-positive rate at R80',
        k: summary.fpr.bad,
        n: summary.fpr.total,
        direction: 'lower',
      },
      {
        id: 'checks-exercised',
        label: 'Declared checks with a perturbation case',
        k: INTEGRITY_CHECK_IDS.length - summary.checksUncovered.length,
        n: INTEGRITY_CHECK_IDS.length,
      },
      ...(real
        ? [
            {
              id: 'real-corpus-clean',
              label: 'Real records with no unexpected finding',
              k: real.filesScanned - real.unexpected.length,
              n: real.filesScanned,
            },
          ]
        : []),
    ],
    rows: summary.rows,
    floorsMet: gatePassed(summary) && !summary.checksUncovered.length && !real?.unexpected.length,
  };
}

function coverage(cases: SaveQualityCase[]) {
  console.log('\n── coverage ──');
  console.log(
    `${cases.length} cases · ${cases.filter((c) => c.mutation === 'none').length} clean · ${
      cases.filter((c) => c.mutation !== 'none').length
    } defect`,
  );
  const byCheck: Record<string, number> = {};
  for (const c of cases)
    if (c.mutation !== 'none') byCheck[c.mutation] = (byCheck[c.mutation] ?? 0) + 1;
  for (const id of INTEGRITY_CHECK_IDS)
    console.log(`  ${id.padEnd(34)} ${byCheck[id] ?? 0} case(s)`);
  const uncovered = INTEGRITY_CHECK_IDS.filter((id) => !byCheck[id]);
  if (uncovered.length) console.log(`\n  ✗ uncovered check(s): ${uncovered.join(', ')}`);
  return uncovered.length;
}

export async function main(argv: string[]) {
  const args = new Set(argv);
  const cases = loadCases();

  if (args.has('coverage')) process.exit(coverage(cases) ? 1 : 0);

  const summary = runPerturbation(cases);
  const real = runRealCorpus();

  if (args.has('--baseline')) {
    writeFileSync(BASELINE, `${JSON.stringify(baselineOf(summary, real), null, 2)}\n`);
    console.log(`save-quality: wrote ${path.basename(BASELINE)}`);
  } else if (args.has('--json')) {
    console.log(JSON.stringify({ perturbation: summary, real }, null, 2));
  } else {
    report(summary, real);
  }
  // Three independent ways to fail, none allowed to mask another: a check regressed or the corpus-wide
  // rates slipped (gatePassed), a declared check has no case at all so it was never exercised
  // (checksUncovered — the corpus question `coverage` answers, folded in so the DEFAULT run cannot
  // silently skip it), or the real log grew a finding beyond the one named exception.
  const ok = gatePassed(summary) && !summary.checksUncovered.length && !real?.unexpected.length;
  process.exit(ok ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof BenchAbort ? e.message : `save-quality: ${e}`);
    process.exit(e instanceof BenchAbort ? e.code : 2);
  });
}
