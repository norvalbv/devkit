# Decision Index

Living architecture record — the current ruling per axis. Each row links to its full
timeline. New rationale lives in the per-axis file.

| Axis | Current ruling | Why (hook) | Updated |
|------|----------------|------------|---------|
| [batch-job-concurrency-cap](batch-job-concurrency-cap.md) | Every batch job runner caps its own worker pool at four concurrent jobs per host, regardless of how many jobs are queued. | An unbounded batch job saturated a host's connection pool, starving the request-serving processes sharing the same box during the nightly run. | 2026-02-10 |
| [log-retention-window](log-retention-window.md) | Application logs expire after 30 days; audit logs (auth, permission changes, data export) expire after one year regardless of storage cost. | A storage-cost review found application debug logs accounted for most of the log-storage bill. | 2026-01-15 |
| [queue-dead-letter-routing](queue-dead-letter-routing.md) | The broker's own redelivery counter routes a message to `<queue>.dead-letter` after three failed deliveries instead of retrying forever. | A single malformed message was redelivered indefinitely, pinning a worker in a crash loop. | 2026-02-01 |
| [tenant-data-isolation](tenant-data-isolation.md) | Each tenant gets its own Postgres schema, provisioned by an automated migration on signup. | A compliance audit for an enterprise customer required a provable isolation guarantee. | 2026-03-10 |
| [webhook-retry-policy](webhook-retry-policy.md) | Webhook delivery retries with exponential backoff (1s, 2s, 4s, 8s, 16s) and gives up after five attempts, moving the payload to a dead-letter queue for manual replay. | A downstream outage caused a retry storm that amplified load on the failing service. | 2026-01-05 |
