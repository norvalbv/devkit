# Promptfoo assessment and native execution boundary

Checked 2026-09-06. **Recommendation: reuse native execution for source-backed guardrails and separate unscored exploration; consider promptfoo as an optional orchestrator after an adapter preserves its evidence.** No optimizer, framework dependency or adapter is installed by this PR. The user has not authorized evaluation runs.

## What promptfoo can supply

[Promptfoo's optimization command](https://www.promptfoo.dev/docs/usage/prompt-optimization/) evaluates one configured prompt/provider pair, asks an optimizer model for revisions based on failures and scores, and tests candidates. It supports a validation partition for candidate selection. [Custom JS/TS providers](https://www.promptfoo.dev/docs/providers/custom-api/) can wrap our complete reviewer, so integration need not replace a tool-using agent with a single chat completion.

That supplies experiment orchestration and candidate search. It does not establish that a code-review finding is true, that the scorer diagnosed the target bug, or that the native review inputs were preserved. A later provider would call native `runRow` for source-backed rows, preserve `onTask` evidence and return result metadata/receipt references. Authored probes require a separate unscored path through the native planning/cascade seams; they must never receive dummy gold labels or enter the optimizer objective. The detailed contract is in [comparison.md](comparison.md). This is a feasible integration point, not an implemented integration.

## Two defaults that need explicit handling

At [inspected promptfoo revision 3e1710f](https://github.com/promptfoo/promptfoo/blob/3e1710f282e1963664b162cc81114f41a917fb0c/src/optimizer/promptOptimizer.ts#L360-L405), `createValidationPartition` slices the row array at a count boundary. It does not inspect incident IDs, `caseId` or `variantOf`. A convenient `--validation-split` is therefore not sufficient for our grouped data: a bug, repair or derivative could straddle that boundary.

[Candidate adoption uses that validation score](https://github.com/promptfoo/promptfoo/blob/3e1710f282e1963664b162cc81114f41a917fb0c/src/optimizer/promptOptimizer.ts#L319-L350). It is selection data, not an untouched final exam. For later optimization, explicitly allocate entire incident/derivative families to development, selection and separate confirmation; verify membership before every call. Do not assume ordering pairs together guarantees a count-based split will land between families. Either supply partitions through a verified integration path or do not use that optimizer mode. No qualifying partition or confirmation data has been created here.

[Promptfoo caching](https://www.promptfoo.dev/docs/configuration/caching/) must also be disabled for fresh measurements. Repeat namespaces alone are insufficient across repeated invocations. Native checkpoint salvage is a separate cache boundary and must also be disabled. Record all native retries and failures rather than choosing successful attempts.

## Candidate search is useful only with a valid objective

Our current right-item/reason-pattern fields are diagnostics. Optimizing them alone can reward more accusations without finding the intended defect. The objective must keep target diagnosis, valid extra findings, invalid/unresolved occurrences, repaired/decoy acceptance, execution failures and cost separate. No single composite score or weighting scheme has been validated for this pilot, and no automatic optimizer is enabled.

[GEPA v2](https://arxiv.org/abs/2507.19457v2) describes proposing and testing prompt changes from trajectories and feedback. Its reported results motivate systematic candidate search, not an expected Sol gain from our wording; this bounded assessment inspected its abstract, not a reproduction. [Macroscope's auto-tune account](https://macroscope.com/blog/we-stopped-writing-prompts) similarly describes joint model/prompt search with labelled examples and substantial call costs. Here Sol stays fixed, so model search and another verification stage are outside the comparison.

Start with B/P/L on the eight source-backed guardrails after permission and qualification. B/P/L/C on authored probes is separate unscored exploration and cannot select an optimizer winner. A scored direct-mechanism or C comparison first needs independently source-anchored cases. If later evidence justifies broader optimization, reuse an existing search tool rather than inventing an optimizer, retaining the native provider contract and independently held confirmation families. The small hand-authored patch is one seed, not the improvement method or a presumed winner.
