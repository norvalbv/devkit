#!/usr/bin/env node

/**
 * Commit-time Sentry-advisory gate — an LLM judge of the COMMIT MESSAGE (optionally + the changed-
 * file list) for whether the change describes a runtime ERROR-CLASS worth a Sentry capture.
 *
 * Why this exists: most observability setups auto-capture the LOUD failures (uncaught exceptions,
 * unhandled rejections, native/renderer/child-process crashes). What stays invisible is the SWALLOWED
 * class: a caught-and-logged error, a silent strand / stuck state, state corruption, or a
 * network/db/fs/native/IPC failure handled without crashing. Those never reach a handler unless the
 * code calls captureException explicitly. This nudges the author at commit time.
 *
 * WARN-BY-DEFAULT — like every devkit judge gate, the LLM never CREATES a block. There is no
 * deterministic floor for "should be monitored", so a nondeterministic MONITOR must not be the sole
 * creator of a hard stop (a false MONITOR would train reflexive bypass → dead gate). MONITOR warns
 * (exit 0) and appends to the watchlist; *_SENTRY_HARD=1 escalates a confident MONITOR to exit 1.
 *
 * Lives in the `commit-msg` hook, NOT pre-commit: the message only exists once git has it (passed as
 * the message-file path); pre-commit can't see it on interactive commits.
 *
 * Research basis (the context tier + prompt shape are tuned, not guessed):
 *   - message-alone underfits (arXiv 1711.05340) AND is structurally blind to sc-1116: it cannot see
 *     that a swallowed error is ALREADY instrumented in the same commit, so it re-flags a surface the
 *     diff already fixed (measured: message precision 0.46 regardless of model). A FULL diff can
 *     confuse a cheap model via distractors (arXiv 2412.10079) — but FOCUSING it to error-handling
 *     hunks (focusDiff, the decisions-detect pattern) removes them. So the default feeds the FOCUSED
 *     diff, the same "evaluate the live diff" contract the decisions/reviewer judges use. On the eval
 *     (104 real-derived cases) haiku+focused-diff = F1 ~0.91 (0.90–0.93 across runs; nondeterministic)
 *     vs message F1 0.56, and it beats sonnet on the full diff (0.88) and matches sonnet-focused (0.92)
 *     — context + focus dominate model, and cheap wins.
 *   - few-shot >> zero-shot, chain-of-thought does not help commit classification (arXiv 2605.02033).
 *   - self-consistency (sample N, majority-vote) reliably lifts a model; reasoning tiers give no
 *     advantage and are slow (arXiv 2510.22389) — so prefer *_SENTRY_SAMPLES over a reasoning tier.
 * The eval/ benchmark sweeps {model, context, shots, samples}; the env defaults below are the cell the
 * seed corpus picks (haiku + diff — see the CONTEXT_TIER note) — re-run the sweep on your own corpus.
 *
 *   --gate    : exit 0 = SKIP / warn-only / skipped / fail-open · exit 1 = hard mode + confident MONITOR · exit 2 = could-not-run
 *   (no flag) : report mode — judge the given message and PRINT the verdict, exit 0.
 *               The positional may be an inline message string OR a path to a message file (the hook
 *               passes the file).
 *
 * Knobs (read GUARD_* first, then FRINK_* as a back-compat alias):
 *   NO_SENTRY_JUDGE=1 (skip) · SENTRY_NO_LLM=1 (skip — can't judge without the LLM) ·
 *   SENTRY_HARD=1 (MONITOR→block) · SENTRY_MODEL (default haiku) ·
 *   SENTRY_CONTEXT=message|names|diff (default diff, focused) · SENTRY_SAMPLES=N (default 1) ·
 *   SENTRY_WATCHLIST=<path> (default docs/sentry-watchlist.md, relative to the consumer cwd) ·
 *   SENTRY_DIFF_FULL=1 (feed the whole diff, not just error-handling hunks — A/B).
 *
 * DATA BOUNDARY: the `diff` tier sends the FOCUSED staged source (error-handling hunks, capped 6000c)
 * to the configured Claude judge — more than the message tier's metadata. focusDiff limits it to
 * error-relevant hunks, never whole files. Set SENTRY_CONTEXT=message to send only the commit message,
 * or NO_SENTRY_JUDGE=1 to disable the judge entirely.
 * No `claude` binary / offline / quota-exhausted → fail-open, but execJudge prints one stderr warning
 * so the dark judge is VISIBLE (no longer a silent no-op). See ../judge/run-judge.mjs.
 *
 * GOVERNING RULE (devkit "ship the generator, never the data"): every runtime path resolves against
 * the CONSUMER cwd, never __dirname. The WATCHLIST + the BASELINE stay the consumer's data (born in
 * their repo, never shipped). The eval `cases.jsonl` DOES ship — 103 real-derived cases — but it is a
 * dev-only SEED the gate never reads at runtime; a consumer copies + grows it with their own commits.
 */

