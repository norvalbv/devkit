/**
 * Finds hook lines whose documented fail-open exit code cannot actually fail open (sc-1366).
 *
 * devkit gates use exit 2 to mean "could not run — continue". husky runs a hook via `sh -e`
 * (.husky/_/h), and under `-e` a command that fails aborts the script immediately. So this shape:
 *
 *     node scripts/check-vision.mjs --gate
 *     vrc=$?
 *     if [ $vrc -eq 1 ]; then ...      # unreachable when the gate exits non-zero
 *
 * kills the commit with the gate's own status. The `vrc=$?` line never runs, and neither does the
 * branch that was supposed to tolerate it. A real ship died this way after every gate had passed:
 * the failure was a fail-open the shell converted into a hard block.
 *
 * Every call devkit GENERATES is `cmd || rc=$?`, which is safe. This check exists for the lines a
 * consumer wrote by hand, which devkit does not author and must never rewrite — so it reports and
 * stops there, like stray-gate-calls.mts.
 *
 * AMBIGUITY BIAS — deliberately the OPPOSITE of stray-gate-calls.mts, which resolves toward
 * staying quiet because a missed duplicate only costs a second model bill. Here a missed line
 * costs a blocked commit from a gate that promised to fail open, and a false all-clear turns
 * "nobody has looked at this hook" into "devkit says this hook is fine". So when the `-e` state
 * cannot be established this reports UNVERIFIABLE with its candidates rather than reporting clean.
 *
 * THE `-e` MODEL, measured directly rather than assumed (two earlier drafts of this check had it
 * backwards, and would have found 1 of 8 real hazards in the reference hook):
 *
 *   aborts, so REPORT              | suppressed, so ignore
 *   -------------------------------|----------------------------------------
 *   cmd            / rc=$?         | cmd || rc=$?
 *   if …; then cmd; rc=$?; fi      | if cmd; then … (the CONDITION list)
 *   case x in x) cmd; rc=$?;; esac | elif cmd; then …
 *   ( cmd; rc=$? )                 | ! cmd; rc=$?
 *   cmd; rc=$?   (one line)        | false && cmd; rc=$?  (LEFT operand)
 *   true && cmd; rc=$?  (RIGHT)    |
 *   VAR=$(cmd …); rc=$?            |
 *
 * `if` shields only its CONDITION list — never its body. That single inversion is the difference
 * between finding one hazard and finding all of them.
 *
 * DECLARED BLIND SPOT: a command inside a function body is suppressed exactly when every caller of
 * that function is itself guarded, which needs a call graph this line-oriented reader does not
 * build. Those are reported as unchecked rather than guessed at in either direction.
 *
 * Measurements were taken under macOS `/bin/sh` (bash in POSIX mode); a Linux consumer's `sh` is
 * usually dash, whose `-e` edge cases are close but not identical.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectGitRoot } from '../detect-git-root.mts';
import { type CheckResult, check } from './check-result.mts';
import {
  lastAndOrSegment,
  logicalLines,
  splitStatements,
  stripComment,
  words,
} from './hook-gate-scan.mts';

/** A statement whose `$?` capture is unreachable under `sh -e`. */
export interface UnguardedGateCall {
  /** 1-based physical line the statement's logical line starts on. */
  line: number;
  /** The command whose failure aborts the hook. */
  command: string;
  /** The `<var>=$?` that will never run. */
  capture: string;
}

/**
 * Whether `-e` is actually in force for this hook — never assumed. `hook-missing` is deliberately
 * distinct from every other value: an empty `calls` array because nothing was PARSED must never
 * render the same as an empty array because the hook is genuinely clean.
 */
export type ErrexitState = 'in-force' | 'not-in-force' | 'unverifiable' | 'hook-missing';

export interface UnguardedGateReport {
  errexit: ErrexitState;
  calls: UnguardedGateCall[];
  /** Why the `-e` state reads the way it does, for the report line. */
  reason: string;
}

