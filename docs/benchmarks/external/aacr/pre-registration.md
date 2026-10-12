# AACR-Bench narrow run — pre-registration (v5, 2026-10-11)

Frozen before any scored run. Counts, names and hashes only (`docs/decisions/scale-track-third-party-data.md`).

**Question.** Recall of devkit's unchanged four-lens correctness reviewer (`claude-haiku-5-5`, effort
medium, issue cap 3 per lens, whole diff) on AACR-Bench's expert-verified Code Defect references, by
the benchmark's human-annotated context level (Diff, File, Repo).

**Not measured.** Capacity and whole-versus-chunk: every AACR pull request is under 1,000 changed
lines and the dataset records no file count, so no size claim is made from it.

**Cases.** `dataset/positive_samples.json` from github.com/alibaba/aacr-bench at commit 68a56975,
sha256 `7a4a0e7046ffd1b8f41f951480bbb618d23d38d9f67364f38aabcda121a50be3` (the repository's own
meta file pins an older hash). Pull requests whose `project_main_language` is TypeScript or
JavaScript and that carry at least one Code Defect reference: 36 pull requests, 189 references
(Diff 104, File 51, Repo 34). The reviewed change is `git diff source_commit...target_commit`;
`target_commit` is not always the pull request's head.

**Review scope.** In-process config, nothing written to the worktree: include
`**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,svelte}`, no test exclusion (the same config as the ReviewBench run).

**Exclusions, each counted and reported.**
1. A pull request whose base or target commit no longer fetches or will not materialise.
2. Left-side references (the upstream judge fixes generated findings to the right side; 0 expected here).
3. A pull request where the correctness reviewer selects zero files.
4. A run in which more than 10% of lens tasks end non-terminal is reported failed on protocol.

References on files outside the review scope stay in the headline denominator and are also counted
separately as not-in-scope.

**Reviewer environment.** Each lens judge runs with its working directory set to the materialised
pull-request worktree and the tools devkit gives it (Read, Grep, Glob). The codebase search MCP is
absent from the judge profile, so it cannot search another repository's index. The probe shows one
lens transcript reading a file of the pull request's repository outside the diff; without it,
File- and Repo-level references are reported as unreachable rather than missed.

**Findings without a location.** Each reviewer issue is located at its first `file:line` (or
`file:a-b`) mention that both resolves uniquely to a staged file and carries a line. The reviewer marks an
approximate line with a tilde (`file:~a-b`); the tilde is ignored and the line used (amended before any
scored run, after the probe withheld 1 of 11 issues for it). An issue with no
such mention is withheld from export and counted per run. Issues naming two or more staged files are
also counted per run: they are cross-file claims a same-file matcher cannot credit. The upstream judge lets an
empty location pass every filter and would match it against every reference (upstream issue #13).

**Export.** Upstream `codex` result shape, one file per instance: `file`, `start_line`, `end_line`
(the issue's first resolvable `file:a-b` citation; a single line gives a = b), `summary` =
`[lens] <issue text>`, empty `description`. Code: `gate-engine/review/eval/reviewers/external/aacr-export.mts`.

**Matcher.** Upstream `evaluation/judge.py` unmodified, `line_k` 1, judge model
`Qwen3-235B-A22B-Instruct-2507` (the paper's, appendix C.1), pinned as `JUDGE_MODEL=qwen/qwen3-235b-a22b-2507`,
`JUDGE_BASE_URL=https://openrouter.ai/api/v1`, `JUDGE_API_KEY` from `OPENROUTER_API_KEY`. The upstream
judge silently falls back to a lexical mock without a key: each run log must show the LLM mode line
from `print_llm_request_statistics`, and any mock-mode output is void.

**Strictness sensitivity.** `line_k` 1 is primary. One sensitivity is declared now and reported next
to it: `line_k` 10, same path, the semantic judge still required. It tests whether a low recall is a
matcher artefact (admission item 5).
Only Code Defect references are passed in. A catch is a semantic match (path, side and line overlap,
then judge yes). A line-only match is reported but never counted as a catch.

**Noise.** Two independent reviewer runs under distinct arm labels, each scored in three judge
rounds. Per level: mean recall, min–max across the six cells, and a 95% bootstrap interval that
resamples whole repositories (Repo-level labels concentrate in a few repositories), 10,000 draws,
fixed seed.

**Label family.** Every recall figure is reported twice: on references written by a Claude model
(`source_model` contains "Claude"; 28 of 189) and on all others (161). Only the non-Claude figure is
quoted as an absolute recall; the gap is the measured self-preference.

**Line check.** The one-pull-request probe checks, on five sampled exported findings, that the
exported line lands on the cited code in the target-commit file. A failure stops the scored run. A level difference smaller than the band is reported as not separated (an outside
harness measured a 5–7 point re-run floor at 35 pull requests, upstream issue #5).

**False flags.** The same runs are scored against the 67 expert-rejected TS/JS Code Defect comments
in `negative_samples.json`; the count of devkit findings the judge matches to a rejected comment is
reported. AACR precision is not reported: non-Code-Defect references are filtered out, so it would
be meaningless.

**Use limit.** The numbers rank arms of the same model on the same pull requests. They support no
comparison with the paper's tables, a leaderboard or another model family.

**What this cannot tell us.** Capacity; languages beyond TS/JS; bugs no model proposed (159 of the
189 references were written by AI models and then verified; about 15% by a Claude model);
training-data exposure (public pull requests, 2024-12 to 2025-12); the context level is human
annotated on an AI-proposed label set.

**Planned calls.** Reviewer: 36 × 4 lenses × 2 runs = 288 lens tasks plus non-terminal retries.
Judge: at most one call per (reference, located finding within one line on the same path) per round,
three rounds per run, plus the negative set; restated on the board with the real count after a
one-pull-request probe, before the scored run.