import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGuardConfig } from '../config.mts';
import { focusHunks } from '../judge/diff-focus.mts';
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../judge/judge-isolation.mts';
import { execJudge } from '../judge/run-judge.mts';

// Read a GUARD_* env var, falling back to its FRINK_* alias for back-compat with the original frink
// gate. Mirrors the config loader's envVar so every devkit gate reads env the same way.
function envVar(name: string): string | undefined {
  const guard = process.env[`GUARD_${name}`];
  return guard !== undefined ? guard : process.env[`FRINK_${name}`];
}

// One judge sample: the parsed verdict + the raw reply it came from (kept for evidence extraction).
interface SentryRun {
  verdict: string | null;
  raw: string;
}

// The gate's judgement of one commit: the voted verdict + the human-readable evidence line.
interface SentryVerdict {
  verdict: string | null;
  evidence: string;
}

// Overrides for `judge` — all optional; each falls back to the module env default.
interface SentryJudgeOpts {
  model?: string;
  samples?: number;
  prompt?: string;
}

const CWD = process.cwd();

const MODEL = envVar('SENTRY_MODEL') ?? 'haiku';
const SAMPLES = Number(envVar('SENTRY_SAMPLES') ?? '1') || 1;
// Default = diff, FOCUSED (see buildContext/focusDiff). The eval (gate-engine/sentry/eval, 103 cases)
// picked it: haiku+focused-diff = F1 ~0.91 (0.90–0.93 across runs; precision ~0.90) vs message 0.46/0.71
// (F1 0.56 — message flags every already-instrumented swallow). Focusing to error-handling hunks beats
// the full diff (0.83), beats sonnet-full (0.88), AND edges sonnet-focused (0.92) — context + focus
// dominate model, cheap wins. The
// diff tier erases the sc-1116 false-positive at no recall cost and still MONITORs a surface a capture
// ELSEWHERE leaves un-instrumented. `message`/`names` stay available via *_SENTRY_CONTEXT.
const CONTEXT_TIER = envVar('SENTRY_CONTEXT') ?? 'diff';
const DEFAULT_WATCHLIST = 'docs/sentry-watchlist.md';

/** Absolute watchlist path, resolved from the CONSUMER cwd (env override > default), never __dirname. */
function watchlistPath() {
  const configured = envVar('SENTRY_WATCHLIST') ?? DEFAULT_WATCHLIST;
  return isAbsolute(configured) ? configured : resolve(CWD, configured);
}

// ─── The judge brain (split so the benchmark can sweep zero- vs few-shot) ────────

const JUDGE_GUIDE =
  'You judge ONE git commit (a COMMIT MESSAGE, optionally a CHANGED FILES list, on stdin). Decide ' +
  'whether the change introduces or touches a runtime ERROR-CLASS worth adding a Sentry capture for.\n' +
  'Sentry-worthy (MONITOR) = a runtime failure that is SILENT to auto-capture: a swallowed / caught ' +
  'error, a silent strand or stuck / never-resolving state, state or data corruption, or a network / ' +
  'database / filesystem / native / IPC failure the code HANDLES without crashing. These never reach ' +
  'an uncaught-exception or unhandled-rejection handler, so they are invisible unless captured ' +
  'explicitly.\n' +
  'NOT Sentry-worthy (SKIP): pure UI / layout / styling / copy / accessibility, docs, tests, tooling / ' +
  'build / lint / config, dependency bumps, behaviour-preserving refactors, OR a crash that ALREADY ' +
  'auto-captures (an uncaught throw, an unhandled promise rejection, a native / renderer crash, a ' +
  'child-process crash).\n' +
  'The message (and file list, if given) is your ONLY evidence — if it does not clearly describe a ' +
  'swallowed runtime error-class, reply SKIP.\n';

