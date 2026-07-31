# Effective gate duration telemetry

## Problem

The final successful `ship`, `reship`, or `commit` attempt is frequently fast because earlier attempts already earned cache entries. Charting only that final attempt therefore understates the time required to obtain the successful result. Summing the original duration of every cached reviewer would overstate it because the review gate runs a bounded worker pool.

## Metric

The primary metric is **effective successful-run wall time**: the wall-clock time the successful attempt would have taken if every cache hit had instead consumed the duration of the uncached run that earned that exact cache entry, while preserving the gate chain's serial stages and the review gate's configured parallelism.

This is distinct from both CPU time (which would sum parallel work) and the final retry's actual elapsed time. Actual elapsed time remains useful as a secondary comparison.

## Telemetry contract

Devkit emits a `gate_timing` event for each timed stage with:

- `gate`: stable stage name (`deterministic`, `decisions`, `review`, or `completeness`)
- `actual_duration_ms`: elapsed time in this attempt
- `effective_duration_ms`: elapsed time after replacing cache hits with their earned uncached durations
- `cache_state`: `none`, `partial`, or `full`
- `parallelism`: the scheduler width used to calculate effective time (one for serial stages)

Cache entries gain an optional `duration_ms` metadata field. Legacy entries without it remain valid for gate correctness but cannot contribute a replacement duration; their effective contribution falls back to the observed cache-hit duration and the event remains backward compatible.

`cache_hit` also carries `duration_ms` when known. That keeps the atomic cache evidence independently inspectable even though the dashboard reads the stage summaries.

## Stage calculations

- Deterministic: an uncached all-green prefix stores the orchestrator wall time. A full prefix hit uses that stored duration.
- Decisions and completeness: serial work uses the stored duration for each cache hit and observed duration for live work.
- Review: each selected reviewer contributes either its current cascade duration or the duration stored with its cached PASS. Devkit replays the same order-preserving bounded worker-pool algorithm with those durations and the current configured concurrency; the effective stage value is the resulting makespan, not the sum.
- Uncached overhead remains represented by the stage's actual elapsed time. Replacement only increases the stage by the difference between simulated cached work and the negligible time actually spent resolving those hits.

Only completed successful attempts are charted by the dashboard. Failed attempts still emit timing evidence for diagnostics but do not enter the successful-run series.

## Compatibility and rollout

The new event and metadata are additive. Older dashboard builds ignore them. New dashboard builds fall back to the existing successful-attempt duration when a run has no complete timing telemetry, so the chart remains populated during rollout. A telemetry completeness flag prevents partially upgraded runs from being presented as fully effective measurements.

## Verification

Tests cover legacy cache entries, uncached and full-cache stages, mixed cached/live review work, serial and parallel review scheduling, event shape, and the dashboard's effective/fallback aggregation.
