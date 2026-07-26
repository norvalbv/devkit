---
slug: dashboard-as-code
created: 2026-01-01
---

# dashboard-as-code

## Target · 2026-04-08 — Dashboards are defined as version-controlled files, not edited live

**Context:** A responder added a panel to a production dashboard by hand during an incident; the edit was never ported back into the dashboard's definition file, and six months later a routine redeploy from source silently reverted it, deleting a panel later investigators still relied on.
**Ruling:** All dashboards are defined as JSON files checked into the service repository and deployed by the same pipeline as application code. The dashboard UI is read-only in every environment except a designated scratch sandbox; any edit made outside that sandbox is overwritten without warning on the next deploy.
**Consequences:**
- Positive: what a dashboard shows in production always matches what is in source control.
- Negative: an urgent incident-time panel change requires a deploy cycle to make permanent, not a live edit.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/dashboards/**
**Source:** seed
- 2026-05-30 — The scratch sandbox has become a dumping ground: responders build panels there during incidents but rarely promote them back into source, so useful panels still vanish once the sandbox is periodically reset. The read-only problem this was meant to solve has resurfaced one layer over.
