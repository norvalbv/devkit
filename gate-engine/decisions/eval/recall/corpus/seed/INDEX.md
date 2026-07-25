# Decision Index

Living architecture record — the current ruling per axis. Each row links to its full
timeline. New rationale lives in the per-axis file.

| Axis | Current ruling | Why (hook) | Updated |
|------|----------------|------------|---------|
| [audit-log-delivery](audit-log-delivery.md) | Audit events are written synchronously and must commit before the handler responds, so a response implies an audit record. | Audit gaps during incidents made after-the-fact review impossible… | 2026-04-02 |
| [backpressure-shedding](backpressure-shedding.md) | Overload is shed at admission with a 503 and a Retry-After. Handlers never queue; a request that is admitted is a request that runs. | Queueing under overload made every request slow instead of failin… | 2026-02-05 |
| [clock-source](clock-source.md) | All timestamps come from a monotonic source, never wall clock | NTP steps produced negative durations in metrics… | 2026-01-12 |
| [config-distribution](config-distribution.md) | Configuration ships as a versioned package dependency, resolved at build time. | Hand-copied config drifted between services… | 2026-03-01 |
| [config-rollout-mechanism](config-rollout-mechanism.md) | Configuration is fetched at runtime from the control plane and hot-reloaded. It is explicitly NOT a build-time package dependency. | Packaged configuration required a full redeploy to change a flag… | 2026-03-01 |
| [payload-size-cap](payload-size-cap.md) | Inbound payloads are capped at 1 MiB and rejected with 413 | Unbounded bodies let a single client exhaust memory… | 2026-01-10 |
| [request-timeout-policy](request-timeout-policy.md) | Every inbound request carries an absolute deadline propagated to downstream calls. A handler that outlives it is cancelled, not queued. | Long-tail requests pinned worker threads until the pool starved… | 2026-02-01 |
| [retired-rate-limiter](retired-rate-limiter.md) | This row has no file on disk — a dead INDEX row, kept to exercise the drop path. | The file was removed but the row was never reaped… | 2026-01-05 |
| [retry-budget-ownership](retry-budget-ownership.md) | Retries draw from a per-caller token budget. When the budget is exhausted the call fails fast; no per-call retry counts anywhere. | Blanket per-call retries turned a partial outage into a retry sto… | 2026-02-03 |
| [session-store](session-store.md) | Sessions live in a dedicated cache keyed by session id, with a database read-through on miss. | Session reads became 40% of all database queries… | 2026-03-15 |
