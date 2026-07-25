---
slug: config-rollout-mechanism
created: 2026-01-01
---

# config-rollout-mechanism

## Target · 2026-03-01 — Configuration is fetched at runtime from the control plane, NOT packaged

**Context:** Packaged configuration required a full redeploy to change a flag, so urgent changes took hours.
**Ruling:** Configuration is fetched at runtime from the control plane and hot-reloaded. It is explicitly NOT a build-time package dependency.
**Consequences:**
- Positive: the failure above stops recurring.
- Negative: a cost is knowingly paid here.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/config/**
**Source:** seed
