/**
 * The ONE matching module: suffix-tolerant path overlap (shared by finalize.mts anchorCoverage,
 * kappa.mts, sources.mts diff relevance, counts.mts) and the FULL pre-registered sc-1119 match
 * rule (`matchFindings`, consumption contract README items 1–3) shared by kappa.mts, the bench
 * and the ceiling calibration. Separate implementations of "do these findings match" would drift,
 * and divergent matching logic is exactly the artifact class this pipeline exists to eliminate —
 * the kappa pilot showed matcher behaviour DOMINATES the benchmark's error budget. Node-clean.
 */

/** True when the two repo-relative-ish paths refer to the same file (suffix-tolerant: one side
 * may carry a longer prefix — absolute path, worktree root, a/ b/ header remnants). */
export const samePath = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a !== '' &&
  b !== '' &&
  // suffix matches must start at a path-separator boundary — raw endsWith would accept basename
  // substrings ("src/reindex.ts" vs "index.ts") and overstate coverage / mispair findings
  (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`));

/** How many entries of `files` match at least one entry of `others`. */
export const overlapCount = (files, others) =>
  (files ?? []).filter((f) => (others ?? []).some((o) => samePath(f, o))).length;

/** The ONE nameStatus → file-list parse (git name-status is tab-separated; rename lines keep the
 * NEW path). finalize.mts's coverage/demotion logic defines the corpus's own anchor semantics with
 * exactly this parse — counts/bench/noise-audit must not re-derive it differently. */
export const anchorFilesOf = (nameStatus) =>
  (nameStatus ?? '')
    .split('\n')
    .map((l) => l.split('\t').pop() ?? '')
    .filter(Boolean);

// ── the pre-registered match rule (contract README, "How sc-1119 must consume this") ────────────

const NON_WORD_RE = /\W+/;
const tokens = (s) =>
  new Set(
    (s ?? '')
      .toLowerCase()
      .split(NON_WORD_RE)
      .filter((w) => w.length > 2),
  );

/** Claim-token Jaccard — the item-1 fallback signal and the item-2 tie-break. */
export const claimJaccard = (a, b) => {
  const A = tokens(a);
  const B = tokens(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (A.size + B.size - inter || 1);
};

/** Every entry of `g.files` matched (suffix-tolerant) inside `j.files` — item-3's "covers".
 * Empty gold file lists never count as covered: ⊇ over ∅ is vacuously true and would let any
 * matched J harvest file-less findings it never located. */
const covers = (j, g) =>
  (g.files ?? []).length > 0 && g.files.every((f) => (j.files ?? []).some((o) => samePath(f, o)));

/**
 * The FULL pre-registered rule, one implementation:
 *  1. candidate match: same category AND file-set overlap; if a side has no files, fall back to
 *     claim-token Jaccard ≥ 0.35 and flag the pair `fuzzy`;
 *  2. tie-break one-to-one: greedy by (file-overlap count, claim Jaccard, severity agreement);
 *  3. one J counting two Gs ONLY when J's file set covers BOTH Gs' files (contract's literal
 *     wording — covering just the extra G is not enough): an unmatched gold G earns an
 *     `item3Credits` entry iff some greedy-matched same-category J covers G AND its own greedy
 *     match. Credits consume no judge finding and each gold is credited at most once, so
 *     precision accounting is untouched — they exist for RECALL only, and are reported
 *     separately because a broad multi-file J harvesting single-file golds is a gaming vector
 *     the credit share makes visible.
 *
 * Returns { pairs, item3Credits, unmatchedJudge, unmatchedGold }.
 */
export const matchFindings = (judgeFindings, goldFindings) => {
  const candidates = [];
  for (const j of judgeFindings ?? [])
    for (const g of goldFindings ?? []) {
      const files = overlapCount(j.files, g.files);
      const sameCat = j.category === g.category;
      const jac = claimJaccard(j.claim, g.claim);
      const emptySide = !(j.files ?? []).length || !(g.files ?? []).length;
      if (sameCat && files > 0) candidates.push({ j, g, files, jac, fuzzy: false });
      else if (emptySide && jac >= 0.35) candidates.push({ j, g, files, jac, fuzzy: true });
    }
  candidates.sort(
    (x, y) =>
      y.files - x.files ||
      y.jac - x.jac ||
      (y.j.severity === y.g.severity ? 1 : 0) - (x.j.severity === x.g.severity ? 1 : 0),
  );

  const usedJ = new Set();
  const usedG = new Set();
  const pairs = [];
  for (const c of candidates) {
    if (usedJ.has(c.j) || usedG.has(c.g)) continue;
    usedJ.add(c.j);
    usedG.add(c.g);
    pairs.push(c);
  }

  const item3Credits = [];
  for (const { j, g: greedyG } of pairs) {
    if (!covers(j, greedyG)) continue; // J doesn't cover its own match → it "covers two Gs" never
    for (const g of goldFindings ?? []) {
      if (usedG.has(g) || g.category !== j.category || !covers(j, g)) continue;
      usedG.add(g);
      item3Credits.push({ j, g });
    }
  }

  return {
    pairs,
    item3Credits,
    unmatchedJudge: (judgeFindings ?? []).filter((j) => !usedJ.has(j)),
    unmatchedGold: (goldFindings ?? []).filter((g) => !usedG.has(g)),
  };
};
