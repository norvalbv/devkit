---
slug: trace-sampling-rate
created: 2026-01-01
---

# trace-sampling-rate

## Target · 2026-02-18 — Every multi-service request is captured regardless of head-sampling odds

**Context:** A latency regression traced back to one downstream dependency was invisible in tracing because the originating request wasn't head-sampled; on-call spent six hours reconstructing the path from service logs before finding it.
**Ruling:** Requests are head-sampled at 10% for successful responses and 100% for any response that errors. Independent of that decision, any request that fans out to more than five services is guaranteed to be captured in full via a tail-based override at the collector, which buffers spans and retroactively marks the trace for storage once the fan-out threshold is crossed.
**Consequences:**
- Positive: multi-hop failures stay debuggable without needing to raise the head-sampling rate for everyone.
- Negative: the collector must hold spans in memory until the tail decision is made, which costs both memory and decision latency.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/tracing/**
**Source:** seed
- 2026-03-05 — Head sampling and the 100%-on-error path confirmed working at initial rollout; ten services onboarded cleanly.
- 2026-04-02 — Tail-based override PARKED: the collector cannot buffer spans long enough to make the fan-out decision at current traffic volume without risking OOM, so it was disabled above baseline traffic. Requests with more than five downstream calls are now only captured if they were already head-sampled or errored — the "guaranteed" capture does not happen.
- 2026-05-20 — Still blocked; the buffering rework needed for tail-based sampling is unscheduled. Treat the fan-out guarantee as aspirational — actual behavior for large fan-out requests is identical to any other successful request, capture is probabilistic, not guaranteed.
- 2026-06-11 — Workaround in use: investigators manually force-sample a trace id via a header override when they already suspect a specific request, but this requires knowing the request id in advance and is not automatic.