// Few-shot exemplars — two MONITOR (one state-corruption, one reconnect-strand so the model has a cue
// for "handled-but-never-resolves"), two SKIP. Deliberately GENERIC (no repo-specific subjects) so
// nothing is leaked into a consumer's benchmark and the shapes transfer to any project.
const JUDGE_FEWSHOT =
  'Examples:\n' +
  'fix: stale session context reused after a cache reset corrupted writes => MONITOR (silent state corruption — wrong execution context)\n' +
  'fix: spinner stuck "Running" after a server restart, never resolves => MONITOR (reconnect strand — state stuck, never resolves)\n' +
  'fix: hide an orphan scroll-fade gradient in single-pane layouts => SKIP (pure UI)\n' +
  'fix(a11y): status colors as text pass WCAG AA on light theme => SKIP (styling / accessibility)\n';

const JUDGE_REPLY =
  'Reply with EXACTLY one word on the first line: MONITOR or SKIP. You MAY add ONE short line after ' +
  'it: the why + the suggested capture surface (e.g. "executor / dead-chat signal path"). No other text.';

/** Assemble the judge prompt; `shots` 0 drops the exemplars (for the benchmark sweep). */
export function buildPrompt(shots = 4) {
  return JUDGE_GUIDE + (shots > 0 ? JUDGE_FEWSHOT : '') + JUDGE_REPLY;
}

export const SENTRY_JUDGE_PROMPT = buildPrompt(4);

// ─── Pure logic (testable without git / claude) ─────────────────────────────────

// Only behaviour-bearing commit types reach the LLM. Everything else (docs/chore/style/test/build/ci/
// bump + non-conventional one-liners) free-skips with zero tokens — the dominant token-economy lever.
export const SENTRY_JUDGE_TYPE_RE = /^(fix|feat|perf|refactor)(\([^)]*\))?!?:/i;

/** First non-comment, non-blank line of a commit message — the subject. */
export function subjectOf(message: string): string {
  return (
    String(message)
      .split('\n')
      .find((l) => l.trim() && !l.startsWith('#'))
      ?.trim() ?? ''
  );
}

export function shouldJudge(message: string): boolean {
  return SENTRY_JUDGE_TYPE_RE.test(subjectOf(message));
}

// Cap the staged-diff evidence fed to the `diff` tier.
const DIFF_EVIDENCE_CAP = 6000;

