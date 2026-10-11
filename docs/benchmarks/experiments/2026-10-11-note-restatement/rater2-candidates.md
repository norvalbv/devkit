# Second-rater sheet: 15 decision-log notes

This is stage 1 of the second rater's work for the pre-registered experiment in [README.md](README.md).
Read only this file. Do not open `cases.jsonl`, the gold sheet, or this folder's git history until
your answers are committed: they hold the first rater's labels.

Each item is one dated NOTE written under a decision's RULING in devkit's decision log, at commit
c29e78e6. The ruling's sentences are numbered S1, S2, … with the split the CLI uses
(`Intl.Segmenter`). That split sometimes breaks inside code, for example at `!==`: when a claim
spans two numbered pieces, name both. A `\<` in the text is a literal `<`, escaped so a markdown
renderer keeps it.

For each item:

1. Label the note against the ruling with this rubric, the same one the experiment's writers get:
   - L = log: an implementation/convergence record, incident report, measurement or rationale that is consistent with the ruling. An engineer who read only the RULING would not act wrongly.
   - E = extend: the note adds a binding constraint (must / never / always / only, or a named mechanism that must be used) on the ruling's subject that the RULING text does not state.
   - N = narrow: the note carves out an exception, or limits where the ruling applies.
   - W = walk back: the note reverses, retires or replaces a clause of the RULING.
2. If you label it W, name every ruling sentence the note makes false: the sentence(s) a correct
   restatement of the ruling must not keep word for word. A sentence the note only adds to, or that
   stays true, is not stale. For L, E and N, answer `-`.

Answer one line per item, in this order, in this format:

```
<id> <L|E|N|W> <stale sentence numbers, comma-separated, or -> [optional comment]
```

For example: `some-axis#3 W S2,S4 the note retires the 30s cap`.

A note is confirmed as a walk-back only when both raters label it W and name at least one common
stale sentence; any other answer drops it from the walk-back set. There is no right number of W.

## bench-gates-on-flips-not-deltas#0 (note dated 2026-07-25)

RULING:

- S1: The --fail gate evaluates, in order: comparability preconditions (config + gate-code hash + corpus hash mismatches SKIP the comparison mechanically), hard floors on the safety metrics (DECISION recall / CONTRADICT precision / depth accuracy \< 0.75 fail immediately), then the per-row FLIP TABLE vs baseline judged by a mid-p McNemar test (p\<0.05, ~5+ net one-directional flips) counting only STABLE flips (unanimous across BENCH_RUNS=3 majority-vote trials for detect/depth; retry-confirmed 2-of-2 for alignment).
- S2: Aggregate deltas print as informational only; every metric ships raw counts + a Wilson 95% interval plus an MDE line; every run appends to the runs.log ledger and post-fix rows enter as holdout.

NOTE:

> Ordering defect, not a re-target: the recorded order evaluated comparability preconditions BEFORE the hard floors, so compare() returned regressed:false at the no-baseline early return and the floor check below it was unreachable. results.baseline.json is gitignored ('no baseline ships — each consumer generates theirs'), so in practice 'bench all --fail' exited 0 in every repo without a locally-generated baseline, no matter how badly a judge broke — the floors were dead code the whole time. A floor is absolute (a property of THIS run, needing no predecessor), so it now precedes every early return, including a comparability skip; only the flip table still requires a comparable baseline. The Target's substance is unchanged and in fact restored: gate on floors + the per-row mid-p McNemar flip table, aggregate deltas informational only. Also: --fail with no baseline now exits NON-ZERO ('cannot verify' is not 'verified fine'), and compare's lines are printed even when no baseline file exists (they were being swallowed, hiding a floor breach). Tests updated to separate 'the comparison is skipped' from 'the floor still fires'.

## correctness-chunking-ships-dark#0 (note dated 2026-08-25)

RULING:

- S1: planReviewWork chunks the correctness reviewer when GUARD_CORRECTNESS_CHUNK=\<loc> is set AND identity bytes exceed 1.5x the cap: local lens groups fan out per whole-file next-fit chunk AT THE CONFIGURED CAP — MAX_CHUNKS=24 is a safety backstop (largest benched diff packs 18 at cap 400), not policy; repack-at-doubled-caps fires only past it.
- S2: Concurrency is bounded by the runner's judge pool (reviewConcurrency, default 6), never by coarsening chunks. writer-reader-contracts stays whole-diff sharing the un-chunked key; per-chunk checklist state (+c\<n>); OFF stays byte-identical (kill switch).
- S3: Target live config: gpt-5.6-sol at cap 400 — armed only after sc-2073 lands (warehouse consumer guards), since arming first corrupts the weekly mining corpus.

