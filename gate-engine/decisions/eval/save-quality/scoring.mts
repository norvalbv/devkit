/**
 * Save-quality scoring: pure, deterministic, no I/O, no model.
 *
 * Every check in integrity/checks.mts is a deterministic PASS/FAIL rule, not a scored classifier —
 * there is no similarity threshold to sweep (constraint, not a gap: sc-1236 measured that a
 * duplicate-ruling THRESHOLD rejects real work no matter where it is set, so none of these checks has
 * one). "FPR@R80" therefore does not mean a sweep along a ROC curve the way it would for a scored
 * detector; it means: RECALL is a FLOOR a deterministic check must simply clear (each check either
 * catches the exact mutation it was built for, or it has a bug), and only once that floor is cleared
 * does the FALSE-POSITIVE RATE become the number worth reporting as a headline. A run that misses the
 * recall floor fails outright — the FPR number is not "good" merely because nothing fired.
 *
 * PERTURBATION cases (this file, cases-save.jsonl) and the REAL corpus (docs/decisions/**, scanned
 * fresh by bench.mts) are reported SEPARATELY and never pooled: the perturbation corpus is where
 * recall/FPR are measurable at all (a real corpus manufactures no labelled defects to miss), while the
 * real corpus is a standing zero-findings-except-one-named-exception assertion (see checks.mts) —
 * pooling the two would let a perfect perturbation score hide a real regression, or vice versa.
 */

import {
  INTEGRITY_CHECK_IDS,
  type IntegrityCheckId,
  type IntegrityFinding,
} from '../../integrity/checks.mts';

export type SaveQualityProvenance = 'adapted';

export interface SaveQualityCase {
  id: string;
  provenance: SaveQualityProvenance;
  /** The clean corpus fixture this case is derived from (or, for a clean case, IS). */
  baseSlug: string;
  /** 'none' for a clean case; otherwise the perturb.mts mutation key applied to baseSlug. */
  mutation: 'none' | IntegrityCheckId;
  /** Check ids expected to fire on baseSlug. Empty means "this fixture must clear every check". */
  expected: IntegrityCheckId[];
  note: string;
}

/** One case's outcome against the findings produced by scanning ITS OWN isolated corpus copy (one
 * mutation applied, everything else identical to the clean fixture set). */
export interface CaseResult {
  id: string;
  expected: IntegrityCheckId[];
  /** Findings attributed to the case's own baseSlug. */
  ownFindings: IntegrityFinding[];
  /** Findings attributed to any OTHER slug in this case's corpus copy — collateral damage from a
   * mutation that was supposed to be isolated to one file. Should always be empty; a bench that finds
   * one is reporting a bug in a check, not in the corpus. */
  collateral: IntegrityFinding[];
  /** Every expected check fired on baseSlug (vacuously true when expected is empty). */
  recallHit: boolean;
  /** Any finding beyond what was expected — own-slug extra checks, or any collateral. */
  falsePositive: boolean;
  unexpected: IntegrityFinding[];
}

/** Score one case against the findings from scanning its isolated, single-mutation corpus copy. */
export function scoreCase(c: SaveQualityCase, findings: IntegrityFinding[]): CaseResult {
  const own = findings.filter((f) => f.slug === c.baseSlug);
  const collateral = findings.filter((f) => f.slug !== c.baseSlug);
  const expectedSet = new Set(c.expected);
  const ownChecks = new Set(own.map((f) => f.check));
  const recallHit = c.expected.every((e) => ownChecks.has(e));
  const unexpected = [...own.filter((f) => !expectedSet.has(f.check)), ...collateral];
  return {
    id: c.id,
    expected: c.expected,
    ownFindings: own,
    collateral,
    recallHit,
    falsePositive: unexpected.length > 0,
    unexpected,
  };
}

