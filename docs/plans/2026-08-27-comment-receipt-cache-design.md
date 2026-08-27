# Comment receipt cache reuse across ship attempts

## Problem and boundary

`guard-comments` deliberately redetects staged comment paragraphs on every `devkit ship` attempt. A previously approved paragraph should therefore be satisfied from the persisted PASS-receipt store without another model call. Today `receiptKey` hashes `finding.relevantDiff` byte-for-byte, including unified-diff hunk start offsets. An unrelated insertion earlier in a file changes those offsets, misses the persisted receipt, and pays for the same review again across a long retry chain.

This change does not alter comment detection, the three-line challenge threshold, finding IDs, rationale requirements, the judge prompt, or the judge payload. It only corrects receipt identity so Git presentation coordinates are not treated as semantic evidence. Prior-art: `SOLVED_ELSEWHERE` — Bun Comment Cop, SARIF fingerprints, GitHub CodeQL fingerprints, Git stable patch IDs, and Devkit's existing reviewer cache all exclude absolute position from stable identity.

## Design and safety

`receiptKey` will hash a comment-specific canonical form of `relevantDiff`. For each valid two-parent unified hunk header, the old and new start offsets become placeholders. Old/new counts remain, with an omitted count normalized to `1`; the function-context suffix and every hunk-body byte remain exact. Malformed, combined-diff, and unfamiliar headers remain byte-exact. The receipt schema increments once so existing receipts deliberately miss after upgrade.

The stage-while-judge-runs check will compare the complete initial finding snapshot, not only findings sent to the judge. Revalidation fails if an unsupported file appears, a finding is added or removed, a rationale disappears or changes, or any semantic receipt key changes. A coordinate-only shift of the unchanged set remains publishable. This prevents the new stable key from allowing a concurrently staged comment to escape review.

Tests cover start-offset reuse, explicit-versus-implicit count equivalence, count/function/body invalidation, malformed-header fallback, a persisted receipt surviving a real Git line shift with zero judge calls, and complete-set race rejection. Detection and semantic judge behavior remain unchanged.
