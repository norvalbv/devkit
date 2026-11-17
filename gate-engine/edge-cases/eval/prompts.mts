/**
 * Pre-registered prompt material for the sc-1119 bench (PREREGISTRATION.md is the rule book;
 * this module is the text). Everything here is FROZEN before the first judged run — editing any
 * arm/wrapper after results exist invalidates comparisons (promptShas ride in
 * results.baseline.json for exactly that reason).
 *
 * Design (epic 1117 experiments):
 * - ARMS: shape F (findings-analytic: the judge RUNS the analysis and reports concrete findings)
 *   vs P (procedural: the historical /edge-cases command voice, minimally adapted to REPORT
 *   rather than build tests) × length S/L (TDAD length ablation, arXiv 2603.17973). PL is the
 *   frink-cmd-v1 body nearly verbatim; adaptations are enumerated in PREREGISTRATION.md.
 * - CHANNELS (provenance experiment): U (owner-voice user preamble) / G-user (gate-framed user
 *   preamble) / G-sys (gate framing appended to the system prompt; the user message carries NO
 *   framing). Wrapper sentences carry ATTRIBUTION ONLY — no opinions about the code, no
 *   confidence statements (2410.14746), matched length/mood; 2 paraphrase realizations each
 *   (single-stimulus guard, Clark 1973). The instruction body + JSON footer live in the USER
 *   message in every channel — only the framing sentence moves.
 * - FOOTER: one shared output contract = style normalization by construction (methodology
 *   checklist item 10); enums come from lib/schema.mts so the matcher's category equality is
 *   well-defined.
 * - buildJudgeInput: the bench judge's BLINDED projection — repo, summary, changed files, diff
 *   excerpt VERBATIM (truncation parity with the labeler view). Never model/provider/source/
 *   promptVariant/date, never the gold response (label.mts's buildInput is the labeler view and
 *   must not be used here).
 */

import { CATEGORIES, sha8 } from './lib/schema.mts';

// ── shared output contract (identical suffix on every arm) ──────────────────────────────────────
export const FOOTER = `
Report your findings as ONE JSON object, no code fences, no prose before or after:
{"findings":[{"claim":"one-line assertion of the edge case","files":["repo/relative/path.ts"],"category":${JSON.stringify(CATEGORIES.join('|'))},"severity":"high|medium|low"}]}
- "files": repo-relative paths implicated, taken from the diff; use [] only when genuinely no file applies.
- One entry per distinct edge case. If there is nothing to review or nothing above the severity bar, return {"findings":[]}.`;

// ── shape × length arms ──────────────────────────────────────────────────────────────────────────
const FS = `Analyze the change below for edge cases the implementation misses or mishandles. Run the analysis yourself and report concrete, code-anchored findings — not generic advice and not a review procedure.

Check for:
- Boundary values (0, -1, empty, Number.MAX_SAFE_INTEGER, overflow/truncation)
- Concurrency and race conditions (same state, different timing)
- Wrong return values (the line runs, the result is wrong)
- Integration between components (each unit fine, wiring broken)
- Real-world input shapes the code never modelled
- Provider differences (cursor, claude code, etc.) where relevant
- Operating-system differences where relevant

Rules:
- Only report findings above low severity; bin trivia.
- Skip edge cases already covered by tests visible in the change.
- Focus ONLY on what this change builds; unrelated work may be visible in the diff.`;

const FL = `Analyze the change below for edge cases the implementation misses or mishandles. Run the analysis yourself and report concrete, code-anchored findings — not generic advice and not a review procedure. Work category by category and, for each candidate, verify against the diff that the risk is real before reporting it.

Application context to weigh where relevant:
- The app may run a single-pane chat/view or multi-pane chat/view — multi-pane means shared state and real concurrency: could two panes touch the same store, file, socket, or process at the same time?
- Multiple AI providers are integrated (cursor, claude code, and others) — execution paths, capabilities and message formats differ per provider: does this change behave identically across them, or does one provider hit a path the others don't?
- Multiple operating systems are supported — file paths, process semantics, timers and permissions differ: is anything here OS-sensitive (path separators, case sensitivity, signal handling, filesystem events)?

Categories to check, with what "found one" looks like:
- Boundary values: 0, -1, empty string/array, Number.MAX_SAFE_INTEGER, overflow, truncation at buffer/size limits — a concrete input that lands outside what the code guards.
- Concurrency/race conditions: same line or state, different timing — two writers, a reader mid-write, an await that yields while state mutates, an event firing during teardown.
- Wrong return values: the code runs without error but the RESULT is wrong — an off-by-one, a wrong sign, a stale cache read, a fallback that masks a real value.
- Integration between components: each unit is covered but the wiring is broken — a caller that ignores a new field, an event with no listener, a schema the consumer never updated.
- Real-world input shapes: inputs the test data never modelled — unicode, huge payloads, malformed JSON, paths with spaces, clock skew, empty diffs.
- Coverage gaps: where the change's baseline coverage visibly falls short of a 65–75% standard, report the specific uncovered branch as a finding rather than a percentage.

Rules:
- Only report findings above low severity; bin trivia and stylistic points.
- Skip edge cases already covered by tests visible in the change.
- Focus ONLY on what this change builds; unrelated work may be visible in the diff — ignore it.
- Every finding must name the file(s) it lives in and assert something checkable about the code.`;

