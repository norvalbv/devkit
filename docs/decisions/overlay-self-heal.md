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

## Target · 2026-06-29 — Plain git commit gap closable via an opt-in, uninstallable global husky init.sh shim

**Context:** Overlay's accepted gap bit in practice: the per-clone git ci alias heals only a CLI git ci, so a plain git commit or a GUI-client commit ran UNGATED after husky reclaimed core.hooksPath on a bun install. On frink this silently skipped devkit's gates — the exact silent-unwiring the original ruling set out to bound.
**Ruling:** Keep the per-clone git ci alias + freeze-if-absent as the invisible DEFAULT. ADD an OPT-IN machine-global husky init.sh shim (one marker block, via devkit init --overlay --global-commit-gate) that runs the overlay's pre-commit gates GATES-ONLY (a gates-only env flag makes the overlay hook stop before chaining, so husky's own _/h still runs the committed hook — no double-run) for any repo that has .devkit/hooks, resolving the repo root via git rev-parse (not cwd). It is a guarded no-op in package-mode / non-devkit / non-husky repos, honors HUSKY=0, and is removed by devkit clean --global (a per-repo clean LEAVES it, since one shim is shared across all overlaid repos).
**Consequences:**
- Positive: A plain git commit and GUI-client commits stay gated in every overlaid repo on a machine that opted in, surviving husky's reclaim across bun installs — no more silent un-gating and no reliance on remembering git ci.
- Negative: One opt-in machine-global file (~/.config/husky/init.sh) — a guarded no-op outside overlaid repos and uninstallable, but still the single piece of global state the per-clone ethos avoided. Two residual holes, both documented + doctor-warned: a husky repo with NO committed .husky/pre-commit cannot be covered (husky's _/h exits before sourcing init.sh), and the shim runs a repo-local .devkit/hooks/pre-commit (only in repos the user themselves overlaid, so no wider trust surface than husky's existing init.sh).
**Vision-fit:** n/a — internal dev tooling (overlay runs guardrails on a shared repo a team would reject a PR for).
**Researched:** Verified against husky 9.1.7: index.js sets core.hooksPath unconditionally on every prepare; .husky/_/h sources the XDG-aware ~/.config/husky/init.sh BEFORE running the committed hook, with an early exit when no committed hook exists and a HUSKY=0 exit AFTER the source. A feature-critique pass (PROCEED) confirmed the flow, the hook-name detection, abort propagation, and drove the cwd / no-committed-hook / HUSKY=0 fixes.
**Rejected:** (a) auto-install the shim on every devkit init --overlay — REJECTED: machine-global state without explicit consent resurrects the original global-to-every-repo objection; kept opt-in. (b) a PER-REPO seam that survives the reclaim — IMPOSSIBLE: the committed .husky/pre-commit is git-visible (overlay must stay invisible), .husky/_/h is husky-regenerated, and core.hooksPath is the very thing reclaimed; husky exposes only the GLOBAL init.sh. (c) close the no-committed-pre-commit hole with a git-ignored .husky/pre-commit stub — REJECTED for v1: more .husky/ footprint than overlay's invisibility budget allows; documented + doctor-warned instead.
**Anchored-bet:** [VALIDATED]
**Scope:** cli/lib/overlay.mjs,cli/lib/overlay-global-hook.mjs,cli/lib/husky/**,cli/commands/clean.mjs,cli/commands/doctor.mjs
**Source:** collab · overlay-global-commit-gate
**Evidence-change:** husky's native ~/.config/husky/init.sh hook is a newly-recognized seam, narrower than the rejected generic shell-precmd: it fires ONLY inside husky's own hook chain and is a guarded no-op outside overlaid repos. Made opt-in and uninstallable, so the per-clone/invisible default is preserved while the knowingly-accepted plain-commit gap becomes closable on demand.
