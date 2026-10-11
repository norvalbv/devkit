---
slug: release-requires-green-base-ci
created: 2026-10-10
---

# release-requires-green-base-ci

## Target · 2026-10-10 — devkit release refuses unless the base commit's CI passed

**Context:** v0.68.0 (#858) was released while gate.yml had failed on every push to main since 2026-10-02. devkit release read no CI at all: it ran the local suite and built dist from whatever the local HEAD was, and ship then opened the release PR on origin's current tip, so dist could also be compiled from a commit other than the one the PR lands on. Consumers pin immutable version tags, so a version whose CI never passed reaches every downstream install and cannot be re-cut.
**Ruling:** devkit release refuses unless the local HEAD is GitHub's tip of the release base branch (read again just before the PR opens) and that commit's newest completed run of the configured CI workflow (guard.config.json baselineStatus.workflow, default gate.yml) concluded success. Runs are read by sha with gh run list --commit, never through PR checks. A red run, no run, a cancelled, timed-out or otherwise non-success conclusion, and any gh failure all fail closed; an unfinished run is told to wait. --ci-override "<reason>" waives only a verdict that was actually read (red, missing or still running), never the tip check, gh reachability or a run read gh could not answer, and the reason, sha, verdict and run URL are written into the release PR body. The local test suite still runs after the CI read.
**Consequences:**
- Positive: devkit's own release command can no longer open a release PR from a commit whose CI never passed, or build dist from a commit other than the one the PR lands on. The refusal comes before the roughly 30-minute local suite and build, and an override leaves its reason on the release PR for anyone auditing the tag.
- Negative: Releases are blocked whenever main is red (every push run on main failed when this was recorded), and a release now needs an authenticated gh and the network. It guards a path the last eight releases (#665 to #858) bypassed by hand with --no-verify, so until devkit release can run from a clean worktree it is defence in depth. The tag is still cut by hand on the squash-merge commit, whose own CI this does not read. If origin advances during the release, the run is refused at the end and must be redone.
**Vision-fit:** n/a — internal tooling (devkit's own release path, whose tags every consumer pins)
**Researched:** gh 2.96: gh run list --workflow --commit and gh run view --json url,jobs, checked live on run 38042970754 (job gate, failed step Tests). cli/lib/ship/ship-branch.sh: the --base arm fetches origin's tip at ship time. .github/workflows/gate.yml keeps every push run on main (cancel-in-progress only for pull_request). main's ruleset has no required status check. Bun publishes canary builds only from a green main. arXiv 1907.01602: broken builds commonly stay broken for days, so a hard refusal needs a recorded override.
**Rejected:** (a) Advisory only, as at pre-push. blocking-gates-narrate-attribution-never-depend-on-it Rejected (e) because a red base used as EXCULPATION ('not your fault') licenses --no-verify; here a red base is a REFUSAL, the opposite polarity. Its firing-rate worry is also smaller: while main's Tests step is red the local suite already refused, so this mostly moves that refusal 30 minutes earlier and adds the CI-only steps (format, lint, anti-slop, structure). Its Revisit-when (gate.yml green on main) still governs pre-push. (b) Only a server-side required check on main. None exists today, and a client refusal also saves the 30-minute local run and writes an evidence line into the PR body. (c) Publish from a tag-triggered CI workflow: it would also cover the hand-cut tag, but it is a larger change across release, tagging and consumer pins. (d) Fail open on missing CI, as remoteTagExists does offline: a tag lookup can only add certainty, whereas a missing CI read is exactly the state after a broken push.
**Anchored-bet:** [BET]
**Revisit-when:** releases are published by a CI workflow, or a required status check on main plus a tag ruleset enforce green CI server-side
**Scope:** cli/commands/release.mts
**Category:** self-host-release
**Source:** shortcut · sc-5179
