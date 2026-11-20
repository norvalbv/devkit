---
slug: cli-exit-drains-event-loop
created: 2026-11-20
---

# cli-exit-drains-event-loop

## Target · 2026-11-20 — devkit's CLI ends by draining the event loop, not process.exit

**Context:** On Node 24, process.exit() can deadlock forever: platform shutdown joins V8's background compile threads while the isolate is alive, and a Sparkplug or Maglev job parked waiting for a main-thread GC never wakes (nodejs/node#64274, fix pending in nodejs/node#66171). devkit's dispatcher ended every command with process.exit, so a finished command could hang at 0% CPU. prove-regression.test.mts saw this as a 90s harness deadline about once per 500 CLI calls under load, the CLI having printed its result 1s in; the sampled stack was main thread in WorkerThreadsTaskRunner::Shutdown, V8Worker in CollectionBarrier::AwaitCollectionBackground. A consumer hook or ship that runs devkit can hang the same way.
**Ruling:** cli/index.mts ends a dispatched command, returned or thrown, through exitWhenDrained (gate-engine/deterministic/reason.mts): it sets process.exitCode and lets the event loop drain, which disposes the isolate before the platform, and an unref'd 1s timer calls process.exit only when a handle still holds the loop. stdoutDrained stays ahead of it to bound a slow pipe reader on that forced path. A throw under a gate run (GATE_REASON_ENV set) keeps crashExit's immediate exit, which the crash preload of other gates shares.
**Consequences:**
- Positive: A command that has finished exits with its own code instead of wedging until a supervisor's deadline, so devkit stops producing load-only 124s in its own suite and in consumer hooks.
- Negative: A command that leaves a ref'd handle (a timer, an unreaped child, an open socket) now runs up to 1s longer before the forced exit, and in-flight async work keeps running during that second instead of being cut. The forced path still calls process.exit, but only after the loop has run idle for 1s and serviced any pending GC request. Not migrated yet: the pre-dispatch exits in cli/index.mts (--version, help, unknown command, <cmd> --help), crashExit, and about 220 other process.exit calls in gate and command code.
**Vision-fit:** n/a - internal tooling; devkit runs inside consumer commits, where a hung exit blocks the commit.
**Researched:** nodejs/node#64274, #67596 (repro and stacks), #54918, #66171 (proposed fix); downstream mitigations in cloudflare/nimbus#382 and nrwl/nx#36726. Local repro of #67596 under 8-way load on Node 24.19.0: 2/400 hung with process.exit, 0/400 with exitCode plus unref'd fallback.
**Rejected:** (a) Raise the 90s test deadline or move the file to another vitest project - REJECTED: the deadline caught a real hang (test-deadlines-are-hang-detectors), and both projects share one pool and deadline. (b) Disable concurrent Sparkplug/Maglev with V8 flags - REJECTED: devkit does not own the node command line in a consumer, and v8.setFlagsFromString after startup is unsupported. (c) Pin Node 22 - REJECTED: consumers choose their Node.
**Anchored-bet:** [VALIDATED]
**Revisit-when:** Every Node major devkit supports carries the nodejs/node#66171 fix, at which point process.exit is safe again.
**Scope:** cli/index.mts,gate-engine/deterministic/reason.mts
**Source:** web · https://github.com/nodejs/node/issues/64274
