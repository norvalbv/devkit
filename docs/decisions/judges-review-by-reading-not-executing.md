---
slug: judges-review-by-reading-not-executing
created: 2026-10-05
---

# judges-review-by-reading-not-executing

## Target · 2026-10-05 — Gate judges review by reading, never by executing the code under review

**Context:** A commit gate judge is defined by a claude tool allowlist: read tools, three git read commands and one checklist script, so a claude judge cannot run a project's tests. Routed to a gpt model, the same judge becomes codex exec in a workspace-write sandbox, and codex exec has no per-command allowlist, so the judge holds a general shell. Staged-tree tamper detection replaced the allowlist's cannot-write half; nothing replaced its cannot-execute half. A codex commit-guard judge then ran newly staged git-integration tests inside its sandbox, where setuid binaries such as ps will not exec, and returned FAIL 'both newly staged regression tests fail', confirmed on escalation. The tests passed outside the sandbox. One ship attempt of about 25 minutes was lost, and the only way past was moving every judge to the claude family, where the reviewers ran degraded and advisory, so one false FAIL cost the change its blocking review.
**Ruling:** A gate judge reviews by reading. It does not execute the code under review: no test suites, builds, package scripts or staged files. A command that failed or was denied in the judge's own shell is not evidence about the staged change and is never a finding; test pass or fail belongs to the deterministic suite run that the same ship already performs outside any judge sandbox. On the claude path the CLI allowlist enforces this. On the codex path it is held by an instruction appended to every tool-equipped judge's prompt at the single argv-translation seam, so every codex judge with a shell receives it and no claude prompt changes.
**Consequences:**
- Positive: A consumer is not blocked by a reviewer reporting its own sandbox's limits as a regression in their diff, and does not have to trade the blocking review away to get past it. Test results keep one authority: the suite run in the real environment.
- Negative: On codex the contract is an instruction, not enforcement: a judge that ignores it can still run a test, hit a denial and block exactly as before, so this lowers the rate and guarantees nothing. It is also a deliberate family fork: codex judges read a sentence claude judges do not, and judge-visible bytes now change in the codex seam, which every reviewer bench hash must include.
**Vision-fit:** n/a — internal tooling
**Researched:** openai/codex source: exec forces approval policy Never, and under Never an unmatched command is allowed (core/src/exec_policy.rs), so no default-deny allowlist exists; open upstream requests #47652 and #6049 confirm it. Local reproduction on codex-cli 0.159.3: ps is refused under the seatbelt sandbox. A local codex session log shows judges read files through cat, sed and rg in one exec tool. Peer consumers get per-command gating only through codex app-server with host-decided approvals.
**Rejected:** (a) Widen the judge sandbox — loses on feasibility and safety: no writable-root change makes a setuid binary exec, and it loosens a process that reads untrusted diffs. (b) Classify sandbox failure signatures as inconclusive — loses on soundness: it is an open-ended keyword match over free-form command output, which upstream's own denial detection admits to being, and an inconclusive reviewer still stops a strict ship. (c) Void a FAIL whose transcript shows a command outside the allowedTools grant — loses on false blocks: every codex judge reads through cat, sed and rg, and the commit-guard brief itself names two commands outside the grant. (d) Move judges to codex app-server with host approvals — the only route to a real allowlist, set aside on cost: it replaces the spawn seam for one family.
**Anchored-bet:** [BET]
**Revisit-when:** A codex-family judge FAIL is again traced to a command the judge executed itself after this instruction shipped, or codex exec gains a per-invocation command allowlist or deny rules usable alongside ignore-user-config.
**Scope:** gate-engine/judge/codex/**
**Source:** collab
