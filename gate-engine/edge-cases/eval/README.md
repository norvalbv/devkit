# edge-cases-eval

Ground-truth corpus of historical **`/edge-cases`** runs (sc-1118, epic 1117 Track A). The
`/edge-cases` prompt is a diff-scoped adversarial review the owner runs at the end of substantive
sessions; it reliably surfaces real bugs. sc-1119 benchmarks prompt/channel variants of an
automated edge-cases judge against this corpus; sc-1120 ships the judge. **No judge or bench lives
here** — this directory is the dataset plus the tooling that produced it.

`cases.jsonl` is a **hand-audited snapshot**, not the output of a reproducible pipeline: the
harvest reads private local stores (chat databases, session transcripts) that exist only on the
author's machine, labeling uses an LLM pass plus human review, and human corrections are frozen
into the committed rows. The `harvest → label → finalize` scripts are **provenance tooling** —
they document how rows were derived and let the corpus GROW (`finalize.mts --append`), but a fresh
clone cannot regenerate it byte-for-byte.

**Data home:** devkit is public and the corpus carries private-repo code excerpts, so
`cases.jsonl` is **NOT committed here** (gitignored). The canonical committed copy lives in the
private frink repo at `scripts/edge-cases-eval/cases.jsonl`; finalize writes the local working
copy next to this README. sc-1119's bench should read `EDGE_CASES_CORPUS` (env, absolute path)
falling back to this directory's local copy. The `__tests__/cases.test.mts` gate validates
whichever copy is present and skips when none is.

## Pipeline (provenance, and how to grow the corpus)

```
bun gate-engine/edge-cases/eval/harvest.mts            # stage 1: stores → raw/candidates.jsonl (no LLM)
bun gate-engine/edge-cases/eval/label.mts --limit 5    # stage 2: label proposals (COSTS TOKENS — never auto-run)
bun gate-engine/edge-cases/eval/label.mts --audit      # review queues (liveBug / noise / low-confidence)
bun gate-engine/edge-cases/eval/finalize.mts --append  # stage 3: reviewed proposals → cases.jsonl
```

Raw intermediates live in the gitignored `raw/`. Sources (bun-only, `bun:sqlite`, all read-only;
agents.db is snapshotted via `VACUUM INTO` first):

| source | store | fidelity |
|---|---|---|
| `claude-code` | `~/.claude/projects/*/*.jsonl` | full tool I/O — carries the corpus |
| `frink-app` | `~/Library/Application Support/{Frink Dev,frink}/data/agents.db` (`sub_chats`) | full; a sub_chat sharing `session_id` with a transcript folds into that row (`crossRefs`) |
| `cursor` | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (21 GB — scan takes ~1 min) | text-only bubbles; **no diffs, no model metadata** → summary anchors |

Diff recovery ladder (recorded per row as `anchor.diffOrigin`): `in-session` (a real hunked
`git diff` output in the transcript — rtk compresses most of them away) → `reconstructed-from-commits`
(session-printed commit shas re-shown) → `reconstructed-from-pr` (squash commit via PR number) →
`reconstructed-from-branch` (branch tip as of the session date vs merge-base) →
`reconstructed-from-date-window` (commits authored in the session window whose files overlap what
the session edited).

## Row schema

One JSON object per line, sorted by date. Enums live in `lib/schema.mts` (the validator the test
gate runs); this table is documentation, the validator is law.

