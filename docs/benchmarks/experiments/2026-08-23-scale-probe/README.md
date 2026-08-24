# Scale-track round 1 — whole-diff vs chunked correctness review on real large diffs, 2026-08-23

**Outcome: DIRECTIONAL support for chunking; nothing is treated as a cleared or failed
registered bar.** Under the shipped ruleset (decontaminated label mining + closed-set location
resolution + terminal-verdict rows only) `chunk:1000` re-found **8/23** telemetry-labelled known
defects vs **5/23** for the production whole-diff shape (1.6×), with `chunk:400` also 8/23. A
chunk arm pooled ≥ whole under EVERY one of the five mining/scoring rulesets tried (ratios
1.375×–2.0×) — the direction is stable — but the registered 1.5× bar straddles that range and
the decontaminated sample is small (n=23), so the production decision moves entirely to the
confirmation round, whose registration must pin the mining rule, the scoring rule, and a frozen
corpus manifest before any run. K=1 per task throughout.

**Correction record (2026-08-23).** devkit's own reviewer gate blocked this record's PR
repeatedly over evidence-pipeline defects; a parallel adversarial sweep then found more. Four
classes, all fixed in the shipped harness:

1. **Extraction** — only the FIRST `file[:line]` mention per predicted issue was matched
   (biased AGAINST whole-diff, whose findings cite more cross-file context).
2. **Cross-attribution** — loose path-suffix matching credited bare basenames and shared
   subpaths across distinct files; the shipped rule resolves every mention against the diff's
   closed staged-file set (exact, else unique suffix; ambiguity = no match).
3. **Non-verdict rows** — errored/inconclusive judge runs scored as clean zero-issue passes;
   they are now excluded and re-driven.