NOTE:

> sc-2107 (owner ruling 2026-08-25, follow-through of the arm-sol@400 target): the owner RULED the benched winning condition should become the shipped default (DEFAULTS.review sol/sol/400) — an intent the completeness judge blocked before it ever shipped (codex parity gaps, sc-2054); the split note below records what actually shipped, resolution env > guard.config.json > default per installation. The correctness sonnet pin is now config-resolved at selectReviewers (single-pass semantics preserved; sonnet was the haiku-era value). The judging model joined the verdict-cache salt (reviewerTargetSalts) so a PASS earned by one model cannot replay for another — the sc-2053 precondition for any model flip; the flip invalidates existing cached verdicts once, deliberately. Env vars remain the kill switch: GUARD_CORRECTNESS_CHUNK=off restores byte-identical un-chunked keys, GUARD_REVIEW_MODEL/GUARD_CORRECTNESS_MODEL restore claude models on installs without the codex CLI.

## correctness-chunking-ships-dark#2 (note dated 2026-08-25)

RULING:

- S1: planReviewWork chunks the correctness reviewer when GUARD_CORRECTNESS_CHUNK=\<loc> is set AND identity bytes exceed 1.5x the cap: local lens groups fan out per whole-file next-fit chunk AT THE CONFIGURED CAP — MAX_CHUNKS=24 is a safety backstop (largest benched diff packs 18 at cap 400), not policy; repack-at-doubled-caps fires only past it.
- S2: Concurrency is bounded by the runner's judge pool (reviewConcurrency, default 6), never by coarsening chunks. writer-reader-contracts stays whole-diff sharing the un-chunked key; per-chunk checklist state (+c\<n>); OFF stays byte-identical (kill switch).
- S3: Target live config: gpt-5.6-sol at cap 400 — armed only after sc-2073 lands (warehouse consumer guards), since arming first corrupts the weekly mining corpus.

NOTE:

