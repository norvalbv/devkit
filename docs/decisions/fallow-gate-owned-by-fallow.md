---
slug: fallow-gate-owned-by-fallow
created: 2026-07-25
---

# fallow-gate-owned-by-fallow

## Target · 2026-07-25 — devkit wires fallow own hooks; it does not author a fallow gate

**Context:** devkit shipped its own fallow gate plus a 300-line staged-diff re-scoper, built on the belief that stock fallow audit blocks on any finding anywhere in the worktree. That belief was stale: fallow defaults to --gate new-only (only findings the changeset introduces fail) and accepts --diff-file/--diff-stdin for exact scoping. The reimplementation had already DRIFTED from fallow attribution — it treated introduced duplication as blocking where fallow rates it warn — and carried failure modes fallow does not have: an anonymous exit 2 blocked an otherwise-clean scoped ship with no reason surfaced anywhere (sc-1192), on top of 800KB payload suppression, JSON re-parsing, spawn-retry and diagnostics code. Roughly 700 lines of maintenance for behaviour the vendor already owns. Measured against the preserved sc-1192 ship worktree: fallow audit --diff-file staged.diff returned the identical two introduced clone groups in 2.9s, versus a full-worktree audit plus post-filter.
**Ruling:** devkit does not author a fallow gate. devkit init and devkit upgrade wire fallow OWN hooks (fallow hooks install --target git and --target agent), and devkit mirrors the agent hook onto the Cursor surface that fallow installer does not write. devkit owns installation, version pinning and surface coverage; fallow owns detection, attribution and the gate script itself.
**Consequences:**
- Positive: A repo adopting devkit gets fallow maintained gate on every surface devkit supports with no second manual install step, and the gate attribution tracks fallow releases instead of drifting from them.
- Negative: devkit gives up staged-INDEX scoping: fallow stock hook attributes against the merge-base changeset, so in a shared checkout another agent uncommitted work counts as introduced and can block your commit. Acceptable because devkit ship commits inside an ephemeral worktree holding only the briefed paths — there the changeset IS the staged set — and raw git commit in a shared tree is the workflow the protected-branch guard already steers away from. Second cost: fallow regenerates its script on every install, so consumer customisation must live in fallow config, never in the file.
**Vision-fit:** n/a — internal tooling (devkit gate distribution)
**Researched:** fallow 3.6.0 CLI surface (audit --help: --gate new-only is the default, --diff-file and --diff-stdin exist); fallow Claude-hooks integration docs; empirical A/B against the preserved sc-1192 ship worktree where both paths produced identical introduced clone groups.
**Rejected:** (a) Keep devkit own gate plus staged-filter — LOSES ON CORRECTNESS: it reimplements attribution fallow owns and had already diverged (introduced duplication blocking vs fallow warn), so consumers get a verdict fallow itself would not give. (b) Keep the filter but feed it fallow --diff-file output — LOSES ON REDUNDANCY: once the diff scopes the audit, the post-filter has nothing left to attribute. (c) Leave fallow agent hook for the consumer to install by hand — LOSES ON ADOPTION: it is the step consumers forget, and it is precisely why frink hand-patched a copy that then drifted out of sync.
**Anchored-bet:** [BET]
**Revisit-when:** fallow agent hook stops defaulting to --gate new-only, or devkit needs staged-index rather than merge-base attribution outside a ship worktree
**Scope:** cli/lib/install/install-fallow.mts,cli/commands/init.mts,agents-hooks/**
**Source:** web · https://fallow.tools/docs/integrations/claude-hooks/
