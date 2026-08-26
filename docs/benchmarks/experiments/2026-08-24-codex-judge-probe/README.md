# Codex judge probe — OpenAI models as gate judges on real large diffs, 2026-08-24 (sc-2049)

**Outcome: codex-CLI judges are VIABLE gate judges, and two conditions decisively beat every
round-1 Claude arm on tier-A recall.** `gpt-5.6-sol` at `chunk:400` re-found **13/23**
telemetry-labelled known defects and `gpt-5.6-terra` at reasoning-effort `xhigh` on the
**whole diff** re-found **11/23**, against round-1 sonnet's best of 8/23 (chunk arms) and 5/23
(whole). Protocol compliance was essentially perfect: 839/840 codex judge tasks returned a
terminal checklist verdict (1 inconclusive, re-drivable) — the failure mode that futility-stopped
round 1's haiku arm did not appear. Marginal judge cost was $0 (Codex subscription; see Caveats).

Replicates round 1 ([`../2026-08-23-scale-probe/`](../2026-08-23-scale-probe/README.md)) exactly:
same 8 archived diffs, same decontaminated v5 labels (23 tier-A), same arms
(`whole`, `chunk:1000`, `chunk:400`), same mining/scoring code (devkit main, post-#439), 4-lens
split, issue cap 3/lens, K=1. One diff (`e236ba4b`) does not materialize on any candidate commit
— skipped in round 1 too; effective corpus 7 diffs. Judges ran through the codex exec adapter
(#447): hermetic spawn, `turn.failed`/`error` as outages, evidence on stdin.

## Pooled tier-A recall (out of 23 decontaminated labels)

| condition | whole | chunk:1000 | chunk:400 | terminal tasks |
|---|---|---|---|---|
| sonnet (round 1) | 5/23 | 8/23 | 8/23 | — |
| haiku (round 1) | — | — | futility-stopped | protocol-void 6/8 diffs |
| gpt-5.6-sol @default effort | 5/23 | 7/23 | **13/23** | 210/210 |
| gpt-5.6-terra @default | 3/23 | 6/23 | 5/23 | 209/210 |
| gpt-5.6-terra @high | 4/23 | 3/23 | 4/23 | 210/210 |
| gpt-5.6-terra @xhigh | **11/23** | 7/23 | 7/23 | 210/210 |

## The two findings beyond the headline

1. **Chunk size and reasoning effort are ALTERNATIVE strategies, not stacking ones.** Sol (and
   every default-effort model, sonnet included) gains from smaller chunks; terra-xhigh gains from
   the WHOLE diff and loses most of its edge under chunking (11/23 whole vs 7/23 chunked). High
   effort appears to substitute for small context.
2. **Terra's effort-recall curve is a cliff, not a slope.** Whole-diff ladder: default 3/23 →
   high 4/23 → xhigh 11/23. The intermediate tier buys ~nothing; the top tier buys everything
   measured. (Public-leaderboard "~5% intelligence gain high→xhigh" translated to +7 labels here.)

## Decision this feeds

Two statistically-tied finalists, both >> the Claude status quo: sol+chunk:400 (higher recall,
pricier model per token) vs terra-xhigh+whole (sustainable subscription economics, and NO
chunking machinery needed on the correctness path — which would shrink sc-1907 substantially).
Extras precision was NOT verified (owner skipped the sonnet verifier pass on cost grounds) — a
production flip still requires it, since chunked/high-recall arms also predict more extra issues
and the gate blocks. Re-prices sc-1997: chunk/effort arms can run on subscription.

## Caveats (travel with every number above)

- n = 23 labels: the finalists (13 vs 11) are within noise of each other; both vs sonnet's 8 and
  vs whole-arm baselines are the robust comparisons. K=1 throughout.
- Wall-clock per task is INDICATIVE ONLY and excluded from decisions: the effort arms ran
  parallel-by-diff (4×~3 concurrent judges) while default arms ran serial, and unrelated machine
  load overlapped. Medians for the record: default 41s, high 66s, xhigh 114s.
- No per-task token accounting exists for ANY arm: scale-bench silences telemetry at process
  start, so the armed gate-event sink was discarded (sc-2070 makes the bench self-ledger).
- Effort was forced via a wrapper binary injecting `-c model_reasoning_effort=...` (the adapter
  has no effort knob yet — sc-2070); effort is NOT part of checkpoint identity, so effort arms
  are segregated by output directory, not by key.
- Subscription-billed judges carry `cost_usd: 0` + a billing marker; dollar aggregates must
  exclude, not sum, such rows (sc-2056).
- Codex binary pinned to codex-cli 0.149.0-alpha via `GUARD_CODEX_BIN` (two versions on PATH).

Raw inputs, per-issue predictions, checkpoints, and the auto-generated scoreboard live in the
owner-local research dir per
[`scale-track-third-party-data`](../../../decisions/scale-track-third-party-data.md) — committed
here: counts, condition names, diff hashes, and label tallies only.