> sc-2054 (2026-08-26): codex parity landed — MCP profile injection (see judge-mcp-profiles) plus staged-tree tamper detection in run-review (git write-tree before/after the judge wave; any change blocks every verdict — detection where codex's always-writable cwd makes prevention impossible). With the parity preconditions met, DEFAULTS.review flipped to gpt-5.6-sol/gpt-5.6-sol/400 as the sc-2107 AC prescribed; devkit's own guard.config.json dropped its now-redundant explicit keys. Claude-era rollback stays one config/env override; codexRuntimeResult doctor DRIFT covers codex-less installs.

## correctness-lens-hole-instrument#3 (note dated 2026-09-06)

RULING:

- S1: Lens holes are MEASURED before any lens is added, with one reusable reducer (external/holes.mts): a second detector's labelled findings are joined to what the correctness reviewer held in scope, saw in full, and said on the same change, and every miss is partitioned not-reviewed / not-in-scope / evidence-uncertain / in-evidence-unmatched / matched BEFORE any lens attribution.
- S2: CodeRabbit categories on devkit's own repos are the primary instrument ($0, 100% marker parse, verification-trace roots dropped); Martian Code Review Bench goldens are a confirmatory external precision/recall probe and a source of miss candidates only.
- S3: Only in-evidence-unmatched misses feed the lens question; attribution uses a pre-registered rubric (the four brief definitions plus an explicit none) whose light-judge triage must reach kappa >= 0.6 against hand labels before its column counts.
- S4: A fifth lens is warranted only when a class no existing checklist names holds a clear majority of eligible misses (category denominator >= 8 catchable) across both sources AND a prompt-bullet A/B under the nearest existing lens, run on the re-baselined corpus, fails to recover them.
- S5: Measurement runs now; the verdict waits for the re-baseline (sc-2494).

NOTE:

> sc-2872 v2 applies this existing criterion to the owner question about a fifth lens: no new category is added from repeated false-positive anecdotes. The planned B/P/L/C comparison retains four lenses and will preserve each lens's unique valid mechanisms, overlap, invalid/unresolved occurrences, misses and judge time separately from raw FAIL counts. L tests a conditional-rule bundle within existing scope. Seven unvalidated synthetic mechanism rows cannot establish the cross-source eligible-gap, triage-agreement or nearest-lens amendment conditions in this Target; the original historical triage limitations remain. All measurement is owner-paused. [Comparison and lens criteria](../benchmarks/experiments/2026-09-06-correctness-reachable-witness/comparison.md).

## decision-format-parsed-not-regexed#0 (note dated 2026-07-26)

RULING:

- S1: Markdown structure is read by mdast-util-from-markdown in one module (gate-engine/decisions/markdown.mts), which is the only place permitted to know markdown layout.
- S2: A section is 'this heading until the next heading', read off parser node offsets rather than inferred, so a boundary cannot be half-right.
- S3: Retrieval consumes sections(); sliceToNextHeading, upToFirstNote and every lastIndexOf offset walk are deleted.
- S4: Frontmatter stays hand-rolled — it parses exactly the two documented fields.

NOTE:

> Scope correction: the parser landed at gate-engine/decisions/recall/{markdown,retrieval,qualifiers}.mts, not the paths this Target's Scope names. The folder-fanout ratchet capped gate-engine/decisions at 12 impl files and markdown.mts made 13, so the recall trio moved into its own cohesive subfolder. Also dropped sectionByHeading from markdown.mts: it was exported but never called, and its doc argued for exact-heading matching while the caller deliberately takes the LAST same-date heading — a dead export whose comment contradicted live behaviour is worse than no export. Recorded rather than silently corrected because the Scope glob is what the alignment gate matches on.

## decision-retrieval-tier-fusion#0 (note dated 2026-07-26)

RULING:

- S1: Both tiers run over the same candidates and are fused by Reciprocal Rank Fusion (score = SUM of 1/(60+rank)), K=60 from Cormack et al. 2009 and deliberately untuned at this corpus size.
- S2: Fusion is strictly better than either tier on the suite: containment SINGLE 8/8, Buried-by-rank 1/8, SetRecall 3/4, PartialRecall 87.5% — beating BOTH parents on multi-axis.
- S3: Abstention, however, is computed from the PRE-FUSION lexical top-1 score, never the fused score: RRF is rank-only by construction and throws away the magnitude a confidence threshold needs.
- S4: Degradation to a single tier is announced on stderr, and the result's source field reports hybrid, lexical or semantic so a caller can see which path ran.

NOTE:

> Correction to this Target's wording: 'strictly better than either tier' overstates it. Fusion TIES the semantic tier on Containment@5 SINGLE (8/8 vs 8/8) and wins outright only on the multi-axis family (SetRecall 3/4 vs 2/4 lexical and 1/4 semantic; PartialRecall 87.5% vs 75% and 62.5%). That family is 4 MULTI cases carrying 8 required-axis slots in total, so the three PartialRecall figures are 7/8, 6/8 and 5/8 — the whole result rests on ONE additional axis retrieved, and the Wilson interval on SetRecall 3/4 is [30, 95]. The ruling to fuse rather than ladder still holds, because the tiers demonstrably fail on different cases, but the size of the win is not established at this corpus size. Read as: matches or exceeds both tiers on every measured metric, beats both only on multi-axis.

## gate-verdict-attribution#5 (note dated 2026-10-01)

RULING:

- S1: A verdict-producing gate emits its INPUTS and its non-runs, not only its outcomes.
- S2: (1) Every SELECTED reviewer emits review_scope BEFORE the judge runs — files, diff_sha256, file count and hash, and cached — so a cache hit is attributable on the same footing as a live run.
- S3: (2) Every reviewer that did NOT run emits review_skipped with the reason (gate_disabled, no_llm, GUARD_REVIEW_SKIP, not_selected), so non-selection is a row and never an absence.
- S4: (3) Every verdict carries prompt_identity: the same hash formula as the review-mode packaged preflight, computed over the SYNCED consumer assets on the commit/ship path, so a production rate and a bench baseline are comparable when the bytes match.
- S5: (4) The per-lens checklist vector rides on review_result INCLUDING the passes, with each failing lens attributed to what the gate did with it (blocking, waived, dropped_out_of_charter).
- S6: Absent items means no artifact — a different fact from an artifact with zero failures.

NOTE:

> prompt_identity on the commit/ship path now hashes the assets the brief resolver picked (consumer override, else the running package) instead of only the synced consumer copies, so a checkout with no .claude projection is attributable rather than null. Rule recorded in review-gate-in-chain.

## judge-outage-classified-not-blocked#1 (note dated 2026-09-03)

RULING:

- S1: A judge outage is CLASSIFIED at the failure site, not guessed at, and reachability is REPORTED before the chain but never enforced there. classifyJudgeOutage (gate-engine/judge/outage.mts) splits absent / unauthenticated / rate-limited out of the fused offline/quota/absent label using only the provider's own channels — the structured turn.failed event and stderr, never the Node error message, which renders the judge's argv and therefore the staged diff.
- S2: Every classification is positive-signal-only: an unrecognised failure stays transient.
- S3: Each kind carries 'permanent', the single input to every retry predicate, replacing the cascade's firstOutage !
- S4: == 'timeout' test.
- S5: A ship-time preflight reads codex app-server account/rateLimits/read (non-billed, ~1s, answers while inference is refused) and prints provider, model, window use and reset per ROLE — then continues unconditionally.

NOTE:

> The Ruling above names classifyJudgeOutage at gate-engine/judge/outage.mts and the preflight at cli/lib/ship/judge-preflight.mts. Both were renamed inside the same change: devkit's own fan-out gate refused a 13th impl file in gate-engine/judge and in cli/lib/ship, so the classifier split into gate-engine/judge/outage/{classify,wording}.mts and the preflight moved to cli/lib/ship/preflight/judge.mts. The shipped paths are those; the Scope note above is the operative one. Recorded rather than rewritten because committed Targets are append-only.

## judge-outage-classified-not-blocked#16 (note dated 2026-09-30)

RULING:

- S1: A judge outage is CLASSIFIED at the failure site, not guessed at, and reachability is REPORTED before the chain but never enforced there. classifyJudgeOutage (gate-engine/judge/outage.mts) splits absent / unauthenticated / rate-limited out of the fused offline/quota/absent label using only the provider's own channels — the structured turn.failed event and stderr, never the Node error message, which renders the judge's argv and therefore the staged diff.
- S2: Every classification is positive-signal-only: an unrecognised failure stays transient.
- S3: Each kind carries 'permanent', the single input to every retry predicate, replacing the cascade's firstOutage !
- S4: == 'timeout' test.
- S5: A ship-time preflight reads codex app-server account/rateLimits/read (non-billed, ~1s, answers while inference is refused) and prints provider, model, window use and reset per ROLE — then continues unconditionally.

NOTE:

> sc-3207: the preflight lock predicate also accepts a spent WINDOW. parseRateLimitsReply now reads primary AND secondary and sets reached when rateLimitReachedType is present OR either window's usedPercent >= 100 with no usable credits (credits.unlimited/hasCredits strictly true), reporting the exhausted window with the later reset. Why: rateLimitReachedType is nullable upstream (backend maps Unknown to None) and was absent on a locked account, so a 100% window read 'reachable' and a ship paid a full attempt before the remedy; codex's own TUI (rate_limits.rs) and openclaw use the same 100%-on-either-window cap. Still positive-signal-only and advisory: the verdict is relabelled 'EXHAUSTED — USAGE LIMIT REACHED' and the percentage floors so 99.6 cannot print as 100% reachable.

## oxc-toolchain-migration#1 (note dated 2026-10-06)

RULING:

- S1: The consumer's ignores are part of the ANTI-SLOP entry, and only of it.
- S2: While anti-slop is selected, the git-excluded root entry oxlint.devkit.json is the Devkit base plus the consumer's own ignorePatterns, copied from a single JSON/JSONC Oxlint config (.oxlintrc.json, .oxlintrc.jsonc); the consumer config is deliberately NOT extended.
- S3: Anti-slop installs over such a repo instead of refusing.
- S4: It refuses only when those ignores cannot be read faithfully: a JS/TS config, more than one config, a config that cannot be read, one that is not a JSON object, or one whose ignorePatterns is present but not a list of strings.
- S5: A config with no ignorePatterns is readable, with nothing to copy.
- S6: The check runs inside the locked Oxc writer from one read of the config, on every sync with anti-slop selected, so install, upgrade and doctor --fix fail loudly rather than write an anti-slop entry without the ignores.
- S7: While anti-slop is NOT selected the entry is the plain base exactly as before this ruling, whatever the consumer owns: nothing reads it then, because only the anti-slop runner and its probe pass -c, and selecting anti-slop re-runs the refusing check before any gate can. doctor's 'oxlint discovery' row follows the same split: with anti-slop selected it is OK only while the entry on disk matches the consumer's current ignores and DRIFT (not fixable) when the entry is missing or stale or the config is unreadable; with anti-slop off it is OK.
- S8: Everything else in the 2026-09-03 Target stands: root entry geometry, the split mode signal, the per-clone baseline, refusal when git tracks an owned path, and the printed weaker contract.

NOTE:

> sc-4694 gives overlay the same inherited base allowance as package mode: inheritedBaseAllowance and the capability pin now need only the base tree, not a committed baseline at it, so findings already resident at HEAD are forgiven (and named) instead of reported as new against an aging per-clone baseline. A version bump that forces a whole-repository scan no longer blocks on debt other clones merged. Package mode's bootstrap commit (no baseline at HEAD yet) gains the same forgiveness. Overlay still has no shrink-only ratchet, rename receipts or CI monotonicity.

## qavis-advisory-gate#0 (note dated 2026-07-22)

RULING:

- S1: Split by ownership. (1) qavis owns the classifier (`route --staged|--diff --gate`, a haiku judge that reads the diff — bench-picked at recall 0.96 / false-advise 0.00, clearing the floors regex can't) and a content-addressed pass-receipt (`.qavis/receipt.json`, sha256 over each changed file's blob sha, so a staged index and an identical committed tree match). (2) devkit is a THIN CHANNEL: `gate-engine/qavis-advisory` shells `qavis route --staged --gate`, and fail-OPENS (exit 0) when qavis or a `.qavis/recipe.json` is absent — the fallow precedent, zero weight for non-qavis consumers.
- S2: (3) The exit contract is advisory: 0 = continue (SILENT / advisory-only on a normal commit / receipt-cleared / qavis absent), 3 = ADVISE under a strict ship (`GUARD_AI_STRICT`) — the ship blocks until qavis runs (writing a receipt that clears it) or an override is set.
- S3: There is NO exit 1 and NO fail-closed on outage (unlike completeness): an advisor's own failure must never block a ship.
- S4: Overrides: `GUARD_QAVIS_OK=1` ships without QA, `GUARD_NO_QAVIS_ADVISORY=1` disables.
- S5: Wired as its own husky fragment (bunx/standalone/overlay) with its own remedy line, NOT an AI_GUARD (different exit contract).

NOTE:

> Fail-open stays exit 0 but is now LOUD: when the advisory cannot run, the gate prints one stderr line naming WHY (qavis not on PATH / route failed / unparseable verdict) instead of returning a bare null that read exactly like SILENT. defaultRoute now returns a RouteResult whose null arm carries the reason, so there is one printer and no detail is discarded; ENOENT is discriminated from a qavis that ran and failed. Silent fail-open made a dead gate indistinguishable from 'nothing to QA'.

## ship-gates-converge-not-restart#11 (note dated 2026-08-05)

RULING:

- S1: Ship retries CONVERGE instead of restarting: (1) reviewer PASSes checkpoint per-completion, (2) an all-green deterministic prefix is cached on the staged tree hash (`guard-prefix`, armed only under `DEVKIT_SHIP=1` where worktree ≡ index), (3) decisions ROUTINE/ALIGN/depth-PASS verdicts are cached on their exact evidence bytes, (4) deterministic gate failures AGGREGATE into one report while AI gates stay fail-fast, and (5) under `GUARD_AI_STRICT=1` (exported only by ship) the reviewer gate's sonnet first pass retries once and an inconclusive-after-retry FAILS CLOSED with exit 3 — a code distinct from exit 1 so hooks never render an outage as an opus-confirmed FAIL; the decisions judges fail closed WITHOUT a retry (deliberate: retries there erode the ceiling for little value — alignment outage exits 3 named, detect's outage keeps its regex block standing but labels it UNVERIFIED with a remedy).
- S2: Default `SHIP_COMMIT_TIMEOUT` rises to 1800s with the honest full-chain equation documented; the timeout banner names the mid-flight stage + unfinished reviewers and says "re-run to converge".

