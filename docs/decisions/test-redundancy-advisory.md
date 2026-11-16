---
slug: test-redundancy-advisory
created: 2026-11-16
---

# test-redundancy-advisory

## Target · 2026-11-16 — devkit test-redundancy reports fallow's per-test kill evidence for changed test files, advisory only

**Context:** Agent-written PRs added tests whose every detectable failure another test already caught. benord-labs/frink#441 shipped 12 tests for a 15-line deletion and 4 were later removed by hand. The only control was a self-attested prompt rule (every extra test must name the distinct failure it catches), which the agent satisfied in prose for each redundant test. Every pipeline signal rewards adding tests: the diff-coverage gate, the evidence line's count of red-failing tests, and the critique schema's not-covered edge cases. Nothing measured whether a new test catches anything another test does not. Owner decision 2026-11-16: a new test is redundant when any existing test, unit or integration, already catches the same failures.
**Ruling:** devkit test-redundancy runs fallow mutation --kill-matrix-for on the test files a change touches, against the production files it touches (or the paths named after --), with the repo's own full runner config and --allow-dirty. It prints fallow's candidates as redundant and its coverage_without_kills as kills nothing, only for targets whose evidence fallow marks complete. It lists every flagged test in those files and does not say which tests the change added. A target with incomplete evidence, a fallow older than 3.40.0, a missing fallow, a fallow refusal, a wrong argument, an unresolvable base or a git failure prints not judged with the reason. The command always exits 0. fallow owns the verdict vocabulary; devkit never re-derives redundancy from raw kill counts.
**Consequences:**
- Positive: An agent or reviewer can measure, before shipping, whether a test protects anything, instead of asserting it. A cut-short or partial run reads not judged, never a pass, so the report cannot manufacture confidence.
- Negative: Comparing against the full suite is slow on a large consumer: on benord-labs/frink at d5b2236e, 242 mutants over 4 files did not finish in 15 minutes with fallow 3.41.0 and no test was judged, while a 3-test project finished in 1 second. Tests that guard data or a removal kill no mutant and need a human reason. fallow does not compute subsumers in target mode, so the report cannot name which test makes another redundant. The reader must tell from their own diff which flagged tests are new. Until the pinned fallow reaches 3.40.0 every devkit-installed consumer reads not judged.
**Vision-fit:** n/a — internal developer tooling
**Researched:** Prior-art 2026-11-16: fallow docs/mutation-testing.md and fallow-rs/fallow issues 4061 and 4588 (kill-matrix-for, shipped 3.40.0, built for trimming agent-added tests); StrykerJS killedBy with disableBail (Vitest 5 runner defects); mutant-subsumption literature covers redundant mutants, not redundant tests. Measured runs with fallow 3.41.0 on benord-labs/frink d5b2236e and a 3-test fixture. Autonomous report c7bcc6c1.
**Rejected:** (a) A prompt rule alone: it existed and was satisfied in prose. (b) Restricting the run to unit test files: minutes instead of an hour, but it contradicts the owner decision and fallow marks the run partial and names no candidates. (c) Marking the tests a change added by matching titles to added lines: three review rounds each found another way to mislabel a pre-existing test (a title inside a longer title, a title holding ' > ', a short title quoted elsewhere on an added line), and fallow reports no test line numbers. (d) A blocking gate: incomplete evidence is common under load, so a block would flake. (e) Re-deriving redundancy from unique_kills when fallow withholds candidates: equal kill sets would be misread.
**Anchored-bet:** [BET]
**Revisit-when:** A measured fallow release judges a frink-sized change inside a ship's time budget (then add an advisory ship stage), fallow reports subsumers in target mode, or fallow reports each test's source line (then mark added tests).
**Scope:** cli/commands/test-redundancy/**
**Source:** brainstorm · autonomous report c7bcc6c1