| field | meaning |
|---|---|
| `id` | `{cc\|fk\|cu}-{repo}-{yyyymmdd}-{sha8(sourceRef)}` — deterministic, one row per INVOCATION (a session can invoke twice) |
| `source` / `sourceRef` / `crossRefs` | which store, the exact message/bubble address, and folded twin rows |
| `repo` | `frink \| devkit \| qavis \| other:<name>` — owners-web (employer code) is excluded entirely at harvest |
| `branch` / `prNumber` / `date` / `model` / `provider` | run metadata; `model` is null for cursor rows |
| `promptVariant` / `promptSha` | prompt lineage (`frink-cmd-v1`, `legacy-diff-debug-chat`, `custom-<sha8>`) — the prompt text EVOLVED over time |
| `anchor.kind` | `diff` or `session-summary` — **summary rows must be excluded from the diff-scoped P/R denominator** (they exist for provenance/variant history, and can only exercise a summary-mode judge) |
| `anchor.nameStatus` | changed-file list (from diff headers, else the session's diff-stat output) |
| `anchor.diffExcerpt` | ≤300 lines / ≤12 KB, truncated at hunk boundaries; **only for allowlisted repos** (`EXCERPT_ALLOWLIST`); full diffs stay in gitignored `raw/` |
| `anchor.summary` | 2–4 sentence what-was-built (LLM-written at label time; the only anchor for cursor rows) |
| `findings[]` | see below; `[]` for degenerate rows |
| `degenerate` / `degenerateReason` | the run had nothing to review (`empty-diff \| docs-only \| agent-declined \| no-response`). **Degenerate rows are precision guards**: a judge that produces findings on a degenerate anchor is hallucinating — score them as true-negative material, never drop them |

Per finding:

| field | meaning |
|---|---|
| `claim` | normalized one-line assertion — **match key** for sc-1119 |
| `files` | repo-relative paths implicated — **match key** |
| `text` / `severity` / `category` | the finding as stated (`severity` verbatim, `unstated` if none) |
| `verdict` | **axis 1 — what judge precision scores against.** `worth-surfacing` or `noise`. `noise` = hallucinated / factually wrong about the code / duplicate of an existing test / below-severity trivia. Plausible-but-unconfirmed is NOT noise — it stays `worth-surfacing` with `wasLiveBug: "unknown"` |
| `wasLiveBug` | **axis 2 — orthogonal fix-evidence.** `"true" \| "false" \| "unknown"` |
| `evidence.tier` | ranked by INDEPENDENCE from the raising agent — see below |
| `evidence.detail` | must quote its source (failing-test output, `sha subject`, or user words) |
| `evidence.confidence` / `evidence.reviewed` | labeler confidence; `reviewed: true` = a human verified this label |

## Label semantics — why the tiers are ranked by independence

The `/edge-cases` prompt **commands** the agent to write tests for its findings and TDD-fix any
bug. So "the agent wrote a test and a fix in the same turn" is *compliance with instructions*, not
evidence the finding was real — an agent can test-pin already-correct behaviour or "fix" a non-bug
it just invented. Tiers, strongest first:

1. `f2p-in-session` — a test observed **failing against the pre-fix code, then passing** (the
   epic's FAIL_TO_PASS logic). Behavioural evidence; requires the failing run quoted.
2. `independent-fix` — a **different, later session's** commit addresses the finding. Same-session
   commits never qualify.
3. `user-confirmed` — the user explicitly validated the specific finding in-session.
4. `test-added-green` — test written, passed immediately: pins behaviour, proves **no** live bug
   (`wasLiveBug: "false"`, verdict may still be `worth-surfacing`).
5. `rejected` — explicitly dismissed as wrong → `verdict: "noise"`.
6. `none` — no evidence either way; verdict judged on content quality alone, `wasLiveBug: "unknown"`.

`wasLiveBug: "true"` is only legal with tiers 1–3 (enforced by `finalize.mts` and the test gate),
and every `wasLiveBug: "true"` or `verdict: "noise"` label was human-reviewed
(`evidence.reviewed: true`). Evidence was gathered **mechanically before** the labeling model ran,
and the model was constrained to cite only that bundle.

## How sc-1119 must consume this

- **Match rule:** a judge finding matches a labeled finding iff same `category` AND overlapping
  `files` (compare `claim`s to break ties). One judge finding may cover two labeled findings
  (count both matched); a labeled finding split across two judge findings counts once. If an LLM
  matcher is used instead, it needs its own mini-eval first (the sc-1061 lesson: matcher error
  swamps small metric deltas).
- **Denominators:** precision over `worth-surfacing` vs `noise` on non-degenerate diff-anchored
  rows; degenerate rows contribute hallucination checks; `anchor.kind: "session-summary"` rows are
  OUT of the diff-scoped denominator.
- **Stratify** by `promptVariant`, `model`, and `anchor.kind` — the ground truth spans two years of
  prompt drift and several generator models; a blended F1 is misleading.
- **Detection limits:** with N findings, a binomial 95% CI half-width is ≈ `1.96·√(p(1−p)/N)` —
  at N≈400, ±4 points. Paired A/B on the same cases (McNemar / paired bootstrap) detects ~10-point
  deltas from ~160 findings, ~5-point from ~630. Do not claim significance for 2–3-point deltas on
  this corpus; use multiple samples per case + paired analysis before adding labels.

## Known biases (accepted, documented)

- **Survivorship / recall blind spot:** the corpus only contains what historical runs FOUND. It
  measures variant precision and relative recall, never absolute recall. An open-source known-bug
  slice (pre-fix diffs with a known answer) is the planned complement (epic 1117 follow-up).
- **Evidence recall floor:** later-commit matching is by file/keyword overlap — renamed-file fixes
  are missed, so some genuinely-real findings sit at `wasLiveBug: "unknown"`. Stratify by
  `evidence.tier` if this matters.
- **Same-session f2p is rare** because agents usually run the test only after fixing — exactly the
  gap epic 1117 Track B (F2P receipt) exists to close.
- Single user, single machine, frink-heavy repo skew; cursor rows lack models and true diffs.
- The scrub gate (`__tests__/cases.test.mts` + `lib/scrub.mts`) catches **modeled** secret shapes
  and machine paths only; the repo excerpt allowlist and PR review cover what patterns can't.

## Corpus stats (snapshot of 2026-07-12)

- **139 cases, 457 labeled findings**, spanning 2026-03-11 → 2026-07-12.
- Sources: 85 claude-code · 45 cursor · 9 frink-app. Repos: 111 frink · 19 devkit · 8 qavis · 1 frink-marketing.
- Anchors: **77 diff** (20 in-session · 34 date-window · 17 branch · 6 commit reconstruction) · 62 session-summary.
- Degenerate: 49 total — **12 true degenerates** (6 agent-declined · 4 docs-only · 2 empty-diff; the
  precision guards) and **37 `no-response`** rows (interrupted/double-fired invocations or cursor
  bubbles whose assistant text was not recoverable — **extraction losses, excluded from ALL
  benchmark denominators**; kept for provenance only).
- Findings: verdict `worth-surfacing` 383 / `noise` 74 (16.2% negative class). `wasLiveBug`:
  true 22 · false 250 · unknown 185.
- Evidence tiers: `f2p-in-session` 21 · `user-confirmed` 1 · `rejected` 46 · `test-added-green` 175 · `none` 214.
- Review state: **100% of `wasLiveBug:"true"` and `verdict:"noise"` findings human-audited**
  (evidence quotes verified to exist verbatim in the raw bundles); `worth-surfacing`/`unknown`
  findings carry the labeler's verdict unreviewed (`reviewed: false`) — the benign default class.
- Prompt variants: `frink-cmd-v1` 87 · `frink-cmd-v0` 17 · `legacy-diff-debug-chat` 1 · 34 one-off
  `custom-*` (hand-tweaked invocations).
- Generator models: claude-opus-4-8 79 · claude-fable-5 9 · claude-sonnet-5 3 · unknown (cursor) 48.
