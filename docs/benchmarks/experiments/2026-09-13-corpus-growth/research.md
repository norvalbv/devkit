# Research for the reviewer comparison

Research captured on 13 September 2026. This records the pre-run rationale selected from frozen **development** results, when reserved outcomes remained unread. The candidate was later stopped incomplete and its active instructions restored to baseline; see [the current experiment status](README.md). This document distinguishes published findings, vendor descriptions and their possible application to devkit; none establishes that a proposed change improves this reviewer.

## Primary research

### SWE-Review — July 2026

[SWE-Review: Closing the Loop on Issue Resolution with Agentic Code Review, v1](https://arxiv.org/abs/2607.06065v1) compares interactive repository review with fixed-context review on 1,384 candidate patches. Its controlled comparison supports adaptive evidence gathering in that setting. Devkit already gives reviewers repository tools, so adding generic exploration instructions would not reproduce that intervention.

Appendix B is more relevant to the observed historical false-rejection problem. The authors attribute many false rejections to misreading code and rejecting unconventional but valid implementations. Their error categories are LLM-judge annotations, not independent human adjudications. They also identify misleading reviewer-written tests: execution can reinforce a mistaken assumption, and more tool activity is correlated with errors rather than demonstrated to cure them.

**Application to investigate:** verify the concrete functional claim and the assumptions behind a reproducer before rejecting a change. Compare the relevant original and staged behavior. Keep searches directed at that claim. Do not equate running a test, reading more files or writing more analysis with correctness. The paper's setting, models and resolve-after-revision metric differ from this corpus's label agreement.

### CR-Bench — March 2026

[CR-Bench: Evaluating the Real-World Utility of AI Code Review Agents, v1](https://arxiv.org/html/2603.11078v1) separates bug matching, usefulness and signal-to-noise. Its experiments use the 174-task verified subset of a 584-task dataset. The Reflexion condition explicitly searches for missed bugs; it increases recall in the reported configurations while reducing usefulness and signal-to-noise compared with the single-shot condition.

**Application to investigate:** direct investigation toward evidence that distinguishes a real defect from a plausible explanation, rather than add pressure to discover more bugs. Keep useful negative evidence and allow an unsupported hypothesis to be rejected before it becomes a finding. This does not justify reducing coverage: all four existing lenses and all frozen cases remain. Their comment-level evaluator and model-based judgments are not interchangeable with devkit's deterministic case-label scorer, and their reported precision is not a transferable estimate for this task.

### Verified code reasoning — September 2025

[Towards Verified Code Reasoning by LLMs, v1](https://arxiv.org/html/2509.26546v1) distinguishes program semantics, an agent's claims and the property those claims are meant to establish. Its examples include unsupported library assumptions and imagined behavior in callers outside the supplied code. Formalizing the explanation can expose contradictions or missing obligations.

The experiments cover narrow uninitialized-variable and equivalence tasks. Crucially, the paper leaves verification of the source-semantics-to-agent-claims implication to future work; its formalization is not an end-to-end proof of arbitrary review findings.

**Application to investigate:** separate observed source facts, the claimed failing input/interleaving and assumptions about callers or dependencies. Seek evidence for the assumption that actually determines the verdict. A structured trace or checklist can improve auditability but must not be described as formal verification or guaranteed truth.

## Public product methods

[CodeRabbit's context-engineering description](https://www.coderabbit.ai/blog/the-art-and-science-of-context-engineering) describes selecting intent, repository and environment context, including verification when a finding needs checking. Its [code-context guide](https://www.coderabbit.ai/guides/code-context) emphasizes surrounding contracts and relationships. These are vendor descriptions, not a controlled evaluation of incremental benefit to devkit. The relevant idea is a finding-driven request for missing evidence, not indiscriminately increasing prompt size.

[Macroscope's review description](https://macroscope.com/code-review) presents repository relationships and task intent as review context. Its [published benchmark methodology](https://macroscope.com/blog/code-review-benchmark) uses 118 source-derived bugs from 45 repositories, with model-assisted construction and matching plus manual checks. Completed reviews and per-tool availability affect the denominators. Comment count is not factual precision. This is useful methodological context, not an equivalent-condition comparison against this experiment.

The [Parallel/Macroscope case study](https://parallel.ai/blog/case-study-macroscope) describes checking third-party behavior against external documentation. Its reported reduction concerns third-party comments, not independently verified false positives. For devkit, official documentation may help when a dependency contract determines a finding, but source version and citation quality matter; absence of local implementation is not evidence that an imagined contract holds.

## Current devkit applicability

The frozen reviewer already asks for concrete inputs/interleavings, searches for readers and performs an adversarial check before passing a lens. Its instructions nevertheless contain categorical shortcuts, such as treating every discarded return or unguarded state write as a finding before establishing the necessary contract and competing actor.

The shared requested shell allowance includes `git diff`, `git log`, `git status` and the checklist command. Claude applies that shell allowlist, but the Codex adapter used for Sol maps an investigating judge to a workspace-write sandbox and maps only MCP grants individually; the shell prefixes are not a Codex command-by-command restriction. Source tamper checks enforce the reviewed-tree boundary separately. Therefore the requested allowlist does not establish that Sol lacked `git show` or an executable reproducer. A portable evidence workflow should use the existing common investigation surface, preserve the staged-source boundary and respect the timeout. Adding a nominal shell grant alone would not be a demonstrated Sol capability improvement.

The development diagnosis will determine whether a coherent investigation procedure addresses recurring observed errors. Candidate selection must state the evidence, expected benefit, risk to bug detection and exact changes to workflow or capabilities. Both versions then run on the same frozen corpus/model/lens/cap settings. Results, including non-improvement, will be reported without relabeling cases or consulting the reserve during tuning.

## Prior local experiments constrain the intervention

The existing [correctness precision decision](../../../decisions/correctness-reviewer-precision.md) records that a same-family second-pass verifier reduced observed bug detection. That remains a constraint: this task does not add a model that rejudges completed FAILs. The earlier [B/P/L comparison](../2026-09-12-correctness-comparison/README.md) also found identical ceiling results on eight exposed guardrails. Its reachability paragraph and two conditional-rule amendments are useful prior candidates, not measured improvements. The expanded development results must support a coherent change to the existing investigation workflow, and the full reserved comparison must test the benefit and detection risk.
