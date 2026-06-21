# Piece 5 (DEFERRED) — advisory "suggest-structure" tool

> **Status: DEFERRED by the user** ("Defer but keep a note so we can pick it up later"). Not built.
> This stub captures the validated design so it can be picked up after Piece 3 proves the engine.
> Full rationale + citations: [`research-auto-foldering.md`](research-auto-foldering.md) §3–§5.2.

## What it is (and isn't)

An **advisory recommender** that looks at a repo and suggests structural improvements — separate from,
and never a gate on, the deterministic structure engine (Pieces 1–4). It does **two things only**:

1. **Misplaced-file detection** — a file whose dependency mass + name similarity points to a different
   directory → a single high-confidence move, *with the dependency evidence that justifies it*.
2. **Per-directory cohesion score** — flag "god folders" / incoherent packages as a *signal*.

It is **NOT** a from-scratch neural tree generator. The literature's dominant failure mode is exactly
that: high churn, low trust, unstable under small edits, hard to verify (§3.5).

## Algorithm (decided, classic, deterministic)

- **Modularity / TurboMQ hill-climbing seeded from the current boundaries** (or HDBScan-style
  hierarchical density clustering). Chosen because the strongest independent 2026 eval
  (arXiv:2601.23141) shows classic clustering **beats GNN/embedding methods on reliability with zero
  training** — the right fit for a deterministic CLI.
- **Features, fused:** direct symbol-level import edges (fallow `trace_dependency` / `get_blast_radius`)
  **+** identifier/name cosine (the source of human-readable folder names) **+** git co-change.
- **Down-weight omnipresent hubs** before clustering (fallow `get_importance` / `get_hot_paths`) — or
  they smear every cluster.

## Mandatory guards (each maps to a cited failure mode)

1. **Null-model shuffle check** before surfacing anything — if real-repo MQ isn't clearly above a
   degree-preserving shuffle, suppress the suggestion (Mitchell/Mancoridis).
2. **Multi-metric** scoring (a2a + cluster-coverage, never MQ alone) (Garcia a2a).
3. **Hard churn cap** — only high-confidence single-file moves (NSGA-III lever).
4. **Allow overlap / multi-home** for cross-cutting files.
5. **Advisory only** — present suggestions; never grade existing folders as ground truth; never gate.

## Pick-up trigger

After Piece 3 validates the engine on devkit's own repo (and Piece 4 on frink-primitives), revisit.
Seed the clustering from `list_boundaries`; report MQ/SM delta as the "how much better" signal. An
LLM-native naming layer is a reasonable *label* on top of the clustering core — not the placement
engine, and not before the core is validated against real repos.