4. **Label contamination (largest)** — mining included the diff's OWN attempt's findings as
   "later-found" labels (test-retest circularity: 21 of the round's 44 tier-A labels) and
   filtered by branch name with no repo pin. Decontaminated mining excludes the diff's own
   attempts and pins the repo.

Pooled tier-A sensitivity (whole · chunk:1000 · chunk:400):

| ruleset | labels n | whole | c:1000 | c:400 | c:1000 ÷ whole |
|---|---|---|---|---|---|
| v1 first-match, loose suffix (round's original) | 44¹ | 12 | 20 | 22 | 1.67× |
| v2 all-locations, loose suffix | 44¹ | 16 | 22 | 25 | 1.375× |
| v3 all-locations, bare-basenames need lines | 44¹ | 8 | 16 | 17 | 2.0× |
| v4 closed-set unique resolution | 44¹ | 16 | 22 | 24 | 1.375× |
| **v5 = v4 + decontaminated labels + terminal rows (SHIPPED)** | **23** | **5** | **8** | **8** | **1.6×** |

¹ v1–v4 ran on the contaminated label set and are shown only to document rule-sensitivity; they
are not comparable to v5's denominator.

Pre-registration: [`../../pre-registration-scale-chunk.md`](../../pre-registration-scale-chunk.md)
(written before the expansion ran; the first single-diff probe was the plan's exempt go/no-go).
Data handling per [`scale-track-third-party-data`](../../../decisions/scale-track-third-party-data.md):
counts and hashes only; raw labels/predictions/checkpoints live in the owner's local research dir.

## Arms

`whole` = 4 lens judges over the whole diff (production shape, 60 KB stdin evidence cap).
`chunk:1000` = ~1,000-LOC whole-file next-fit chunks (`lens/chunk.mts`); 3 local lenses per chunk;
`writer-reader-contracts` always whole-diff. `chunk:400` = same shape at a 400-LOC cap — one diff
in the registered round, extended to all 8 diffs POST-HOC (Amendment 1; exploratory). `haiku × chunk:400`
(Amendment 2) was stopped for futility after 6/8 diffs; `haiku × chunk:200` (Amendment 3) was
cancelled before launch — see the haiku section below. Engine: `feat/ship-attempts-epic` (#426 + #429), lens split on, issue cap 3/lens, K=1.

## Per-diff tier-A recall (known defects whose file was byte-identical when later found)

| diff | ~LOC | tier-A n (decontaminated) | sonnet whole | sonnet chunk:1000 | sonnet chunk:400² | haiku chunk:400³ |
|---|---|---|---|---|---|---|
| `032d8860` | 1,054 | 9 | 0/9 | 2/9 | 3/9 | 0³ᵃ |
| `3f1389b9` | 1,073 | 4 | 4/4 | 3/4 | 3/4 | —³ᵃ |
| `6e42021c` | 1,126 | 2 | 1/2 | 0/2 | 1/2 | 0³ᵃ |
| `fe31a21e` | 1,011 | 1 | 0/1 | 0/1 | 1/1 | 0³ᵃ |
| `0aa63cf8` | 2,119 | 1 | 0/1 | 0/1 | 0/1 | 0³ᵃ |
| `63a1f928` | 1,406 | 2 | 0/2 | 1/2 | 0/2 | 0³ᵃ |
| `760e1080` | 3,931 | 0 | — | — | — | — |
| `2e0713a8` | 7,239 | 4 | 0/4 | 2/4 | 0/4 | — |
| **pooled (shipped ruleset, v5)** | | **23** | **5/23 (22%)** | **8/23 (35%)** | **8/23 (35%)** | see ³ᵃ |

³ᵃ The haiku arm was futility-stopped mid-round and scored against the round's live
(contaminated, v1) labels — 6/38 at stop time, every hit on `3f1389b9`; it was not re-scored
because its disclosed-issue counts are too small to change its verdict (protocol failure).

The pooled row excludes the pilot diff `760e1080` naturally (0 decontaminated labels).

² Post-hoc extension (Amendment 1): the registered decision rule covers only whole vs
chunk:1000; the 400 column is exploratory. Under v5 it wins 2 diffs, loses 2 (including the
7,239-LOC diff — finer slicing fragments cross-hunk signal); the granularity optimum is
diff-dependent under every ruleset.

³ Amendment 2 arm, stopped for futility after 6/8 diffs (see its section below); — = not run.

One registered diff (`e236ba4b`, 2,865 LOC) was skipped: its base commits were never pushed from a
deleted checkout — none of 812 time-window commits accepts the diff (reported per pre-registration).

## Guardrails, cost, and marginal economics

| | whole | chunk:1000 | chunk:400 |
|---|---|---|---|
| judge tasks | 32 | 65 | 161 |
| pass / fail / inconclusive | 15 / 17 / 0 | 36 / 29 / 0 | 121 / 39 / 1 |
| distinct disclosed issues | 21 | 32 | 42 |
| extras verified REAL (haiku proxy)¹ᵉ | 3/6 | 4/10 | not run |
| summed judge time | 102 min | 196 min | 398 min |
| est. spend (flat-40KB approx) | ~$56 | ~$114 | ~$282 |

¹ᵉ Verified-precision figures are v1-era (contaminated labels, old extras keying); the verifier
was not re-run after the corrections (owner call) — the confirmation round re-measures precision
with its own registered verifier.

Marginal cost per extra tier-A hit (v5): whole → chunk:1000 ≈ **$19** (+3 hits / +$58);
chunk:1000 → chunk:400 = **no additional hits for +$168**. One production retry attempt costs
~$5–10 of judges plus a human round-trip — even the first step is now marginal on this sample,
which is another reason the decision belongs to a properly-powered confirmation round.

Packing has a granularity floor: chunks hold whole files and 25/180 changed files exceed a 200-LOC
cap alone, so caps below ~400 degenerate toward per-file review (task counts at caps
1000/400/200/100 = 65/161/254/353) while fixed per-task overhead dominates spend.

Whole-night registered spend ≈ $210–225 (< the $260 stop); the 400 extension added ~$130.

## haiku × chunk:400 (Amendment 2) — stopped for futility

Same shape and matching as the sonnet chunk:400 arm, haiku judges. Stopped (owner-approved) after
6 of 8 diffs / 75 of 161 tasks: the inconclusive guardrail was already exceeded (10/75 = 13% vs
≤10%; sonnet arms: 1/258) and the arm disclosed only 15 issues in 75 tasks. Pooled tier-A on the
six completed diffs: **6/38 (16%) vs sonnet chunk:400's 20/38 (53%)** on the same six — and every
haiku hit came from the one diff every arm handles well. Per diff (haiku / sonnet, same cap — v1 scoring as computed at stop time; the haiku arm was not
re-scored, its disclosure counts are too small for the variant to matter):
032d8860 0/11 vs 4/11 · 3f1389b9 6/8 vs 5/8 · 6e42021c 0/6 vs 3/6 · fe31a21e 0/5 vs 5/5 ·
0aa63cf8 0/4 vs 1/4 · 63a1f928 0/4 vs 2/4. Est. spend ~$45–65.

A follow-up 3-diff probe at `haiku × chunk:100` (Amendment 4; 75 tasks) confirmed the null from
both directions: tier-A 5/25 vs the 400-arm's 6/25 and sonnet-400's 12/25 on the same diffs,
inconclusive 16/75 = 21% (worse than the 400 arm's 13%) — and on the one diff haiku handled at
400 LOC (6/8), 100-LOC slices LOWERED recall to 4/8. Granularity cannot rescue a protocol-
compliance failure; no further haiku granularity arms.

Both known haiku failure modes (sc-1476 checklist non-compliance; silent under-disclosure)
appeared at once, consistent with the `correctness-reviewer-precision` decision keeping the
production reviewer on sonnet. Finer slicing does not address either mode, so Amendment 3
(haiku × chunk:200, 254 tasks) was cancelled before launch at $0. Any future cheap-model arm
should change the protocol (e.g. a non-checklist single-question judge), not the chunk size.

## External bots on the same labels (context, not a controlled comparison)

The 6 labelled diffs from the frink alias map to open/merged PRs reviewed by CodeRabbit and
Macroscope as operated in that repo. Scoring their PR comments against the same tier-A labels
(file match ±10 lines): **CodeRabbit 0/33** (2 PRs rate-limited, 4 with summary-only output, zero
inline comments), **Macroscope 0/33** (0 even at file-mention level). Caveats: bots-as-operated
(free tiers, possibly unconfigured), and label circularity — labels are defects devkit's own gate
found later, so the comparison favours the gate family. Recorded as context only.

## Corpus

The $0 candidate scan (`scale/scan-candidates.mts`) over the diff archive, DECONTAMINATED
mining: 305 archived large diffs (>500 LOC) with correctness review scope, **230 carry ≥1 label;
310 tier-A / 1,318 tier-B labels total; 178 diffs ≥1,000 LOC**. (The contaminated pre-correction
scan claimed 722 tier-A labels — 57% were the diffs' own attempts' findings.) This round consumed
8 diffs / 23 decontaminated tier-A labels. Minting rows is free (data extraction) and queued
behind the harness PR; the confirmation round samples from those 230 under a frozen manifest.

## Reading

1. Under the decontaminated ruleset the chunk gains concentrate where the yield-saturation
   finding (`../../reviewer-yield-vs-diff-size.md`) predicts: the 7,239-LOC diff (0/4 → 2/4) and
   the densest mid-size diff (0/9 → 2/9 → 3/9). Where whole-diff already did well (3f1389b9
   4/4, 6e42021c 1/2) chunking tied or lost a hit — slicing helps most when there is more code
   than attention, and costs a little cross-hunk context where there is not.
2. Chunk pooled ≥ whole under every one of the five rulesets (1.375×–2.0×) — the DIRECTION is
   the robust result. The MAGNITUDE is not: it moves with mining and matching choices that were
   under-specified at registration, which is the round's biggest methodological lesson.
3. Misses cluster on the same diffs for all arms — labels there may demand cross-file or runtime
   context no single-pass reviewer reaches; candidates for the K-sample / import-graph-grouping
   work, not finer slicing.
4. The evidence pipeline itself needed ten review rounds + an adversarial sweep to become
   trustworthy (four defect classes; see the correction record). Every scoring/mining rule the
   confirmation round uses is now code in `scale/labels.mts` with the registration pointing at
   it — not prose open to interpretation.

## Next (per the decision rule)

Open the production-chunking story (sc-1907): `GUARD_CORRECTNESS_CHUNK` off-by-default wiring into
`planReviewWork` with sticky chunk plans and `|chunk:` cache keys, gated on a properly-powered
confirmation (K≥2 stable-flip machinery, granularity sweep incl. an import-graph-grouped
`chunk:semantic` arm, precision verifier at scale) before any default flips. The 230 labelled
archived diffs are the corpus for that round. The production decision metric is NOT recall alone:
the rollout readout compares attempts-per-shipped-commit, wall-time-to-ship, and total judge $
per shipped commit before/after (all derivable from existing ship/judge telemetry) — a higher
per-attempt cost is acceptable only if fewer attempts lower those totals.