const PS = `Given the work in this change, what edge cases can you think of? These include both user-generated edge cases and logical edge cases. Think about boundary values, concurrent/race conditions, wrong return values, integration between components, and real-world input shapes your test data never modelled.

First: make sure you are not duplicating tests — if a case is already covered by tests visible in the change, omit it. Only include edge cases above the severity of low (bin low or unworthy edge cases). Focus only on what this change builds; other work may be visible in the diff. If you spot a bug while thinking these through, great — report it as a finding.`;

// frink-cmd-v1 body, adapted ONLY as enumerated in PREREGISTRATION.md (report, don't build).
const PL = `Given what was built (summarized below) and the git diff related to it, what edge cases can you think of? These include both user-generated edge cases and logical edge cases. Reminder to think about how Frink works at a high level:

- A single-pane chat/view, or multi-pane chat/view
-- Will we risk any form of concurrency or race condition issues?
- Different AI applications: cursor, claude code, etc.
-- Will our execution be different for the different providers and will we need different test cases?
- Support for different OS'
-- Will there be any difference in performance, accuracy, etc. relating different operating systems?

General notes:

- Ensure the general baseline coverage for the new diff is on par with the golden standard of 65%-75%. This generally, excludes the edge cases.

Further, we can think about actual coverage itself:

- Boundary values (0, -1, Number.MAX_SAFE_INTEGER)
- Concurrent/race conditions (same line, different timing)
- Wrong return values (line ran, but result is wrong)
- Integration between components (each unit is covered, but wiring is broken)
- Real-world input shapes your test data never modelled

> Important note: There may be other pieces of work (bugs, features, chores, etc.) being carried out in the same branch - you can see these in the diff. You should only focus on what was built in this change.

Please report all *only* if they are above the severity of low (bin low or not worthy edge case tests) of the edge cases you have identified. First: ensure you are not duplicating tests, if these test cases already exist, omit them from your findings. If you spot a bug, great — report it as a finding.`;

export const ARMS = { FS, FL, PS, PL };

// ── provenance channel wrappers (attribution only; 2 realizations each) ──────────────────────────
export const WRAPPERS = {
  U: [
    `I've just wrapped up the work shown in this change. Before I ship it, review it for me.`,
    `Here is the change from the work I just finished. Take a look for me before I merge it.`,
  ],
  'G-user': [
    `Automated edge-cases gate: this commit triggered a scheduled review. The gate submitted the following change for analysis.`,
    `[edge-cases-judge] Automated commit review triggered. Gate input for this change follows.`,
  ],
  'G-sys': [
    `You are edge-cases-judge, an automated commit-review gate. Inputs arrive as machine-submitted commit diffs for edge-case analysis.`,
    `This session is an automated edge-cases review gate. Each input is a commit change submitted by the pipeline, not by a person.`,
  ],
};

// ── ceiling re-extraction prompt (same FOOTER — test-asserted) ───────────────────────────────────
export const CEILING_PROMPT = `Below is an agent's edge-case review of a code change. Extract the DISTINCT edge-case findings the review itself surfaced, exactly as claims about the code — do not add findings of your own, do not merge distinct ones, do not re-review anything.${FOOTER}`;

// ── the bench judge's blinded input projection ───────────────────────────────────────────────────
export const buildJudgeInput = (row) => {
  const a = row.anchor;
  return [
    `REPO: ${row.repo}`,
    `WHAT WAS BUILT: ${a.summary}`,
    a.nameStatus ? `CHANGED FILES:\n${a.nameStatus}` : null,
    a.diffExcerpt
      ? `DIFF:\n${a.diffExcerpt}`
      : `DIFF: (not available — go by the description above)`,
  ]
    .filter(Boolean)
    .join('\n\n');
};

/** Full user-message text for a cell. G-sys carries no user-side framing (it rides the system
 * prompt); U/G-user prepend their wrapper sentence. The arm body + FOOTER are identical across
 * channels — only the framing moves. */
export const buildUserMessage = (arm, channel, realization, row) => {
  const framing = channel === 'G-sys' ? null : WRAPPERS[channel][realization];
  return [framing, `${ARMS[arm]}${FOOTER}`, `=== CHANGE ===\n${buildJudgeInput(row)}`]
    .filter(Boolean)
    .join('\n\n');
};

/** System-prompt append for a cell (G-sys only); null = no --append-system-prompt flag. */
export const systemAppend = (channel, realization) =>
  channel === 'G-sys' ? WRAPPERS['G-sys'][realization] : null;

export const PROMPT_SHAS = {
  footer: sha8(FOOTER),
  arms: Object.fromEntries(Object.entries(ARMS).map(([k, v]) => [k, sha8(v)])),
  wrappers: Object.fromEntries(
    Object.entries(WRAPPERS).map(([k, v]) => [k, v.map((w) => sha8(w))]),
  ),
  ceiling: sha8(CEILING_PROMPT),
};
