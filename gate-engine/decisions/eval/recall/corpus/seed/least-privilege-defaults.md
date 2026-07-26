## 2026-03-05 — New service accounts start with zero permissions

**Ruling:** Every newly provisioned service account is created with no permissions attached. Access to any resource — a database, a queue, a storage bucket — must be requested and granted individually; there is no shared "default" role that new accounts inherit automatically.
**Why / target:** A worker service was provisioned under a team-wide default role that happened to carry read access to the full billing dataset. Nobody had asked for that access; it was just what new accounts got. It was only noticed when the worker's debug logging dumped rows from that dataset. The target is that a service's permission set is always traceable to an explicit request, never to "whatever the default happened to include."
**Source:** seed

- 2026-05-02 — Pure zero-default caused a two-week wave of failed deploys because every service, without exception, needs read access to the shared observability metrics namespace just to emit health checks. That one namespace is now pre-granted to all new accounts; every other resource still requires an explicit request. The ruling above is otherwise unchanged.
