---
slug: tenant-data-isolation
created: 2026-02-01
---

# tenant-data-isolation

## Target · 2026-02-01 — Tenant data lives in a shared schema with a tenant_id column

**Context:** A schema-per-tenant approach was rejected at launch as too slow to provision for a handful of pilot customers, so every table carries a tenant_id and every query filters on it.
**Ruling:** All tenant rows share one schema, distinguished by a tenant_id column enforced by a row-level security policy.
**Consequences:**
- Positive: Onboarding a new tenant is a single INSERT, not a migration.
- Negative: A missing tenant_id filter in a new query is a silent cross-tenant leak, caught only by the RLS policy.
**Vision-fit:** Matches the fast-onboarding requirement for the pilot cohort.
**Scope:** src/db/tenancy/**
**Source:** manual

## Target · 2026-03-10 — Tenant data moves to schema-per-tenant isolation

**Context:** A compliance audit for an enterprise customer required a provable isolation guarantee the row-level-security approach could not certify — an RLS policy protects against a missing filter, not against a misconfigured one.
**Ruling:** Each tenant gets its own Postgres schema, provisioned by an automated migration on signup.
**Consequences:**
- Positive: Isolation is enforced by Postgres's own schema boundary, satisfying the audit requirement outright.
- Negative: Onboarding now runs a real migration per tenant, and cross-tenant reporting queries need a fan-out instead of one filtered query.
**Vision-fit:** Unlocks the enterprise tier, which the shared-schema approach could not sell into.
**Scope:** src/db/tenancy/**
**Source:** manual
**Evidence-change:** The enterprise compliance audit required a certifiable isolation guarantee the shared-schema RLS approach could not provide.