export interface SaveQualitySummary {
  /** Pooled over DEFECT cases only (expected non-empty) — a clean case has nothing to recall. */
  recall: { hit: number; total: number };
  /** Pooled over EVERY case, clean and defect alike — a clean case is exactly as valid an FPR trial
   * as a defect case's "did anything ELSE fire" question. */
  fpr: { bad: number; total: number };
  /** Recall broken out per check (grouped by each defect case's own expected check) — diagnostic, not
   * pooled: a single check with a real bug must be visible by name, not averaged away. */
  perCheck: Record<string, { hit: number; total: number }>;
  /** Whether recall cleared the 80% floor — the precondition for treating `fpr` as the headline. */
  recallFloorMet: boolean;
  /** null when the recall floor was not met (an FPR number is not meaningful below the floor). */
  headlineFpr: number | null;
  /** Checks that did NOT catch every mutation built for them. For a deterministic rule this is never
   * a tolerable shortfall — see gatePassed. Named, never averaged. */
  checksRegressed: string[];
  /** Declared check ids with no defect case at all. An uncovered check cannot regress the pooled
   * recall number, so without this it would be invisible to the gate entirely. */
  checksUncovered: string[];
  rows: Record<string, { recallHit: boolean; falsePositive: boolean; unexpected: string[] }>;
}

export const RECALL_FLOOR = 0.8;
export const FPR_CEILING = 0.1;

export function summarize(results: CaseResult[]): SaveQualitySummary {
  const defects = results.filter((r) => r.expected.length > 0);
  const recall = { hit: defects.filter((r) => r.recallHit).length, total: defects.length };
  const fpr = { bad: results.filter((r) => r.falsePositive).length, total: results.length };

  const perCheck: SaveQualitySummary['perCheck'] = {};
  for (const r of defects) {
    for (const check of r.expected) {
      perCheck[check] ??= { hit: 0, total: 0 };
      perCheck[check].total += 1;
      if (r.ownFindings.some((f) => f.check === check)) perCheck[check].hit += 1;
    }
  }

  const recallRate = recall.total ? recall.hit / recall.total : 0;
  const recallFloorMet = recall.total > 0 && recallRate >= RECALL_FLOOR;

  return {
    recall,
    fpr,
    perCheck,
    recallFloorMet,
    headlineFpr: recallFloorMet && fpr.total ? fpr.bad / fpr.total : null,
    checksRegressed: Object.entries(perCheck)
      .filter(([, r]) => r.hit < r.total)
      .map(([check]) => check),
    checksUncovered: INTEGRITY_CHECK_IDS.filter((id) => !perCheck[id]),
    rows: Object.fromEntries(
      results.map((r) => [
        r.id,
        {
          recallHit: r.recallHit,
          falsePositive: r.falsePositive,
          unexpected: r.unexpected.map((f) => `${f.slug}:${f.check}`),
        },
      ]),
    ),
  };
}

/**
 * Gate verdict. The pooled recall floor and the FPR ceiling are necessary but NOT sufficient, because
 * pooling is the wrong shape for a deterministic rule: with the corpus's per-check case counts, a
 * pooled 80% floor lets TWO entire checks stop detecting anything and still report PASS (measured —
 * killing `target-heading-depth` and `retarget-missing-evidence-change` outright leaves recall at
 * 10/12 = 83%). `target-heading-depth` is precisely the load-bearing one: a demoted heading makes a
 * record invisible to currentTarget(), so a silent regression there is the worst case, not a rounding
 * error.
 *
 * So the gate additionally demands, per check, what this suite's own docstring already asserts is
 * true of every check ("each check either catches the exact mutation it was built for, or it has a
 * bug"): NO check may miss any mutation built for it.
 *
 * `checksUncovered` is deliberately NOT part of this verdict. It asks a question about the CORPUS
 * ("has every declared check been given a case?"), not about measured performance, and the bench
 * already owns that question — main() folds it into the exit code alongside this. Keeping it out
 * here is what lets a focused summary over a single check still be a meaningful PASS.
 */
export function gatePassed(summary: SaveQualitySummary): boolean {
  return (
    summary.recallFloorMet &&
    summary.headlineFpr !== null &&
    summary.headlineFpr <= FPR_CEILING &&
    summary.checksRegressed.length === 0
  );
}