NOTE:

> The Ruling's '1800s' and the 2026-07-04 note's 'the 1800s ceiling is unbroken' are both STALE: run-gates-with-capture.sh has defaulted SHIP_COMMIT_TIMEOUT to 3600 since 0d759d4 (2026-07-13), which raised it with no Target and no note. Recovering the evidence rather than ratifying the drift: that commit raised the correctness reviewer's FIRST/STRICT_FIRST/ESCALATE caps 300s/420s to 30 min because its four-lens investigation legitimately ran past 420s and was SIGKILLed mid-verdict (usage-tracker showed repeated 421s inconclusive timeouts against a ~60-250s median; it was the only reviewer hitting the cap). 1800s could no longer contain one 30-min reviewer plus the fast ones, so the outer ship ceiling would have killed the chain first. 3600 is therefore the ruled value and consistent with the anchored bet — still a hang guard, not a schedule. Unchanged by this note: a judge that times out is never re-run, so a stuck judge still costs at most one cap.

## ship-gates-converge-not-restart#35 (note dated 2026-10-06)

RULING:

- S1: Ship retries CONVERGE instead of restarting: (1) reviewer PASSes checkpoint per-completion, (2) an all-green deterministic prefix is cached on the staged tree hash (`guard-prefix`, armed only under `DEVKIT_SHIP=1` where worktree ≡ index), (3) decisions ROUTINE/ALIGN/depth-PASS verdicts are cached on their exact evidence bytes, (4) deterministic gate failures AGGREGATE into one report while AI gates stay fail-fast, and (5) under `GUARD_AI_STRICT=1` (exported only by ship) the reviewer gate's sonnet first pass retries once and an inconclusive-after-retry FAILS CLOSED with exit 3 — a code distinct from exit 1 so hooks never render an outage as an opus-confirmed FAIL; the decisions judges fail closed WITHOUT a retry (deliberate: retries there erode the ceiling for little value — alignment outage exits 3 named, detect's outage keeps its regex block standing but labels it UNVERIFIED with a remedy).
- S2: Default `SHIP_COMMIT_TIMEOUT` rises to 1800s with the honest full-chain equation documented; the timeout banner names the mid-flight stage + unfinished reviewers and says "re-run to converge".

