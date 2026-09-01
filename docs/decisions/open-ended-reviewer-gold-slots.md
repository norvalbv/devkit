---
slug: open-ended-reviewer-gold-slots
created: 2026-07-05
---

# open-ended-reviewer-gold-slots

## Target · 2026-07-05 — open-ended reviewer output is scored via gold slots + an audited per-slot LLM matcher

**Context:** A prompt/model edit to the 18KB feature-completeness-reviewer brief was unverifiable: the reviewer emits an OPEN-ENDED findings list (severity + free text), so the decisions-eval confusion-matrix pattern cannot score it, and the only existing check (scripts/agent-benchmarks keyword traps) cannot credit a paraphrased hit or debit a re-litigated recorded decision — every brief edit shipped on the vibe 'the review got better', and sc-1058 was filed because that vibe twice masked recall regressions nobody could quantify.
**Ruling:** The completeness bench scores the reviewer against per-case GOLD SLOTS (gaps that must surface, each with target severity) plus DECOYS (recorded decisions / out-of-scope items it must not flag), mapped by an LLM matcher that asks one forced-choice question per slot (never one holistic list-to-list call), votes majority-of-K, and is itself audited (committed labels, Cohen's kappa >= 0.7 to be trusted) and hashed into the baseline (matcherHash) so a matcher edit invalidates comparisons exactly like a gate edit. Headline metrics are gap recall (hard floor) and decoy false-flag rate (hard ceiling); severity calibration is warn-tier; the flip gate clusters by CASE because slots within a case share one reviewer transcript.
**Consequences:**

- Positive: A brief edit becomes a measured delta on the failure modes that matter: missed gaps (the reviewer's reason to exist) and re-litigated recorded decisions (the trust-eroding noise), with the matcher's own error measured instead of silently attributed to the reviewer.
- Negative: The measuring instrument is itself an LLM: matcher noise, same-family leniency (claude-only harness), and per-slot call cost (slots x K haiku calls per run) are all accepted and mitigated by audit + kappa policy + K-vote rather than eliminated; a full tier costs hours of opus time.

**Vision-fit:** n/a — internal tooling
**Researched:** arXiv:2410.10934 TICK — per-item forced-choice decomposition raises judge-human agreement ~6pp over holistic judging; arXiv:2403.18802 SAFE — per-fact LLM matching validated by an adjudicated human audit sample; arXiv:2502.01534 — preference leakage: K same-family votes reduce variance not family bias, so the audit is the validity instrument; arXiv:2411.00640 Miller — cluster paired tests by item source (here: case), slot-level pairing is anti-conservative
**Rejected:** (a) keyword traps (requireAny/forbid, the agent-benchmarks pattern) — cannot credit a paraphrased hit or distinguish mentioning a decoy from flagging it; (b) closed-label conversion (score only the PASS/FAIL verdict line) — throws away the findings list, measuring the verdict heuristic instead of recall; (c) one holistic list-to-list matching call — loses to per-slot forced choice on judge-human agreement (TICK) and entangles slot errors; (d) human matching per run — does not scale to per-edit iteration, so it would never be run
**Anchored-bet:** [BET]
**Revisit-when:** matcher-audit kappa persistently < 0.7 despite prompt fixes (the matcher design is wrong), or the corpus reaches ~200+ rows (aggregate-delta gating with proper CIs becomes defensible), or claude -p exposes seed/temperature control (K-vote partly redundant)
**Scope:** gate-engine/review/eval/**
**Source:** shortcut · sc-1058

## Target · 2026-08-31 — Baseline audit follows the exact current reviewer evidence

**Context:** The completeness reviewer is now provider-configurable, and the Sol run emits a different findings set and ordering from the Opus transcript to which the committed F-number labels were bound. Reusing those labels would either reject valid Sol evidence or, worse, compare a label with a different finding while still reporting agreement.
**Ruling:** Keep per-slot K-vote matching for headline scoring, but make baseline admission audit the exact current findings: a separately invoked strong reviewer re-derives every non-deterministic slot assignment, its outcomes are compared with the primary matcher using Cohen's kappa, and publication requires kappa at least 0.7, no missing audit slots, one observed reviewer model, exact input and capability identities, and zero outages. Transcript-bound committed labels remain a model-bound diagnostic command rather than baseline authority.
**Consequences:**

- Positive: A Sol or Claude completeness baseline can be admitted only with an audit that refers to the findings actually being published, so stale F-number labels cannot silently certify a different transcript.
- Negative: The admissibility audit adds one paid strong-model pass per matcher-judged slot and remains model-vs-model evidence rather than human ground truth; same-provider Opus and Haiku can still share family bias, so the legacy labelled audit and reviewer spot-check remain useful diagnostics.

**Vision-fit:** n/a — internal tooling
**Researched:** The existing TICK, SAFE, preference-leakage, and clustered-test evidence still governs; the 2026-08-31 Opus-to-Sol benchmark exposed the new empirical fact that F-number labels are transcript-local and change meaning when reviewer model output changes.
**Rejected:** Reuse the Opus committed labels loses on validity because F-number identities refer to a different transcript. Require a newly committed label set before every provider run loses on operability and cannot be prepared until after the paid run. Drop matcher audit loses on measurement safety because matcher error would be attributed to reviewer quality.
**Anchored-bet:** [BET]
**Revisit-when:** Reviewer findings gain stable semantic IDs across models and orderings, or a provider-independent adjudicated label corpus can bind directly to current finding content without per-run relabelling.
**Scope:** gate-engine/review/eval/**
**Source:** collab · Codex-backed completeness benchmark
**Evidence-change:** The reviewer is no longer fixed to Opus: the measured Sol run changed finding count and order, proving that committed F-number labels are not portable across the now-supported reviewer identities.