// A hunk is error-handling-relevant if it touches a catch/throw/reject/.catch, a log.warn|error, or a
// Sentry capture — the swallow-vs-capture signal the judge needs. Everything else is a distractor.
const ERROR_HUNK_RE =
  /\b(?:try|catch|throw|reject|captureException|captureMessage|captureMainMessage)\b|\.catch\s*\(|(?:log|logger|console)\.(?:warn|error)/;

/**
 * FOCUS the staged diff to just its error-handling hunks — the decisions-detect pattern (send the
 * judge the signal, not the whole commit): a header listing every changed file, then ONLY the
 * error-relevant hunks per file, then an omission count. Dropping distractors is a MEASURED win on the
 * 104-case eval (haiku 0.83→~0.91) — it kills borderline over-fires and stops the cap from truncating
 * the signal out of a big commit. Deterministic EVIDENCE selection only; the LLM still decides.
 * The per-file split + hunk focus live in ../judge/diff-focus (shared with detect + the reviewers).
 */
export function focusDiff(diffText: string): string {
  return focusHunks(diffText, (h) => ERROR_HUNK_RE.test(h), 'non-error');
}

/** Build the stdin payload for the judge.
 *   message : commit subject/body only (the tuned default).
 *   names   : + the changed-file list (status + path), never hunks.
 *   diff    : + the staged diff, FOCUSED to its error-handling hunks (focusDiff — the decisions
 *             pattern), then capped — lets the judge SEE whether the change already instruments the
 *             error it handles (so a MONITOR self-clears when the capture is present). The directive is
 *             inlined so the MODEL decides from the diff — no regex verdict. GUARD_SENTRY_DIFF_FULL=1
 *             feeds the whole diff instead (A/B escape hatch). */
export function buildContext(
  message: string,
  nameStatus: string,
  diff = '',
  tier: string = CONTEXT_TIER,
): string {
  const msg = String(message).trim().slice(0, 2000);
  const base = `COMMIT MESSAGE:\n${msg}`;
  if (tier === 'diff' && diff && String(diff).trim()) {
    const focused = envVar('SENTRY_DIFF_FULL') ? '' : focusDiff(diff);
    // Truncation fail-safe: if the (focused) evidence overflows the cap, a later swallow can be cut
    // while an early capture survives — the judge must NOT read that absence as instrumented. Mark it
    // incomplete (mirrors the decisions detect judge's INCOMPLETE fail-safe). focusDiff makes overflow
    // rare (error hunks only), but a genuinely large multisurface commit can still hit it.
    const full = focused || String(diff).trim();
    const evidence =
      full.length > DIFF_EVIDENCE_CAP
        ? `${full.slice(0, DIFF_EVIDENCE_CAP)}\n[EVIDENCE TRUNCATED — later hunks omitted; a swallow whose capture is not shown here may still be UN-instrumented. Do NOT infer SKIP from an absent capture.]`
        : full;
    return (
      `${base}\n\n` +
      'STAGED DIFF (error-handling hunks; ground truth over the message). If this diff ALREADY adds a ' +
      'Sentry capture — `Sentry.captureException`/`captureMessage` or a project wrapper such as ' +
      '`captureMainMessage` — as an EXECUTABLE call for the error the change handles, the surface is ' +
      'instrumented: reply SKIP. A capture that appears only in a COMMENT, a string literal, or test ' +
      'code does NOT count. Reply MONITOR when a swallowed error-class is introduced or touched and the ' +
      `diff adds NO real capture for it:\n${evidence}`
    );
  }
  if (tier !== 'names' || !nameStatus || !String(nameStatus).trim()) return base;
  const files = String(nameStatus).trim().split('\n').slice(0, 30).join('\n').slice(0, 2000);
  return `${base}\n\nCHANGED FILES (status\\tpath):\n${files}`;
}

// Word-boundary matchers — NOT substring: an optional why-line could contain "skip"/"monitor" inside
// other words. Only the FIRST line is read, and a single confident hit wins; else null → no block.
const VERDICT_RE = { MONITOR: /\bMONITOR\b/, SKIP: /\bSKIP\b/ };
const EVIDENCE_STRIP_RE = /^\W*\b(?:MONITOR|SKIP)\b\W*/i;
const COLLAPSE_NEWLINES_RE = /\s*\n+\s*/g;

export function parseSentryVerdict(raw: unknown): string | null {
  const head = (String(raw).trim().toUpperCase().split('\n')[0] ?? '').trim();
  const hits = (['MONITOR', 'SKIP'] as const).filter((v) => VERDICT_RE[v].test(head));
  return hits.length === 1 ? hits[0] : null;
}

// Strip the leading verdict token + separators so the optional why survives whether the model put it
// on the SAME line ("MONITOR — executor / dead-chat path") or a second line. A plain
// split('\n').slice(1) loses an inline why — the most actionable part of the advisory.
export function extractEvidence(raw: unknown): string {
  return String(raw)
    .trim()
    .replace(EVIDENCE_STRIP_RE, '')
    .replace(COLLAPSE_NEWLINES_RE, ' ')
    .trim();
}

/** Plurality vote over self-consistency samples; null verdicts ignored. A tie (no strict winner) →
 * null, so the ambiguous-→-no-block discipline holds for ANY sample count, including even ones. */
export function majority(verdicts: (string | null)[]): string | null {
  const counts: Record<string, number> = {};
  for (const v of verdicts) if (v) counts[v] = (counts[v] ?? 0) + 1;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null; // tie → no confident verdict
  return ranked[0][0];
}

// The block is bounded to {hard mode AND a confident MONITOR}. Everything else passes.
export function sentryExit(verdict: string | null, hard: boolean): 0 | 1 {
  return verdict === 'MONITOR' && hard ? 1 : 0;
}

// ─── claude I/O (thin; shared by the gate and the benchmark) ─────────────────────

// The judge is a PURE TEXT classifier — isolate it from the host repo (no hooks, no session
// transcript, no tools) via the shared judge-isolation flags. See ../judge/judge-isolation.mjs for
// why each flag matters (the auto-fix Stop hook corrupting runs, the session-log bloat).
function runJudgeOnce(input: string, model: string, prompt: string): SentryRun | null {
  const raw = execJudge({
    label: 'sentry-advisory',
    args: ['-p', '--model', model, ...JUDGE_READ_ONLY, ...JUDGE_ISOLATION, prompt],
    input,
    // payload is tiny, but `claude -p` cold-start is ~20-40s here; generous ceiling so a slow start
    // doesn't false-timeout into a null verdict.
    timeout: 120000,
    cwd: CWD,
  });
  // null = outage (execJudge warned) → propagate so judge() bails (no per-sample re-warn).
  return raw === null ? null : { verdict: parseSentryVerdict(raw), raw: String(raw).trim() };
}

/**
 * Judge `input`, returning { verdict, evidence } or null (fail-open). With samples>1, runs the call
 * N times and majority-votes (self-consistency). Shared so the gate and the benchmark exercise the
 * exact same path — prompt/parser/voting never drift.
 */
export function judge(
  input: string,
  { model = MODEL, samples = SAMPLES, prompt = SENTRY_JUDGE_PROMPT }: SentryJudgeOpts = {},
): SentryVerdict | null {
  if (envVar('SENTRY_NO_LLM') || !String(input).trim()) return null;
  try {
    const runs: SentryRun[] = [];
    for (let i = 0; i < Math.max(1, samples); i += 1) {
      const r = runJudgeOnce(input, model, prompt);
      if (r === null) return null; // judge dark (execJudge warned once) — don't re-warn per sample
      runs.push(r);
    }
    const verdict = majority(runs.map((r) => r.verdict));
    const src = runs.find((r) => r.verdict === verdict) ?? runs[0];
    return { verdict, evidence: extractEvidence(src.raw) };
  } catch {
    return null; // pure-logic fault (majority/extractEvidence) → fail-open, unchanged
  }
}

// ─── gate-only git + watchlist I/O ───────────────────────────────────────────────

function stagedNameStatus() {
  try {
    return execSync('git diff --cached --name-status', { cwd: CWD, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// The staged diff for the `diff` context tier. Prefixes forced OFF-config (like the decisions detect
// judge) so a consumer's diff.noprefix/mnemonicPrefix can't reshape what the judge reads. Best-effort:
// a git failure OR a hang (timeout) returns '' → buildContext falls back to message-only for this run
// (fail toward judging). The timeout matters: this runs INSIDE the commit-msg hook, so a wedged
// `git diff` (index lock, a slow textconv/external diff driver) must not block the commit forever.
function stagedDiff() {
  try {
    return execSync('git -c diff.noprefix=false -c diff.mnemonicPrefix=false diff --cached', {
      cwd: CWD,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10000,
    }).trim();
  } catch {
    return '';
  }
}

// Durable backlog so the advisory is actionable after the commit — the file is the TODO list.
// Best-effort: a watchlist write must never fail the commit. Leaves an unstaged edit the author
// reviews and commits when they action it.
// Separator between subject and evidence — shared so line-format and dedup never drift (em-dash, U+2014).
const WATCHLIST_EVIDENCE_SEP = ' — ';

// The watchlist line for a subject + evidence — the durable-backlog format.
export function watchlistLine(subject: string, evidence: string): string {
  return `- [ ] ${subject}${evidence ? `${WATCHLIST_EVIDENCE_SEP}${evidence}` : ''}`;
}

/** True if the watchlist ALREADY has an entry for this SUBJECT — guards amend/retry duplicates.
 * Keyed on subject alone (NOT subject+evidence): the LLM evidence text is non-deterministic, so the
 * same commit re-judged yields different evidence and would otherwise duplicate. A subject that is a
 * substring of an existing one ("fix: foo" vs "fix: foobar") stays distinct because we anchor on the
 * full line prefix (`- [ ] <subject>` exactly, or followed by the evidence separator). */
export function watchlistHas(content: string, subject: string): boolean {
  const exact = `- [ ] ${subject}`;
  const withEvidence = `${exact}${WATCHLIST_EVIDENCE_SEP}`;
  return content.split('\n').some((l) => l === exact || l.startsWith(withEvidence));
}

function appendWatchlist(subject: string, evidence: string): void {
  try {
    const file = watchlistPath();
    if (existsSync(file) && watchlistHas(readFileSync(file, 'utf8'), subject)) return;
    appendFileSync(file, `${watchlistLine(subject, evidence)}\n`);
  } catch {
    /* best-effort */
  }
}

/** Normalise a raw commit message to the judged text: drop git comment lines (the editor template),
 * trim, cap. Tolerates CRLF — per-line `#` detection + the final trim handle a `\r\n` message. */
export function cleanMessage(raw: unknown): string {
  return String(raw)
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .trim()
    .slice(0, 4000);
}

/** The positional arg (skipping flags) is the message: an inline string OR a message-file path. */
function readMessage() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!arg) return '';
  let raw = arg;
  if (existsSync(arg)) {
    try {
      raw = readFileSync(arg, 'utf8');
    } catch {
      return '';
    }
  }
  return cleanMessage(raw);
}

// ─── Dispatch ───────────────────────────────────────────────────────────────────

/** Report-mode (no --gate) one-liner for a human running the gate by hand. Pure (tested). */
export function reportLine(result: SentryVerdict | null): string {
  const verdict = result?.verdict ?? 'no verdict (judge unavailable / ambiguous)';
  return `sentry-judge: ${verdict}${result?.evidence ? ` — ${result.evidence}` : ''}`;
}

/** Gate-mode side effects: warn on MONITOR, log to the watchlist only on the warn path. Returns exit code. */
function applyGateResult(result: SentryVerdict | null, message: string, hard: boolean): number {
  const code = sentryExit(result?.verdict ?? null, hard);
  if (result?.verdict === 'MONITOR') {
    console.error(
      `⚠️  sentry-advisory: MONITOR — consider a Sentry capture${result.evidence ? ` (${result.evidence})` : ''}.`,
    );
    // Warn path only: a hard-mode BLOCK (code 1) means the commit didn't ship, so don't log a backlog
    // entry for a commit that never landed (it would be stale + duplicate on re-commit).
    if (code === 0) appendWatchlist(subjectOf(message), result.evidence);
  }
  return code;
}

/** Why the gate should bypass judging (env override or trivial commit type), or null to proceed. */
export function skipReason(message: string): string | null {
  if (envVar('NO_SENTRY_JUDGE')) return 'sentry-judge: skipped (GUARD_NO_SENTRY_JUDGE)';
  if (!shouldJudge(message)) return 'sentry-judge: SKIP (trivial commit type / empty — not judged)';
  return null;
}

export function run(gate: boolean): void {
  try {
    // Resolve the consumer config up front so a corrupt guard.config.json fails loudly (not silently
    // skipped) — even though this gate reads only `cwd` from it today.
    resolveGuardConfig(CWD);
    const message = readMessage();
    const skip = skipReason(message);
    if (skip) {
      if (!gate) console.log(skip);
      process.exit(0);
    }
    const nameStatus = CONTEXT_TIER === 'names' ? stagedNameStatus() : '';
    const diff = CONTEXT_TIER === 'diff' ? stagedDiff() : '';
    const result = judge(buildContext(message, nameStatus, diff, CONTEXT_TIER));
    if (!gate) {
      console.log(reportLine(result));
      process.exit(0);
    }
    process.exit(applyGateResult(result, message, Boolean(envVar('SENTRY_HARD'))));
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`sentry-gate: could not run — ${detail}`);
    process.exit(2); // fail-open
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) run(process.argv.includes('--gate'));
