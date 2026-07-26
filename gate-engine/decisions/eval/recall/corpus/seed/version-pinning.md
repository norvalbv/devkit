---
slug: version-pinning
created: 2026-01-01
---

# version-pinning

## Target · 2026-01-14 — Every dependency is pinned to an exact resolved version, no ranges

**Context:** A transitive dependency floated on a caret range and pulled in a minor bump overnight; the new default log format broke every downstream log parser for six hours before anyone traced the outage back to an unpinned range.
**Ruling:** Every dependency, direct and transitive, is pinned to an exact resolved version in the committed lockfile. CI fails any manifest entry that uses `^`, `~`, `*`, or a floating tag; a version bump only happens through an explicit PR that edits the pin.
**Consequences:**
- Positive: nothing new reaches production without a visible diff and a reviewer's eyes on it.
- Negative: security patches no longer land automatically; every patch, even a one-line CVE fix, waits on a human to open and merge a bump PR.
**Vision-fit:** n/a — internal tooling.
**Scope:** **/package.json, **/*.lock
**Source:** seed
- 2026-03-02 — The bump bot was given permission to auto-merge patch-level pin changes (exact version to exact version) after a week with zero manual bump PRs merged; ranges are still rejected outright, only the human-in-the-loop step for patch-level pins was relaxed.