NOTE:

> Correction to the Ruling's clause (3), which lists ALIGN and depth-PASS among the verdicts cached across ship retries. No devkit-generated hook or ship script calls check-alignment, so in a generated ship chain only detect's ROUTINE verdict is produced and cached. The ALIGN and depth caches are real code and serve on-demand and hand-wired runs of the command, which is where the alignment timings cited in the 2026-07-27 note came from. The axis alignment-judge-on-demand records why the command is not wired.

## test-suite-inherits-no-gate-policy#0 (note dated 2026-09-04)

RULING:

- S1: devkit own test processes inherit NO run authority from whatever launched them. vitest.setup.mjs deletes an explicit, named list of ship/review authority variables before any test module loads (setupFiles runs per worker ahead of the first import, so even a top-level process.env capture sees the cleaned env), and both vitest configs share that one file.
- S2: The list is the same vocabulary cli/lib/ship/review-target.sh unsets, bound to it by a parity test so the two can never drift; membership is reused, the reason is not (that script prevents inheriting a FOREIGN run authority).
- S3: Deliberate invocation knobs are never scrubbed: SHIP_COMMIT_TIMEOUT and DEVKIT_PREFLIGHT_TIMEOUT are inputs a caller chose.
- S4: A test that needs a policy var sets it explicitly.
- S5: The guarantee is about INHERITANCE, not visibility - a per-worker setup file cannot undo a test that sets a var mid-file and never restores it.

