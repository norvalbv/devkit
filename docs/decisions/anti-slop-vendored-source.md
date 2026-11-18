---
slug: anti-slop-vendored-source
created: 2026-11-18
---

# anti-slop-vendored-source

## Target · 2026-11-18 — Vendored anti-slop comes from the maintained norvalbv fork: fixed there, re-pinned here

**Context:** Devkit's commit gate runs 15 anti-slop rules and their shared helpers vendored byte-for-byte from dmmulroy/anti-slop. Upstream merged nothing after 2026-10-14 while 19 pull requests and 13 issues stayed open. One of them is a crash in every consumer: a valid alias chain such as type Wrapped<T> = Dict<Readonly<T>> overflowed the stack in no-unsafe-dictionary-type, and oxlint then dropped every anti-slop finding in that file, so the gate passed it silently. The byte-pin contract (oxc-toolchain-migration, 2026-10-18 note) forbids patching the vendored copy, so with upstream idle no fix could reach consumers at all.
**Ruling:** The vendored rules and shared helpers come from github.com/norvalbv/anti-slop, a maintained fork of dmmulroy/anti-slop, pinned by full commit SHA. The byte pin stands: those files are never edited in Devkit. A defect is fixed in the fork, with a RuleTester case and its pnpm check, and reaches Devkit only by a re-pin: UPSTREAM.md, ANTI_SLOP_UPSTREAM, the old pin appended to ANTI_SLOP_PRIOR_UPSTREAMS, and the vendored-source digest. The fork merges upstream pull requests with --no-ff so their authors keep their commits, and leaves the upstream pull requests open so the fork can converge back.
**Consequences:**
- Positive: A rule bug that blocks or silently passes a consumer's commit is fixed on Devkit's schedule instead of an idle upstream's. Each fix is proven by the fork's RuleTester suite (25 test files), which Devkit's vendored copy does not carry, and provenance stays an exact commit.
- Negative: Devkit's maintainer now owns the 15 rules: upstream fixes no longer arrive for free and must be merged into the fork, and changing a rule takes a fork change plus a Devkit re-pin.
**Vision-fit:** n/a — internal tooling: a commit gate that neither crashes nor false-blocks consumers
**Researched:** gh on dmmulroy/anti-slop (2026-11-17): the maintainer is active in other repositories, but anti-slop's last merge was 2026-10-14, with 19 open pull requests (oldest 2026-09-14) including the fix for the crash, unreviewed since 2026-10-24. No npm package or other maintained fork carries the fixes (PR #75 is a draft rebrand). The fork measured over four real repositories (10.8k files, all rules) against upstream main: 0 plugin crashes, 0 new false positives, 46 false positives removed; v0.2.1 and v0.2.2 change none of those findings. Adversarial alias inputs that took 28-106s or overflowed the stack on upstream finish in under 0.3s.
**Rejected:** (a) Patch the vendored copy in place: loses the upstream RuleTester suite, since Devkit vendors no tests, and breaks the exact provenance the digest test pins. (b) Wait for upstream: no merge in five weeks while the crash fails open in every consumer. (c) Catch plugin exceptions in src/index.ts: hides findings instead of fixing the rule.
**Anchored-bet:** [BET]
**Revisit-when:** dmmulroy/anti-slop resumes merging and carries the fork's fixes: re-pin to upstream and retire the fork.
**Scope:** anti-slop/src/rules/**,anti-slop/src/shared/**,anti-slop/UPSTREAM.md,cli/lib/install/anti-slop/constants.mts,cli/lib/install/anti-slop/vendored-source.test.mts
**Source:** collab · https://github.com/norvalbv/anti-slop/releases/tag/v0.2.2
- 2026-11-18 — Re-pinned to the fork's v0.2.3 (2a0fcf3) for the review fixes on the first re-pin. A type-guard redundancy check never treats an array or object literal as satisfying a structural predicate; equal type text counts as the same type only when every name resolves to the same declaration; namespaces are recorded bindings and typeof queries are never compared by text; a mapped type's key binder shadows an outer substitution; infer names are scoped to the conditional that binds them; and a type-parameter default is exempt from no-unknown-returns only on function-like declarations. b9dbc74 joins ANTI_SLOP_PRIOR_UPSTREAMS. Measured against the v0.2.2 pin over four repositories: 0 findings added or removed.
