---
slug: release-approval
created: 2026-01-01
---

# release-approval

## Target · 2026-05-12 — A release requires sign-off from someone other than its author

**Context:** An author pushed what looked like a low-risk config change straight to production; it silently disabled a rate limiter, and because no one else knew the change had shipped, the resulting outage took hours to trace back to a deploy nobody else had seen.
**Ruling:** Every production release requires an approval from someone other than the author, recorded in the release record before the pipeline will deploy. There is no "low risk" bypass — the approval requirement is enforced by the pipeline itself, not by judgment call at push time.
**Consequences:**
- Positive: at least two people always know a release is happening before it reaches production.
- Negative: a release can't ship outside business hours unless a second approver is also awake and available, which has already delayed at least one legitimate emergency fix.
**Vision-fit:** n/a — internal tooling.
**Scope:** deploy/**, ci/**
**Source:** seed
