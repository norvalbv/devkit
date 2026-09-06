# Ship fixture setup cost

The shared ship fixtures started an extra Node process supervisor for every initialization command. Setup now calls each Git command directly with a 90-second native timeout, before test hooks are installed. Actual test commands and hook-dispatching commits retain their existing supervisors and deadlines. Arguments remain arrays; there is no intermediate shell to interpret branch/origin values or outlive a timeout.

Five alternating baseline/candidate pairs measure the eight-command initialization in `seedShipRepo`. Every sample checks the same committed tree, branch, hooksPath, origin and clean status; the matching state is recorded as a sanitized hash. Child CPU includes user + system time. Vitest startup, hook installation, verification and cleanup are outside the timed phase.

| Initialization phase | Baseline median | Candidate median | Reduction |
|---|---:|---:|---:|
| Child-process CPU | 753.844 ms | 143.530 ms | 81.0% |
| Elapsed time | 738.727 ms | 231.705 ms | 68.6% |
| Supervisor starts | 8 | 0 | 100% |

These are fixture-phase results on a shared machine, not a full-suite speedup claim. Regression tests exercise literal arguments, the real ship resolver and a blocking commit hook.

Reproduce from the repository root with `python3 docs/benchmarks/vitest-fixture-benchmark.py`. Its stdout contains all samples, source/environment metadata and candidate/baseline median ratios. Suite `vitest-fixture-setup` uses the [append-only ledger](history.jsonl) and immutable content-addressed checkpoints; [the baseline view](vitest-fixture-results.json) is checked against its checkpoint. Earlier measurements remain as superseded evidence. The current result measures direct native Git calls; the baseline supervisor owns its deadline, so an outer timeout cannot interrupt its process-tree cleanup.