NOTE:

> sc-2259 follow-up — the Target's ruling said the scrub list IS review-target.sh's vocabulary; edge-case testing showed that list is not a superset of what a ship actually exports, so the first implementation was a partial fix. ship-branch.sh additionally exports DEVKIT_SHIP_BRANCH, DEVKIT_SHIP_DRY_GATES, DEVKIT_SHIP_FROM_BRANCH, DEVKIT_SHIP_INTENT_RECORDED, DEVKIT_SHIP_PATHS, DEVKIT_SHIP_REPO, DEVKIT_SHIP_RESUMED and DEVKIT_SHIP_ROOT, none of which review-target.sh unsets because it guards a review ENTRYPOINT rather than the downstream tree. Four of those are read at runtime and are not inert: qavis-advisory shipMode() branches on DEVKIT_SHIP_ROOT and then runs git -C against that path, and review completeness verdictBranch() scopes a sticky verdict to DEVKIT_SHIP_BRANCH, so an inherited pair makes a test answer for the OUTER ship's repository. The scrub now carries three provenance lists - INHERITED_RUN_ENV (review-target.sh parity), SHIP_EXPORTED_ENV (the ship-script delta) and TEST_ONLY_ADDITIONS (the FRINK_AI_STRICT alias) - with SCRUBBED_ENV as their union. The binding test no longer trusts a hand-written list: it parses the export left-hand sides out of ship-branch.sh and run-gates-with-capture.sh and requires every DEVKIT_/GUARD_ name found there to be scrubbed, so a future ship export is caught at the source rather than after it flips a gate test. Also pinned: vitest.e2e.config.mjs shares the same setupFiles, which was assumed rather than asserted.

