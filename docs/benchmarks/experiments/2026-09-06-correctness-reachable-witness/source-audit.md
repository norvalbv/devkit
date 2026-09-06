# Read-only audit of existing regression pairs

Source revision and exact JSONL row hashes are pinned in [protocol.json](protocol.json). This is a source reading, **not a fresh executable validation**. The existing control assertions are in `gate-engine/review/eval/reviewers/__tests__/repair-controls.test.mts` at that revision. No fixture code or tests were executed for sc-2872.

| Family (also select its `-repaired` row) | Requirement and concrete source path | Existing control and limit |
| --- | --- | --- |
| `corr-retry-stuck-unclaimable` | A failed wait-mode job retried into `queued` must become claimable. `retryJob` removes `startMode: 'poll'`; `getClaimableJobIds` still excludes `wait`. Base and repair reset that field. | The control seeds waiting, normal and active jobs; calls retry and checks claimable IDs plus preservation of the active job. This establishes the intended poller invariant in the adapted in-memory system, not every production recovery path. |
| `corr-read-then-write-clobber-terminal` | Cancellation between read and write must not be overwritten. The buggy `persistSignal` awaits a snapshot then writes by ID. Base and repair use `updateJobStatusIf`, whose check and mutation occur synchronously in this store. | The control starts the signal, writes `cancelled`, then awaits the signal. It also covers happy, terminal and missing jobs. The JS scheduling and Map implementation support this interleaving; this does not prove the atomic behavior of an unmodelled database adapter. |
| `corr-lock-timeout-runs-unlocked` | A contended lock must not execute the protected callback. The bug removes the post-loop timeout throw; repair retains it. | The control creates the owned directory and advances a fake clock past the deadline, checking callback suppression and owner retention, plus uncontended success and error cleanup. This is a deterministic lock-acquisition boundary, not a production contention-rate measurement. |
| `corr-json-string-result-dropped` | Persisting a signal must preserve fields from a stored JSON object string. The bug normalizes the string directly to `{}`; base and repair parse it first. | The control supplies a JSON string, object, invalid string and null, checking persisted values and a missing job. This proves only the named parsing invariant when executed; it does not prove every consumer's behavior. |

## What “repair” means here

Each pair has the same base. Its buggy postimage removes the target behavior while its repaired postimage preserves it, alongside a mechanical rename. The repaired row is reviewed as **base → repaired**, not as the chronological bug → fix patch. This is a static contrast, not the five-round review-history experiment.

The retry and JSON repair changes are parameter renames. Their pre-existing read/write races can remain factually real in base, buggy and repaired snapshots. The existing JSON regression control explicitly checks that distinction; the retry source likewise leaves its read-before-update shape unchanged. Such a race is not introduced by the rename and does not show that the named repair failed. These labels do not assert global absence of bugs.

This audit reads the adapted corpus code and its assertions. It does not reconstruct the original source PR's complete runtime, resolve contradictory historical caller judgments or admit new evidence. Future findings still require separate truth, introduced-scope and target assessment, rather than automatic trust in an expected lens or reason regex.

## Coverage and exclusions

The cohort contains four structural pairs from three original PRs. Stored `caseId`, `variantOf` and `holdout` fields remain unchanged. All eight rows are exposed development data for this pilot; no holdout result will be claimed. The two cases originating in the same PR must not be counted as independent production incidents.

These pairs cover state visibility, an actual asynchronous clobber, lock ownership and parsing preservation. They do not recreate the motivating synchronous editor/send contract or component reuse/lifetime dispute. They are guardrails for the candidate, not a direct test of that hypothesis. No new illustrative example has been inserted into the corpus or prompt.

The large `corr-only-selector-silent-drop` / `corr-asymmetric-flip-classifier` reporting family and sc-2866's typed-reply source family remain excluded because qualification is unresolved. Their exclusion is fixed before running anything, not selected after observing candidate results.
