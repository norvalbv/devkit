---
slug: cli-cross-process-lock
created: 2026-10-08
---

# cli-cross-process-lock

## Target · 2026-10-08 — CLI cross-process mutexes use the nonce-named-holder lock, never an age reap

**Context:** sc-4282: cli/lib/atomic-write.mts withLock (mkdir, then stamp a holder file; reap on 60s age plus a dead pid) guarded the reconcile manifest, ship intent, anti-slop, oxc and init state while its own docstring admitted a two-reaper race, and ship-machine-wide-queue Rejected (h) had already ruled that shape unsafe. Every feature needing a mutex rediscovered lock fencing one reviewer round at a time; the ship queue alone spent about four ship attempts on it.
**Ruling:** withLock and withLockAsync (cli/lib/atomic-write.mts) and the ship queue lock all run on one primitive, gate-engine/judge/process/process-lock.mts. The lock is a directory renamed into place already holding one file NAMED by the holder's nonce (pid plus OS start identity), so it is never ownerless. A holder is reaped only when it is provably gone (dead pid, or a live pid whose start identity changed), by renaming exactly <lock>/<nonce> away and then rmdir: an atomic compare-and-delete. There is no age reap and no reap lock. The reap check runs on first contention, then at most every 250ms, and the holder's own identity is memoized per process, so an uncontended acquisition forks nothing extra. Staged and grave siblings end in .lock so a consumer's .devkit/*.lock ignore hides crash litter. A lock left by an older devkit (a 'holder' file stamped pid:uuid) is read as legacy and reaped only when its pid is dead. The primitive supersedes the queue/queue-lock.mts path named in the ship-machine-wide-queue Rulings.
**Consequences:**
- Positive: A paused but live holder (SIGSTOP, a suspended laptop) is never evicted, two reapers can never delete a fresh holder, and a killed holder is recovered on the next contention, so read-modify-write callers no longer risk a lost update. New callers reuse one vetted shape instead of re-deriving fencing in review.
- Negative: Mixed-version residuals: an older devkit still age-reaps a new-format lock after 60s; the new empty-directory takeover can race an older acquirer between its mkdir and its stamp; and reaping a legacy 'holder' file by name is not a compare-and-delete, since an older devkit can re-stamp the same name between our read and our rename. All need two devkit versions in one repo at once and are widest on the minutes-long init lock. A contended acquire forks ps up to four times a second. The primitive is not yet devkit's only mutex: agent-asset-manifest/lock.mts, gitignore-cache withFileLock, gate-engine/eval/publish-lock.mts, gate-engine/review/overrides.mts and reship.sh's publish lock remain.
**Vision-fit:** n/a — internal tooling
**Researched:** Prior-art pass: proper-lockfile and npm/lockfile decide staleness by mtime age; fs-ext and os-lock are native fd locks a bash span cannot hold; Node declined flock (nodejs/node#49256, NOT_PLANNED). docs/decisions/ship-machine-wide-queue.md Rejected (a), (h), (i). Two feature-critique passes (PROCEED_WITH_CHANGES). A two-process smoke test: 2x500 withLock increments gave 1000, and a SIGKILLed holder was reaped by the survivor.
**Rejected:** (a) proper-lockfile or npm/lockfile: mtime staleness evicts a paused live holder. (b) A flock/lockf helper or native fd lock: excluded by ship-machine-wide-queue Rejected (a). (c) Keeping withLock's mkdir-then-stamp shape: two reapers can delete a fresh lock and an unstamped lock is reapable by age. (d) Repointing all 13 withLock call sites: the wrappers keep them unchanged.
**Revisit-when:** Node ships a portable advisory file lock, or the remaining locks listed in the Negative migrate onto the primitive.
**Scope:** gate-engine/judge/process/process-lock.mts,cli/lib/atomic-write.mts
**Source:** shortcut · sc-4282