## vendored-third-party-agent-assets#2 (note dated 2026-07-31)

RULING:

- S1: Vendor third-party agent assets into devkit's own skills/ tree, pinned by FULL upstream commit SHA plus a sha256 of the vendored bytes (cli/lib/install/vendored-skills.mts, asserted by vendored-skills.test.mts).
- S2: Delegating to the upstream installer ('claude plugin marketplace add' + 'claude plugin install') is REJECTED: Claude-only, writes to the user's GLOBAL config rather than the repo, needs the network at install time, and cannot be drift-checked or deselected.
- S3: A SHA rather than a version range because these upstreams publish no tags — the SHA is the only stable identifier for the bytes that were reviewed.
- S4: The upstream LICENSE ships BESIDE the asset rather than being folded into its frontmatter: that satisfies MIT attribution while keeping the asset byte-identical to upstream, so the recorded hash stays an exact upstream comparison.
- S5: Pin refreshes are a deliberate maintainer act via scripts/sync-vendored-skills.mjs (network; never called by init/upgrade).

NOTE:

> The vendored skill now installs to .devkit/vendored-skills/\<name>/, NOT the agent skills dirs. .claude/skills/ (and its Cursor/Codex twins) is where the CONSUMER's hand-authored skills live; a pinned third-party copy devkit owns, drift-checks and reclaims does not belong sitting among them, indistinguishable from the reader's own work. Delivery is now a plain two-file copy (cli/lib/install/adhd-skill.mts) called from init and the overlay, so the component no longer depends on skills being on, and skillNamesForSelection returns a constant false for the name — that exclusion is ALSO the whole migration, since syncSkills' existing manifest reclamation deletes a previously-manifested skill dir the moment it leaves the selected set (verified on both surfaces against both the v2 and legacy manifest schemas). No bespoke upgrade step. .devkit/ was chosen over a new top-level dir because devkit already owns that tree: clean removes it wholesale and the overlay git-exclude already covers it, so the relocation added no removal or ignore machinery — only a doctor presence-check, replacing the drift coverage the skills manifest used to provide indirectly. Cost: /i-have-adhd no longer resolves as a slash command (skill discovery only scans the agent skills dirs), so the SessionStart hook is now the ONLY way it runs — acceptable because the skill sets disable-model-invocation and the 2026-07-30 note already made the hook its only real entry point; the loss is re-invoking it by hand after 'stop adhd mode'. Reclaim here is deliberately NOT pristine-checked, unlike the agent skills dirs: clean already deletes .devkit/ unconditionally, so honouring a local edit in one path but not the other would be the inconsistency rather than the safeguard. REJECTED again, more specifically than on 2026-07-29: shipping it as a real Claude Code plugin (.claude/plugins/\<name>/ + enabledPlugins), the shape frink's ponytail-frink uses. Enabling ANY plugin — project-scoped or not — records marketplace and install state in the USER's global ~/.claude/plugins/*.json and loads from a versioned global cache, which is the same global-config objection that killed the upstream installer; activation also needs a committed extraKnownMarketplaces key that would turn a personal reading preference into a team-wide default and write into every teammate's home dir — the exact inversion of gitignoring .devkit/adhd-off.
