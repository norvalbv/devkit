---
slug: connection-pooling
created: 2026-01-01
---

# connection-pooling

## 2026-01-14 — Each service process opens its own fixed-size connection pool

**Ruling:** Each service process opens and owns a fixed-size connection pool (10 connections) directly against the database on startup, sized once at deploy time.
**Why / target:** Simplest option to ship; no extra infrastructure or shared component to run and monitor.
**Source:** seed
- 2026-02-27 — SUPERSEDED_BLOCK_MARKER: this note belongs to the retired per-process pooling ruling.

## 2026-04-08 — Connections are borrowed from a shared external pooler, not per-process pools

**Ruling:** Every service borrows connections from a shared external connection pooler; no service process opens a direct pool against the database itself.
**Why / target:** A horizontal scale-out event multiplied per-process pools across new pods, and total open connections blew past the database's max_connections ceiling, taking the database down for every service at once, not just the one that scaled.
**Source:** seed
- 2026-05-19 — The pooler's own connection cap now has to be sized for worst-case service count, and a misconfigured cap there would reproduce the exact outage this ruling was meant to prevent — the risk moved, it did not disappear.
