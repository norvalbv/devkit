---
slug: service-to-service-auth
created: 2026-01-01
---

# service-to-service-auth

## Target · 2026-02-10 — Internal service calls require mutual TLS, no static API keys

**Context:** A static API key embedded in a config map was exposed through a debug endpoint and let a caller impersonate one internal service to three others before the key was rotated out.
**Ruling:** All service-to-service traffic on the internal network must authenticate with mutual TLS using short-lived certificates issued by the internal CA; long-lived bearer tokens or API keys are not an acceptable substitute for service identity, regardless of how they are transmitted or stored.
**Consequences:**
- Positive: a leaked credential of this kind stops granting durable, reusable access.
- Negative: every service needs a sidecar or client library that can request and renew certificates, which is nontrivial work for older services.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/internal-api/**
**Source:** seed

- 2026-04-14 — Batch jobs that run outside the service mesh (cron workers on bare hosts) cannot terminate mTLS, so they are carved out: those specific callers authenticate with a signed JWT from the auth service, valid for 5 minutes, instead of a client certificate. The mTLS requirement still applies to everything running inside the mesh.