const CAPTURE_RE = /^[A-Za-z_][A-Za-z0-9_]*=\$\?$/;
/** Keywords that open a condition list; everything up to `then`/`do` is suppressed. */
const CONDITION_OPENERS = /^(if|elif|while|until)\b/;
/** A statement that is ONLY block structure — nothing runs. */
const BARE_KEYWORD = /^(then|do|else|fi|done|esac)$/;
/** A body statement carrying its opener from a one-line `if …; then cmd; rc=$?; fi`. */
const LEADING_KEYWORD = /^(then|do|else)\s+/;
/** `true` and `:` always succeed, so a capture after one is never lost. `false` is NOT inert. */
const ALWAYS_SUCCEEDS = /^(true|:)$/;
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SUBSTITUTION = /\$\(|`/;
const NEGATION = /^!\s/;
const SET_ERREXIT_ON = /^\s*set\s+(?:-[a-z]*e|-o\s+errexit)/;
const SET_ERREXIT_ON_M = /^\s*set\s+(?:-[a-z]*e|-o\s+errexit)/m;
const SET_ERREXIT_OFF = /^\s*set\s+(?:\+[a-z]*e|\+o\s+errexit)/;
const SH_DASH_E = /\bsh\s+-e\b/;

/**
 * Does this statement's exit status reach `set -e`?
 *
 * Deliberately OVER-reports one shape: `A && B` is reported, even though `false && B` does not
 * abort (B never runs). Whether B runs is a runtime property — in a real hook the left side is a
 * test — so a checker that stayed silent would miss every `[ -n "$X" ] && gate` hazard. Reporting
 * a line whose left operand happens to be constantly false is the cheaper error.
 */
function abortsUnderErrexit(stmt: string): boolean {
  const s = stmt.trim();
  if (!s || ALWAYS_SUCCEEDS.test(s)) return false;
  // `!` negates the status: errexit never sees a failure.
  if (NEGATION.test(s)) return false;
  // An AND-OR list's status is its LAST element, and that is the only one errexit sees. So
  // `cmd || rc=$?` is safe (the tail is an assignment that succeeds) while
  // `some_check || node gate.mjs --gate` is NOT — the gate is the tail, and its failure aborts.
  const last = lastAndOrSegment(s);
  if (!last || ALWAYS_SUCCEEDS.test(last)) return false;
  // Leading `VAR=…` words are an assignment PREFIX when a command follows them, and a plain
  // assignment when nothing does. Only the latter cannot fail — unless its value runs a command
  // substitution, whose status becomes the assignment's.
  const parts = words(last);
  let i = 0;
  while (i < parts.length && ASSIGNMENT_WORD.test(parts[i] ?? '')) i++;
  if (i === parts.length) return parts.some((p) => SUBSTITUTION.test(p));
  return true;
}

/** Read the `-e` state from husky's runner and the hook's own `set` lines. */
function errexitState(hookText: string, gitRoot: string): { state: ErrexitState; reason: string } {
  if (SET_ERREXIT_ON_M.test(hookText)) {
    return { state: 'in-force', reason: 'the hook sets -e itself' };
  }
  const runner = join(gitRoot, '.husky', '_', 'h');
  if (existsSync(runner)) {
    try {
      const text = readFileSync(runner, 'utf8');
      return SH_DASH_E.test(text)
        ? { state: 'in-force', reason: 'husky runs hooks via `sh -e` (.husky/_/h)' }
        : { state: 'not-in-force', reason: '.husky/_/h does not invoke the hook with -e' };
    } catch {
      /* fall through to unverifiable */
    }
  }
  // husky gitignores `.husky/_`, so a fresh `git worktree add` legitimately has no runner. Saying
  // "clean" here would be the false all-clear this check exists to avoid.
  return {
    state: 'unverifiable',
    reason: 'no readable .husky/_/h — husky gitignores it, so a fresh worktree has none',
  };
}

/**
 * Every `<var>=$?` in the hook whose command is not guarded against `-e`.
 *
 * Scans the whole file INCLUDING devkit's managed block: a finding in there would be a devkit bug
 * worth surfacing, and every line devkit generates is `|| rc=$?` so it costs nothing to look.
 */
export function unguardedGateCalls(hookText: string): UnguardedGateCall[] {
  const found: UnguardedGateCall[] = [];
  // Flatten to (statement, originating line) pairs so a `;`-joined pair and a two-line pair are
  // the same shape to the matcher below.
  const stmts: Array<{ text: string; line: number }> = [];
  let suppressed = false; // inside a `set +e` region
  for (const { text, line } of logicalLines(hookText)) {
    const code = stripComment(text);
    if (SET_ERREXIT_OFF.test(code)) suppressed = true;
    else if (SET_ERREXIT_ON.test(code)) suppressed = false;
    if (suppressed) continue;
    for (const s of splitStatements(code)) stmts.push({ text: s, line });
  }

  for (let i = 1; i < stmts.length; i++) {
    const capture = stmts[i];
    const prev = stmts[i - 1];
    if (!capture || !prev || !CAPTURE_RE.test(capture.text)) continue;
    // Strip a leading condition keyword: `if cmd` means cmd IS the condition list, which `-e`
    // does not police. A body statement carries no such keyword.
    if (CONDITION_OPENERS.test(prev.text)) continue;
    // A statement that is ONLY `then`/`fi`/… is structure and runs nothing. But `then cmd` is a
    // BODY statement — splitStatements produces it from the one-line `if …; then cmd; rc=$?; fi`
    // shape, and skipping it dropped exactly the hazard this module exists to find.
    if (BARE_KEYWORD.test(prev.text)) continue;
    const command = prev.text.replace(LEADING_KEYWORD, '');
    if (!abortsUnderErrexit(command)) continue;
    found.push({ line: prev.line, command, capture: capture.text });
  }
  return found;
}

/** The check as `devkit doctor` runs it: the `-e` state plus every unguarded capture. */
export function inspectHookFailOpen(gitRoot: string, hookRelPath: string): UnguardedGateReport {
  const hookPath = join(gitRoot, hookRelPath);
  if (!existsSync(hookPath)) {
    return { errexit: 'hook-missing', calls: [], reason: `${hookPath} not found` };
  }
  const hookText = readFileSync(hookPath, 'utf8');
  const { state, reason } = errexitState(hookText, gitRoot);
  // Even when -e is not in force the calls are still collected: the state can change under the
  // consumer (a husky upgrade, a `set -e` added to the hook) and the report says which it is.
  return { errexit: state, calls: unguardedGateCalls(hookText), reason };
}

/**
 * The doctor check. REPORT-ONLY and never `fixable`: these are lines the consumer wrote, outside
 * devkit's managed block, and doctor's fix path only ever regenerates file content from the
 * recorded selection (docs/decisions/devkit-owned-hook-runner-delivery.md). Rewriting someone's
 * hand-authored shell is not devkit's call.
 */
export function checkFailOpenGuards(cwd: string, hookRelPath = '.husky/pre-commit'): CheckResult {
  // detectGitRoot first, exactly as checkHusky/checkHookRunner do: devkit init can run from a
  // monorepo package subdir where cwd !== gitRoot, and joining the hook path onto a raw cwd would
  // miss the real hook entirely — then report OK for a file it never opened.
  const { gitRoot } = detectGitRoot(cwd);
  const report = inspectHookFailOpen(gitRoot, hookRelPath);
  const lines = renderUnguardedGateCalls(report, hookRelPath);
  if (report.errexit === 'hook-missing') {
    return check('fail-open guards', 'MISSING', report.reason, 'run `devkit init`');
  }
  if (!lines.length) {
    return check('fail-open guards', 'OK', `no unguarded gate calls in ${hookRelPath}`);
  }
  return check(
    'fail-open guards',
    'DRIFT',
    lines[0] ?? '',
    `${lines.slice(1).join('\n')}\n    devkit does not rewrite hand-authored hook lines — change them yourself.`,
  );
}

/** Human-readable lines for the doctor output. Empty when there is nothing to say. */
export function renderUnguardedGateCalls(
  report: UnguardedGateReport,
  hookRelPath: string,
): string[] {
  if (report.errexit === 'hook-missing') return [`${hookRelPath} was not read: ${report.reason}`];
  if (!report.calls.length) return [];
  if (report.errexit === 'not-in-force') return [];
  const lines: string[] = [];
  const header =
    report.errexit === 'in-force'
      ? `${report.calls.length} gate call(s) in ${hookRelPath} cannot fail open — ${report.reason}:`
      : `${report.calls.length} gate call(s) in ${hookRelPath} MAY not fail open (${report.reason}):`;
  lines.push(header);
  for (const c of report.calls) lines.push(`    line ${c.line}: ${c.command}   → ${c.capture}`);
  lines.push(
    "    Under `sh -e` the capture never runs and the hook dies with the gate's own exit code,",
  );
  lines.push('    turning a documented fail-open into a hard block. Fix: `cmd || rc=$?`.');
  lines.push(
    '    Not checked: commands inside a function body (suppressed only if every caller is guarded).',
  );
  return lines;
}
