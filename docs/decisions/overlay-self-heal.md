---
slug: overlay-self-heal
created: 2026-06-26
---

# overlay-self-heal

## Target · 2026-06-26 — overlay survives husky reclaim via a per-clone git ci alias; init freezes once

**Context:** Overlay sets core.hooksPath (local, uncommitted) to .devkit/hooks, but the repo's committed husky prepare resets it to .husky/_ on every bun install — silently unwiring devkit's gates with no error. The documented fix, re-running devkit init --overlay, made it worse: runFreezes re-snapshotted the size and fanout baselines unconditionally, so every re-apply grandfathered all accumulated debt and the ratchets quietly stopped catching new violations. Two silent failures in the one mode meant for shared repos a team won't modify.
**Ruling:** Overlay installs a per-clone LOCAL git alias (alias.ci, in .git/config, uncommitted, dies with the clone) that re-points core.hooksPath back to .devkit/hooks and then commits — it never re-runs init. And runFreezes is now freeze-if-absent: it freezes a baseline only when that baseline file is missing, so re-applying the overlay never re-snapshots an existing one. The explicit guard-size/guard-fanout freeze CLI still re-snapshots on demand.
**Consequences:**
- Positive: Gates stay wired across bun installs through a single git ci with zero committed footprint; the size and fanout ratchets keep catching new debt because the baseline is frozen once at bootstrap, not moved up on every re-apply.
- Negative: The alias only heals on a CLI git ci — a GUI client or plain git commit in the window between an install and the next git ci runs the repo's own hooks ungated; and a user who already has a ci alias (commonly a global commit -v) gets no auto-heal by design (skip-on-collision) and must re-point with git config core.hooksPath .devkit/hooks.
**Vision-fit:** n/a — internal tooling; overlay is how devkit runs guardrails on a shared repo a team would reject a PR for.
**Researched:** cli/lib/overlay.mjs (LOCAL_HOOKS, installOverlayHook); gate-engine/ratchets/size-disable.mjs and folder-fanout.mjs (freeze overwrites the baseline from the current tree); git shell-alias arg-append + top-level run semantics, validated empirically in throwaway repos; feature-critique pass recorded at .cursor/.feature-critique.md.
**Rejected:** (a) a shell precmd or package-manager wrapper hook — REJECTED: global to every repo and lives in dotfiles, not per-clone, breaking overlay's git-invisible local-only ethos; (b) the naive alias that re-runs devkit init --overlay before commit — REJECTED: re-running init re-freezes size/fanout every commit (grandfathering new debt) and resets the guard selection to all five via selectionFromFlags; (c) clobbering any existing ci alias — REJECTED: ci is a common global alias for commit -v, and shadowing it silently breaks muscle memory.
**Anchored-bet:** [VALIDATED]
**Scope:** cli/lib/overlay.mjs,cli/commands/init.mjs
**Source:** collab
