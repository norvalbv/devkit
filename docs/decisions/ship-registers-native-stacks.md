---
slug: ship-registers-native-stacks
created: 2026-10-21
---

# ship-registers-native-stacks

## Target · 2026-10-21 — After gh pr create succeeds, and only once every ref is settled, devkit ship joins the new PR to a

**Context:** devkit ship --base <feature-branch> opened a base-chained PR that GitHub did not know was a stack, so every layer needed a hand-run 'gh stack link' afterwards; prior-art counted 11 devkit and 9 frink stacks, every one linked by hand, and a forgotten link leaves a chain GitHub merges and reviews as unrelated PRs.
**Ruling:** After gh pr create succeeds, and only once every ref is settled, devkit ship joins the new PR to a GitHub native stack by calling the public Stacks REST API through plain 'gh api' (never the gh-stack extension). One level only: it reads the new PR (already stacked: no-op; base is the repo default branch: no-op), then the single open same-repo PR whose head is that base (head=<owner>:<ref>). A parent that tops a stack gets the PR appended (POST stacks/N/add); an unstacked parent that targets the default branch gets a new [parent, PR] stack (POST stacks); a mid-stack parent, a parent on another non-default base, or more than one candidate is skipped with the reason and the 'gh stack link' to run by hand. It is ON by default, best-effort (every gh call bounded at 30s, never changes ship's exit status), emits a ship_stack telemetry row, and --no-stack opts out; --no-stack is new-ship-only and recorded in the ship intent like --draft, so a gate-blocked opt-out survives the printed --resume.
**Consequences:**
- Positive: Stacked layers show up as a GitHub stack the moment ship opens them, with no extension, no extra command and no chance to forget; the resume path keeps an opt-out the operator asked for.
- Negative: Stacking changes merge semantics: stacked PRs merge bottom-up, merging one also merges the PRs below it, a stacked PR's base is locked, and per-PR auto-merge is unavailable, so any future auto-merge Target must judge the whole downstack, not one PR. Every ship pays one extra GET; a preview API's shape change degrades to a printed skip, and chains that were never stacked are not repaired (one level only).
**Vision-fit:** n/a — internal tooling
**Researched:** github/gh-stack v0.2.1 source (cmd/link.go, internal/github/github.go); docs.github.com stacked PRs reference, REST stacks endpoints and roll-out guide (recommends the API for in-house CLIs); Mergify CLI (native registration on by default, --no-github-native opt-out); git-town #6275; gh-stack #504/#531; live GET/POST on norvalbv/devkit and a throwaway probe repo (create, already, append, mid-stack skip).
**Rejected:** (a) Shell out to 'gh stack link': its create/update mode retargets the bottom PR's base to the default branch unless --base is passed, refuses partial updates, its add mode silently re-chains appended PRs, and it is an extension consumers may lack. (b) Walk and stack the whole unstacked chain below the parent: overrides a lower layer's --no-stack and mutates the merge semantics of PRs this ship never touched, for a case default-on makes rare. (c) Leave --no-stack unrecorded like --wait-ci: the retry ship prints after a gate block carries no flags, so the opt-out would be lost and the only undo (unstack) dissolves the other layers too. (d) A config key: .devkit/config.json extraArgs already carries --no-stack repo-wide.
**Anchored-bet:** [BET]
**Revisit-when:** GitHub changes the Stacks REST API shape or eligibility rules, gh pr create gains a native stack option, or an auto-merge Target needs per-PR merges that stacks forbid.
**Scope:** cli/lib/ship/stack/**,cli/lib/ship/ship-branch.sh,cli/commands/ship.mts
**Source:** web · https://docs.github.com/en/rest/pulls/stacks
