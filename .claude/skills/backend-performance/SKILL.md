---
name: Backend Performance
description: Performance optimization for backend services and APIs. Use when optimizing database queries, implementing caching, scaling services, profiling slow endpoints, or improving API response times. Covers caching strategies, database optimization, connection pooling, async processing, event-loop hygiene, and monitoring.
---

# Backend Performance

## Review Script

```bash
SCRIPT=".claude/skills/backend-performance/scripts/checklist.mjs"

node $SCRIPT generate     # Enumerate review items from staged backend files
node $SCRIPT status       # Show progress
node $SCRIPT check-item <name> --pass   # Mark item passed
node $SCRIPT check-item <name> --fail "reason"  # Mark item failed
node $SCRIPT finalize     # Verify every item was resolved; refuses if any are pending or failed
node $SCRIPT cleanup      # Remove checklist
```

The backend roots the script scans come from `guard.config.json` `review.backendRoots` — not
hardcoded. When that key is absent it scans all staged files; a present-but-invalid value warns
and falls back to scanning all.

Each section below is one checklist item (or a small group). Rules name the evidence to grep for
and the condition that makes the item a FAIL — pass anything that doesn't meet a FAIL bar. Judge
the code that runs per-request hardest; startup/CLI/one-off paths get latitude.

## Database (`db-query-optimization`, `select-star`, `n-plus-one`, `pagination`, `indexing`, `connection-pooling`)

```typescript
// Batch instead of per-row queries
const users = await db.users.findMany({ where: { id: { in: userIds } } })

// Bounded, field-selected page
const page = await db.users.findMany({
  take: 20,
  skip: page * 20,
  select: { id: true, name: true, email: true },
})
```

- `n-plus-one`: FAIL a query issued inside a loop / `.map` over rows when a single `IN` /
  join/`include` fetch would serve. This is the highest-value catch in the catalog.
- `select-star`: FAIL `SELECT *` (or ORM fetch-everything) on wide/hot tables when the consumer
  uses a few fields.
- `pagination`: FAIL a new unbounded list read (`findMany` with no `take`/`limit`) on a
  user-growable table.
- `indexing`: FAIL new query shapes filtering/sorting on columns that no migration or schema in
  the diff indexes, when the table is plausibly large.
- `connection-pooling`: FAIL a client/connection constructed per request instead of a shared
  pool; FAIL pool settings that obviously mismatch the runtime (e.g. max 1 under concurrency).
- `db-query-optimization` (catch-all): FAIL redundant repeat reads of the same row in one
  handler, joins that fetch entire relations for a count, or work movable into the query.

## Caching (`caching-strategy`, `unbounded-cache`)

```typescript
// Cache-aside with a TTL
async function getUser(id: string) {
  const cached = await redis.get(`user:${id}`)
  if (cached) return JSON.parse(cached)
  const user = await db.users.findUnique({ where: { id } })
  await redis.set(`user:${id}`, JSON.stringify(user), 'EX', 3600)
  return user
}
```

- `caching-strategy`: FAIL repeated expensive reads (per request) of data with an obvious
  cache point that the diff ignores; FAIL cache writes with no invalidation/TTL story where
  staleness is user-visible.
- `unbounded-cache`: FAIL a module-scope `Map`/`Set`/object/array that accumulates per-request
  or per-session entries with no eviction (TTL, LRU, max-size) and no lifecycle bound — that is
  a slow memory leak. PASS request-scoped collections and fixed-size registries populated at
  startup.

## Asynchronism (`async-handling`)

```typescript
// Queue heavy work instead of doing it in the request
await queue.add('processVideo', { videoId, userId })
```

- FAIL heavy CPU or long-IO work done inline in a request handler when a queue/worker already
  exists in the repo.
- FAIL serial `await`s over independent operations where `Promise.all` halves the latency —
  when the list is non-trivial and the operations are genuinely independent.

## Event-Loop Hygiene (`sync-io`)

- FAIL synchronous filesystem or process calls (`readFileSync`, `execSync`, `spawnSync`, …) on a
  request-serving path — each call blocks every concurrent request on the event loop.
- PASS the same calls at module init, in CLI entry points, in build scripts, or in test code:
  blocking is harmless where there's no concurrency to block.

## Code Optimization (`streaming`, `batching`, `timeout-retry`)

- `streaming`: FAIL buffering a large file/result fully into memory to send it, when a stream
  pipe serves; watch `Buffer.concat`/`readFile` on user-sized payloads.
- `batching`: FAIL N sequential round-trips (HTTP or DB) that a documented batch API covers.
- `timeout-retry`: FAIL new outbound calls with no timeout/abort path (a hung dependency hangs
  the handler); FAIL retry loops with no cap or backoff — they amplify outages.

## API Response (`response-optimization`)

- FAIL serializing megabyte-scale payloads where the client uses a fraction (missing field
  selection or pagination at the response layer).
- FAIL expensive recomputation per response of values that are constant per deploy or per
  entity.

## Network (`network-optimization`)

- FAIL per-call client construction for HTTP clients that support keep-alive/agent reuse.
- FAIL static assets served through the app when a CDN/static layer is already configured.

## Monitoring (`logging-overhead`)

- FAIL logging inside per-item hot loops or debug-level serialization of large objects on
  request paths (`JSON.stringify(bigThing)` in a log call that always evaluates).
- Prefer structured, sampled, or level-gated logging on hot paths.

## Provenance

Rule text above is written for this repo. Topic coverage was diffed against:

- **roadmap.sh Backend Performance best practices** (coverage checklist only; content license is
  personal-use): sections Caching, Databases, Asynchronism, API Response, Code Optimization,
  Network, Monitoring → items `caching-strategy`, `db-query-optimization`, `select-star`,
  `n-plus-one`, `pagination`, `indexing`, `connection-pooling`, `async-handling`, `streaming`,
  `batching`, `timeout-retry`, `response-optimization`, `network-optimization`,
  `logging-overhead`.
- Own additions from gate history (no external source): `sync-io` (event-loop blocking),
  `unbounded-cache` (memory lifetime).

Rejected topics (not judgeable from a staged diff by a read-only reviewer): load balancing,
horizontal/vertical scaling, replication, sharding, slow-query log operations, DB maintenance
(vacuuming), compiled-language rewrites, architectural decomposition, performance-testing
process, dashboarding stacks.
