# Pre-registration: correctness lens split (A/B)

> Written BEFORE any bench run, per honest-measurement rule 3 and
> [`bench-gates-on-flips-not-deltas`](../decisions/bench-gates-on-flips-not-deltas.md). Registering
> the stopping rule after seeing the numbers is how a null becomes a "trend".

## Hypothesis

The correctness reviewer holds four lenses in one judge pass. Splitting them across two judges
(two lenses each) reduces attention dilution and improves the measurably weaker pair
(`writer-reader-contracts`, `error-and-edge-classification`) without degrading the stronger pair
(`concurrency-races`, `state-transitions`).

## Prior (the motivation, and its limits)

From the 128-row checkpoint `evt-2026-08-02-reviewer-correctness-…`, joined to
`cases-correctness.jsonl` — golds by `expectItems`, decoys by `variantOf` → gold's lens with a
shared-`caseId` fallback (**50 of 65 PASS rows are mappable**; 15 of 59 clean checkpoint rows are
not, because no PASS row carries `expectItems`):

| lens | recall | n | clean-pass | n |
|---|---|---|---|---|
| concurrency-races | 0.90 | 10 | 1.00 | 5 |
| state-transitions | 0.89 | 19 | 0.85 | 13 |
| writer-reader-contracts | 0.76 | 17 | 0.75 | 12 |
| error-and-edge-classification | 0.74 | 23 | 0.79 | 14 |

Pooled: strong 0.90 recall / 0.89 clean-pass; weak 0.75 / 0.77.

**Confounds tested and rejected.** Difficulty does not explain the spread — the *strong* pair
carries the higher hard-row share (0.60 / 0.53 vs 0.39 for the weakest lens), pooled recall is flat
across difficulty (clear 0.794, borderline 0.786, adversarial 1.000), and stratified the effect is
LARGER than crude (Mantel-Haenszel OR **2.69** favouring the strong pair). Provenance explains ~1pp
of 15 (mined-only: 0.875 vs 0.737).

**The real limit is power, and it is severe.** Fisher exact two-sided **p = 0.21** at n=69. Weak-pair
denominators are 40 gold / 26 mappable decoy rows, so at the repo's ~5-net-flip resolution floor a
+10pp move is **4.0** net gold corrections and **2.6** net decoy corrections — *both below the floor*.
**This A/B is underpowered by construction and cannot, on the current corpus, certify the effect it
is testing.** It is registered anyway because the shape is cheap to run alongside other work and a
large surprise would still be informative — but see the stopping rule.

## Arms

- **A (control):** `GUARD_CORRECTNESS_SPLIT` unset — today's single-pass monolith. Section key
  `correctness-reviewer@sonnet@cascade-off` (byte-identical to existing baselines).
- **B (treatment):** `GUARD_CORRECTNESS_SPLIT=1` — two groups of two. Section key gains
  `@split:concurrency-races+state-transitions_error-and-edge-classification+writer-reader-contracts`.

Four-way (`GUARD_CORRECTNESS_SPLIT='a|b|c|d'`) is implemented but **deliberately not the registered
arm**: it costs 4x judge calls and compounds the measured 4.2% single-judge inconclusive rate to
~15.8% on strict ships, to decide a question the denominators cannot decide.

## Metrics, declared in advance

- **Co-primary 1 — first-pass recall on weak-pair gold rows** (n=40).
- **Co-primary 2 — first-pass clean-pass on weak-pair decoy rows** (n=26 mappable). This is
  co-primary, not secondary: `correctness-reviewer-precision` names precision as the actual problem,
  and a narrower judge has *more* chances to violate the brief's "stay SILENT (pass the lens)" rule,
  so the split could plausibly make the recorded problem worse.
- **Guardrail — strong-pair recall and clean-pass** (n=29 / n=18). A split that trades the strong
  pair down is a loss even if the weak pair improves.
- **Cost — total judge seconds per row** (the merged `secs` sums across groups, deliberately).

Decided by the per-row **McNemar flip table** (mid-p, pooled + gold-only + decoy-only +
clustered-by-case), never by aggregate deltas.

## Stopping rule, committed in advance

1. **A null does NOT close the axis.** Honest-measurement rule 1: fixtures are 1–2 files ≤25 lines
   while production correctness inputs average ~7.9 files / 26 KB. Attention dilution is precisely
   the mechanism a 25-line fixture cannot express. A null here means *"the instrument could not
   see it"* at least as much as *"it is not there"*, and must be reported that way.
2. **Ship only on:** weak-pair improvement that clears the flip floor in the same direction on at
   least one co-primary, AND no guardrail regression clearing the floor against it.
3. **Abandon on:** any guardrail regression clearing the floor, or a clean-pass regression on the
   weak pair (the split would then be worsening the recorded problem).
4. **Otherwise — the expected outcome — record UNRESOLVED**, leave the flag default-off, and treat
   corpus growth toward the weak lenses as the precondition for re-running. Do not re-run the same
   underpowered comparison and read a second null as confirmation.

## Known measurement debt this A/B does not discharge

- **Run-to-run reviewer variance is unmeasured and may dominate.** Two checkpoints with an
  *identical* implementation hash differ on 10 of 90 shared rows (~11%, symmetric 5/5). That is
  additive to the 4.2% label-noise floor and larger than the effect being chased. **Measure it
  first** (same corpus, same reviewer, twice) — otherwise this A/B's flip table cannot be
  distinguished from noise.
- No cross-lens decoy slice exists: rows whose gold is lens A, scored on whether the lens-B judge
  stays silent. That is the direct test of the split's precision risk and should be added to the
  corpus before the split is taken seriously either way.
