# Feature-critique of the plan (sonnet, read-only, 2026-08-22)

Critiqued the plan draft at `plans/before-we-do-that-zazzy-wombat.md` (Steps: multi-finding disclosure, truncation telemetry, scale-track benchmark with chunked arms, production chunking). All five blockers were folded into the approved plan.

## Findings

**BLOCKER 1 — Step 1's report redesign breaks `guard-review waive`.**
`gate-engine/review/overrides.mts:58-61`: `fingerprint(reviewer, lens, diffText)` — per (reviewer, lens, diff), never per-issue. Docstring line 15: "Granularity is per-lens-per-diff." `blockingNote()` (:310-322) prints the real waivable `[fp]` + exact `guard-review waive` command inside `res.reason`, which `run-review.mts:512-514` already emits today (`f.transcript` at :515 is the raw dump the plan actually targets). The draft proposed a header with a *different-formula* per-finding id `sha12(lens|file|floor(line/5))`; if `blockingNote`'s line is dropped, users copy the wrong id into `guard-review waive`, it passes `FINGERPRINT_RE`'s shape check (`valve/waive.mts:9-13`), persists, and never matches again. Even if kept: once a lens carries up to 3 issues, waiving its one shared fp waives all 3 at once — contradicts the valve's own premise (`overrides.mts:7-9`).
*Fix:* keep `blockingNote()`'s `[fp]`+waive-command verbatim in the new format; either make waiving issue-addressable or explicitly document/accept "waive-all-in-lens" semantics; never print the dedup id in `[…]`.

**BLOCKER 2 — "Existing seam" claim is false for real-repo materialization.**
`gate-engine/decisions/eval/bench.mts:231-267` `materializeFixture(row)` only `git init`s a fresh empty tmpdir from literal `row.repo.base/staged` content-string maps — no `base_sha`, no clone, no external-repo reference anywhere. "Local clone/worktree of the repo at base_sha, stage the diff" is 100% new code.
*Fix:* state Step 3a is net-new, budget LOC for it.

**BLOCKER 3 — `guard.config.json` injection always clobbers a real target-repo config.**
`gate-engine/review/eval/reviewers/corpus.mts:107-128` `buildAssets()` unconditionally sets `assets['guard.config.json'] = FIXTURE_CONFIG`. `bench.mts:225`: `repo: { base: { ...row.repo.base, ...assets }, staged: ... }` — `assets` spread last always wins. Pointing the harness at a real frink checkout as written silently selects reviewers/roots by devkit's synthetic config, not frink's.
*Fix:* special-case scale-track rows in `buildAssets`/`runRow` to skip or merge (never clobber) the config when a row supplies a real external `source`.

**BLOCKER 4 — Unscoped judge Bash/Read on a live private checkout; the privacy rule doesn't cover the artifact that leaks first.**
`.claude/agents/correctness-reviewer.md:4` grants `Read, Grep, Glob, Bash`; today's fixtures are hermetic. A real frink worktree as `cwd` gives the judge full reach into the private codebase. The draft's safeguard covered only minted corpus rows — not the probe's own committed result table. Precedent for the harm: `gate-engine/edge-cases/eval/cases.jsonl:44` names a real frink path with a vulnerability description. The cited safeguard was misattributed: `benchmarks-grow-from-telemetry.md` contains no anonymization language; that lives in `corpus-growth.md` (adapt stage) and the README Privacy boundary.
*Fix:* a real `guard-decisions` ruling on what a third-party row and the probe's committed table may retain; commit counts, not names.

**BLOCKER 5 — The plan's motivating diagnosis (Finding 1) was factually wrong.**
`.claude/skills/_devkit/checklist-store.mjs:100-104`: `checkItem` already does `if (!pass && failReason) item.issues.push(failReason)` — already additive, already unbounded — and `finalize()` (:107-119) already flattens `data.items.flatMap(i => i.issues)`. `gate-engine/review/evidence/items.mts:18-19,120-121` already hardcodes `ISSUES_PER_ITEM=3`/`ISSUE_CHARS=200`. The draft cited CLI arg-parsing (`checklist.mjs:227-236`), not the mutator — the observed one-issue behaviour is a *prompt* convention, not a code cap. `GUARD_REVIEW_MAX_ISSUES_PER_LENS` is genuinely new but must thread through the **shared** `checklist-store.mjs` used by 6 reviewers, reconciled against `items.mts:19`.
*Fix:* rewrite Finding 1 and Step 1 as: brief edit (search exhaustively) + a cap in `checkItem` reconciled with `items.mts:19` + the report formatter. `split.mts`'s `mergeLensOutcomes`/`mergeItemVectors` already handle multi-issue merge.

**MAJOR 6 — Step 3b re-opened an already-UNRESOLVED, underpowered axis.**
`docs/decisions/correctness-lens-split-ab-unresolved.md`: registered 2-way arm UNRESOLVED at 140 rows/arm; needs ~4× more rows. Crossing "lens split on/off" against chunk-size × model in a 10–20-diff corpus is an order of magnitude below that. *Fix:* fix lens-split at shipped-on for the scale track.

**MAJOR 7 — sc-1476 is the mechanism, not a footnote.**
`review-gate-in-chain.md` (sc-1476 note) + `run-review.mts:108,144,465` + `recovery/settle.mts`: haiku-judge checklist compliance degrades under *concurrent* judge load. Haiku-per-chunk and `MAX_CHUNKS=4` raise exactly that load. *Fix:* checklist-void/recovery rate as a guardrail metric; Step 4 must show `settle.mts` scales.

**MAJOR 8 — Rejected-(a) narrowing sidesteps the actual mechanism.**
`ship-gates-converge-not-restart.md` Rejected (a): finding *volume* confuses agents, not reviewer count. *Fix:* explicit rollback trigger tied to confusion proxies.

**MAJOR 9 — Probe's pre-registration exemption was implicit; `bench-gates-on-flips-not-deltas.md` scope is the decisions bench, not the reviewer bench.** *Fix:* state the probe is an informal go/no-go; expansion triggers pre-registration.

**MAJOR 10 — `lens/chunk.mts` doesn't exist; framed as reuse.** *Fix:* net-new.

**MAJOR 11 — No dry-run path; harness bring-up costs real judge $.** *Fix:* `--dry-run`/mock exec first.

**MINOR 12–17:** `diff-evidence.mts` lives at `gate-engine/review/diff-evidence.mts`; the ~4pp noise floor is from `benchmarks-grow-from-telemetry.md`'s 2026-08-02 note; `zero-consumer-tool-deps` is not the risk in play; "haiku only as bench arm" is an inference from `correctness-reviewer-precision.md`, not a quoted ban; `mine-bots.mts` export shape unverified for comment mining; `commit_ships`=67 rows for the frink branch, the local frink clone, and `mine-telemetry-lib.mts:140/:227` citations independently confirmed.

## Verdict

RETHINK Step 3 as drafted (two code-level blockers + two policy blockers); Step 1 PROCEED_WITH_CHANGES (fix diagnosis + waiver interaction); Step 2 (telemetry) ship first unchanged. Reorder: telemetry → disclosure → data-handling ruling → scale track (lens split fixed on) → probe → production chunking gated on a properly-powered confirmation.
