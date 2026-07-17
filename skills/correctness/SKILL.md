---
name: Correctness Review
description: Correctness bug hunting for a finished diff. Use when reviewing changes that write state, retry/recover, broadcast events, or classify inputs — hunts concurrency/races, state-machine dead states, writer/reader contract mismatches, discarded return values, and classifier edge cases. Covers state integrity, temporal/concurrency, contracts and boundaries, recovery/failure modes, and parsing edge cases.
---

# Correctness Review

## Review Script

```bash
SCRIPT=".claude/skills/correctness/scripts/checklist.mjs"

node $SCRIPT generate     # Enumerate review items from staged source files (all declared roots)
node $SCRIPT status       # Show progress
node $SCRIPT check-item <name> --pass   # Mark item passed
node $SCRIPT check-item <name> --fail "reason"  # Mark item failed
node $SCRIPT finalize     # Verify every item was resolved; refuses if any are pending or failed
if [ "${DEVKIT_RUN_MODE:-}" != "review" ]; then node $SCRIPT cleanup; fi
```

The roots the script scans are the UNION of `scanRoots`, `review.backendRoots` and
`review.frontendRoots` from `guard.config.json` — correctness is not domain-sliceable, so a
backend writer and its frontend reader are reviewed together. Source files only.
During `devkit review`, `DEVKIT_REVIEW_BACKEND_ROOTS` and `DEVKIT_REVIEW_FRONTEND_ROOTS` replace
their configured counterparts with the gate's effective topology; `scanRoots` remains in the union.

Exactly four items (`state-transitions`, `concurrency-races`, `writer-reader-contracts`,
`error-and-edge-classification`) are ALWAYS enumerated when any source file is staged — a
correctness bug has no reliable lexical signature, so they never regex-gate to zero, and never
more than four: each lens is a pass over the same diff, so item count multiplies judge
wall-clock. Broadcast/dedup rides the contracts lens; retries and discarded returns ride the
state lens.

## State & Data Integrity

- Every status/state write needs a compare-and-set or expected-state guard (`expectStatuses`,
  `WHERE status IN (…)`) — an unconditional update lets a concurrent path clobber a real result.
- Trace each written state to EVERY consumer: pollers, filters, queries. A writer that sets a
  state a reader filters out creates a permanently stuck row.

```typescript
// BAD: unconditional — a concurrent advance to 'running' is overwritten back
await db.update(nodeRuns).set({ status: 'running', nodeOutput: null });

// GOOD: CAS — a concurrent advance matches 0 rows instead of clobbering
await unparkNodeRunInPlace(id, { expectStatuses: ['cancelled'] });
```

```typescript
// BAD: retry flips the row to a state the poller filters out — stuck forever
await tasks.update({ status: 'pending' }); // poller: WHERE startMode != 'wait'
```

## Temporal & Concurrency

- For every read-then-write, walk the interleaving where another actor (second process, second
  window, timer, boot sweep) runs BETWEEN the read and the write.
- Re-entry paths (resume, wake, reconnect) must be idempotent; timers and retries must not
  double-fire.

## Contract & Boundary Handling

- For every emit/broadcast/send: enumerate the listeners. A broadcast consumed by N
  windows/processes each holding its own queue executes the effect N times — require targeting
  or dedup.

```typescript
// BAD: every window enqueues and sends the same retry prompt
broadcastToAllWindows('task:chat-ready', { subChatId, isRetry: true });
```

- Changed signatures/payload shapes: grep ALL call sites; every one must still hold the contract.

## Recovery & Failure Modes

- A discarded return value is a finding — the caller proceeds as if the operation succeeded:

```typescript
// BAD: resumeFailedFlowInPlace returns false on every precondition miss — silently dropped
try { await resumeFailedFlowInPlace(runId); } catch { /* only exceptions handled */ }

// GOOD: the boolean is load-bearing
const resumed = await resumeFailedFlowInPlace(runId);
if (!resumed) log.warn('run not unparked — agent done will be dropped', { runId });
```

- Retry/resume paths must land in a state some sweep re-drives; a transient condition must not
  be marked permanent (near-expiry ≠ expired; a rotated token must be re-read).

## Classifier & Parsing Edge Cases

- For every regex/string classifier, construct one valid input that misclassifies:

```typescript
// BAD: a bare `{` anchor — the model's own JSON output classifies as an API error
const ANCHOR_RE = /^\s*(\{|Failed to authenticate|API Error:)/;

// GOOD: only the CLI's own prefixes anchor
const ANCHOR_RE = /^\s*(Failed to authenticate|API Error:)/;
```

- Boundary conditions: near-expiry ≠ expired, 0 ≠ absent, empty string ≠ missing.

## Verdict bar

FAIL only for a reproducible correctness defect introduced by this diff, stated with its
concrete failing interleaving or input. Style, performance and security belong to the other
reviewers.
