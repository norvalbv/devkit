---
slug: artifact-immutability
created: 2026-01-01
---

# artifact-immutability

## Target · 2026-02-18 — A published artifact tag is never overwritten

**Context:** A hotfix was republished under the same version tag as the original build to save a version bump; some hosts had already cached the original artifact, so two different binaries ran under one version label and the resulting behavior split took two days to diagnose as anything other than a flaky host.
**Ruling:** Once a build artifact is pushed to the registry under a version tag, that tag is immutable — no republish, no overwrite, not even for a single-line fix. Any change, however small, ships under a new version number, and the registry itself rejects a push to an existing tag.
**Consequences:**
- Positive: a version number always means exactly one binary, everywhere, forever.
- Negative: even a trivial one-character hotfix burns a full version number and a full release cycle.
**Vision-fit:** n/a — internal tooling.
**Scope:** build/**, registry/**
**Source:** seed

## [archived — superseded by the ruling above]
- 2026-01-22 — Temporary incident exception: an artifact under 5 KB may overwrite its own tag if republished within one hour of the original push, to unblock active incident response without waiting on a full release.
- 2026-02-05 — Exception window cut from one hour to fifteen minutes after an overwrite landed outside the original hour and poisoned a build cache on three hosts.
