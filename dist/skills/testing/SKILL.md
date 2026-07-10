---
name: testing
description: Use when writing, running, or reviewing automated tests as part of a change — deciding what to test, running the suite, fixing failures, and judging whether coverage of the change is adequate. Covers the write-then-run pipeline, the max-2-fix-cycle rule, and the hard rule never to weaken or skip a test to make the suite pass. Tool- and stack-agnostic.
---

# testing

The discipline for testing a change: write the test, run the suite, fix real failures, and never cheat the bar. Stack-agnostic — the *command* differs per repo, the *pipeline* does not.

## The test command

Read `testCommand` from `guard.config.json` at the repo root. If it is unset, use the project's documented test script (e.g. the `test` script in `package.json`). Run that one command; do not invent your own runner invocation, since a repo's script often sets up the environment (native ABI, env vars, fixtures) that a raw runner call skips.

## When to run

- After any substantive code change, before declaring the work complete.
- After fixing a failing test, to confirm the fix and check for regressions.
- Before a commit that touches implementation source.

Docs-, config-, and comment-only changes do not require a test run.

## Write, then run

1. **Decide what to test.** For new behaviour: the happy path plus the edge cases that motivated the code (empty input, boundary values, error paths). For a bug fix: a test that fails on the old code and passes on the fix — that test is the proof the bug is gone.
2. **Write the test next to its peers**, following the project's existing test layout and naming. Reuse existing fixtures and helpers before adding new ones.
3. **Run the full command**, not a single-file subset, before declaring done — a change can break a sibling.

## Fixing failures — max 2 cycles

When the suite fails:

1. Read the failure. Fix the **root cause** — the code or the test, whichever is actually wrong.
2. Re-run.
3. Repeat at most **twice**. If after two fix cycles failures remain (or the failure count is not decreasing), **stop and report** the blocker rather than thrashing. Endless re-running rarely converges and usually means the diagnosis is wrong.

## Never weaken the bar

These are not allowed to make a suite "pass":

- Skipping, commenting out, or deleting a failing test to get green.
- Loosening an assertion so it no longer checks what it was protecting.
- Lowering a coverage threshold to dodge a gate.
- Degrading the code's real behaviour just to satisfy a brittle test (fix the test instead).

A test that fails is information. Suppressing it discards the information and ships the bug. If a test is genuinely obsolete (the behaviour was intentionally removed), delete it **as part of** the behaviour change with a clear reason — not to mute a red suite.

## Reviewing test adequacy

When judging whether a change is adequately tested, ask:

- Is the new/changed behaviour exercised by at least one test?
- Does a bug fix have a regression test that would have caught the original bug?
- Are the meaningful edge cases (empty, boundary, error) covered, not just the happy path?
- Do the tests assert on observable behaviour, not implementation detail that will break on any refactor?
