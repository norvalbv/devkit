# Paired plan-uplift preregistration

This experiment asks one narrow question: does critique-driven revision improve a finalized plan
without creating compensating defects? It does not treat adoption of a suggestion as correctness.

## Locked design

- Unit of pairing: one proposal and its fixed gold flaw set. The generator produces the initial
  plan; the same proposal is then revised using one critique response. A two-pass arm is evaluated
  separately and runs a fresh critic only after a blocking first pass.
- The two-pass ceiling is an engineering safety bound under test, not a claim that one retry is
  optimal. No capture result may be reported as validating the schedule itself; graduation needs
  the paired quality, harm, cost, and latency outcomes below.
- Record `generatorModelFamily`, `criticModelFamily`, prompt/corpus hashes, cycles, tokens, and
  wall-clock latency. Same-family rechecks are labelled same-family refinement, never independent
  verification.
- Primary outcome: paired change in residual gold flaws (`refined - initial`, lower is better),
  reported as improved/worsened/tied rows with Wilson intervals and paired flips.
- Harm outcomes: newly introduced defects and revisions to sound plans. A revision to a plan whose
  gold flaw set is empty counts as a false revision even when a prose judge calls it harmless.
- Secondary outcomes: completeness on the locked rubric, exact-contract validity, cycles, tokens,
  and latency. Report each metric for all rows and separately for one-pass and two-pass arms.
- Outages are never imputed. A release-quality run requires K=3 generation/critique trials, audited
  scoring, fixed holdouts and hashes, and zero outages. Development runs may use K=1 but cannot
  authorize enforcement.

The shadow loop may graduate to hard plan-exit enforcement only after capture reliability and
contract validity are at least 95% on every supported provider, residual flaws improve in the
paired arm, introduced defects do not increase, and the sound-plan false-revision rate stays below
the preregistered 10% ceiling. Commit-reviewer injection remains a separate experiment requiring
control/treatment arms for every affected reviewer, including instruction-like adversarial cases.

Production evidence enters only a private candidate store. A human scrub and audit is required
before promotion into development or holdout corpora. Later PR, test, and incident outcomes may be
linked as evidence; parent-plan adoption is not a correctness label.

Rationale and priors: iterative feedback can improve outputs, but the result depends on grounding,
task, and model; none of these papers establishes a universal retry count. Self-Refine demonstrates
iterative refinement gains, CRITIC and ProCo strengthen correction with tools or explicit condition
verification, Huang et al. finds unsupported intrinsic correction can regress reasoning, and
CriticBench measures substantial task/model variation. See
[Self-Refine](https://arxiv.org/abs/2303.17651),
[CRITIC](https://arxiv.org/abs/2305.11738),
[ProCo](https://arxiv.org/abs/2405.14092),
[Huang et al.](https://arxiv.org/abs/2310.01798), and
[CriticBench](https://arxiv.org/abs/2402.14809).
