/** `devkit baseline-status` (sc-2245) — see `meta.help` below for the full contract. */
import {
  type BaselineAnswer,
  DEFAULT_ARTIFACT,
  DEFAULT_MAX_RUNS,
  DEFAULT_WORKFLOW,
  queryBaseline,
  workflowSelector,
} from '../../lib/baseline-status/query.mts';
import {
  type Attribution,
  type AttributionToken,
  attributeFailures,
  capped,
  unknownAttribution,
} from '../../lib/baseline-status/attribution.mts';
import { type BaselineSource, configuredSource } from '../../lib/baseline-status/source.mts';
import type { TestStatus } from '../../lib/baseline-status/test-verdict.mts';
import {
  type CheckRow,
  type TerminalOutcome,
  ghChecksPoller,
  summarise,
} from '../../lib/ship/wait-ci/wait.mts';

export const meta = {
  name: 'baseline-status',
  agentFacing: true,
  summary:
    "Report which test files are failing on the default branch (and whether yours is), or which of a PR's failures its base already had.",
  help: `devkit baseline-status — decompose a red default branch into per-file facts.

Usage:
  devkit baseline-status [--file <path> [--test <name>]] [--json] [--ref <branch>]
                         [--max-runs <n>] [--workflow <file>]
  devkit baseline-status --pr <n> [--json]

  --file <path>      answer for one test file, plus the last run in which it passed
  --test <name>      with --file: answer for one test, named as the console prints it
                     (\`describe > test\`; a leading \`<file> > \` is stripped)
  --json             machine-readable output (the intended interface for agents)
  --ref <branch>     branch to read (default: the remote's HEAD, else main)
  --max-runs <n>     how many commits to walk back (default: ${DEFAULT_MAX_RUNS})
  --workflow <file>  the CI workflow to read (default: guard.config.json, else ${DEFAULT_WORKFLOW})
  --pr <n>           which of PR <n>'s failing checks its base already had (see below)

Reads the per-file summary artifact that \`devkit test-report-run\` uploads from a CI workflow.
Configure both in guard.config.json — { "baselineStatus": { "workflow": "<file>", "artifact":
"<name>" } } — defaults ${DEFAULT_WORKFLOW} and \`${DEFAULT_ARTIFACT}\`. The workflow must exist on
the default branch. No log scraping: a CI log interleaves failures from nested test runs, so
grepping it cannot prove a file passed.

Runs are looked up per commit, walking back from the branch head GitHub reports for the repository
gh queries, never from GitHub's branch run list (which can serve weeks-old pages). The answer names
that head and how many commits behind it the answering run sits (commitsBehindHead).

Two verdicts are reported separately, because they differ constantly:
  runStatus     the whole run — lint, typecheck, ratchets AND tests
  testsStatus   the test step alone

A file is passed / failed / skipped / excluded (existed but the runner did not collect it) /
absent (did not exist at that commit) / unknown. Those are not interchangeable: an undifferentiated
"did not run" reads as reassurance and would swallow a path typo.

This never guesses. Missing gh, no GitHub remote, no such workflow, an expired artifact or a run
killed before the reporter flushed all report \`unknown\` with a named reason — and, where the fix
is in your CI, a remedy line naming it.

Exit 0 = the query ran, including "no run carries data yet". Exit 2 = it could not be performed at
all (no gh, not authenticated, no GitHub remote, no such workflow on the default branch, no
readable branch head or history). Exit 1 = a
bad argument or an unreadable guard.config.json.

A failed file also lists its failing tests. \`--test\` answers failed / passed only from the
names a FAILED file recorded in that run; a passed file answers file-passed (test names are not
recorded for passed files, and vitest reports a file passed even when some of its tests were
skipped). Anything else is unknown with a reason, including a name that is in neither list. Unknown
is never a pass.

\`--file\` history begins at the first run carrying the artifact; before that it reports
lastPassedReason "no-artifact-history" rather than implying the file never passed, and a gh
failure partway back reports "lookup-failed".

\`--pr <n>\` reads the PR's checks once, without waiting, and prints the line \`ship --wait-ci\`
appends to a failed verdict: \`attribution=<inherited-only|new|unknown> inherited=<n> new=<m> …\`.
Only inherited-only says none of the red is the PR's. No check registered yet, or any still pending,
is \`attribution=unknown reason=<no-checks|checks-pending>\`; nothing failing is \`attribution=none\`.
Exit 2 when gh could not list the PR's checks.
Set DEVKIT_BASELINE_DEBUG=1 to surface gh's stderr.`,
};

/** A malformed invocation, reported as exit 1 rather than surfacing a stack trace. */
class UsageError extends Error {}

/** Reasons that mean the query never ran, as opposed to running and finding nothing. */
const UNPERFORMED = new Set([
  'gh-missing',
  'gh-unauthenticated',
  'not-a-github-repo',
  'workflow-missing',
  'gh-failed',
  'head-unknown',
  'history-unavailable',
]);

/**
 * Flag value, or undefined when absent or followed by another flag (`--file --json` is a typo, not
 * a path). Kept local: devkit's commands each parse their own small flag set.
 */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  // Written but valueless is a USAGE ERROR, not an absent flag: silently dropping `--file` answers
  // the run-level question instead, handing back a confident answer to a question nobody asked.
  if (!value || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
  return value;
}

const TEST_LABEL = {
  failed: 'FAILED in CI',
  passed: 'PASSED in CI',
  'file-passed': 'file PASSED in CI (test names not recorded)',
  unknown: 'UNKNOWN',
} satisfies Record<TestStatus, string>;

function render(answer: BaselineAnswer): void {
  if (answer.reason) {
    console.log(`❔ baseline unknown on ${answer.ref} — ${answer.reason}`);
    console.log(`   ${answer.detail ?? ''}`);
    for (const skipped of answer.skippedRuns) {
      console.log(`   skipped run ${skipped.runId} (${skipped.conclusion}): ${skipped.why}`);
    }
    if (answer.remedy) console.log(`   → ${answer.remedy}`);
    return;
  }
  const icon = answer.runStatus === 'green' ? '✅' : '❌';
  console.log(
    `${icon} ${answer.ref} run ${answer.runId} (attempt ${answer.attempt}, ${answer.sha?.slice(0, 8)})`,
  );
  if (answer.commitsBehindHead) {
    console.log(
      `   ${answer.commitsBehindHead} commit(s) behind ${answer.ref} head ${answer.head?.slice(0, 8)}`,
    );
    const noRun = answer.commitsWithoutRun.map((sha) => sha.slice(0, 8));
    if (noRun.length) console.log(`   no run on: ${noRun.join(', ')}`);
  }
  for (const skipped of answer.skippedRuns) {
    console.log(`   skipped run ${skipped.runId} (${skipped.conclusion}): ${skipped.why}`);
  }
  console.log(`   run: ${answer.runStatus} · tests: ${answer.testsStatus}`);
  if (answer.failingFiles.length) {
    console.log(`   ${answer.failingFiles.length} failing test file(s):`);
    for (const path of answer.failingFiles) console.log(`     ✗ ${path}`);
  } else if (answer.testsStatus === 'green') {
    console.log('   no failing test files.');
  }
  const file = answer.file;
  if (!file) return;
  console.log(
    `\n   ${file.path}: ${file.status.toUpperCase()}${file.reason ? ` — ${file.reason}` : ''}`,
  );
  for (const name of file.failingTests ?? []) console.log(`     ✗ ${name}`);
  if (file.failingTestsTruncated) console.log('     … (list capped)');
  if (file.test)
    console.log(
      `   test "${file.test.name}": ${TEST_LABEL[file.test.status]}${file.test.reason ? ` — ${file.test.reason}` : ''}`,
    );
  if (file.lastPassed) {
    console.log(
      `   last passed: ${file.lastPassed.sha.slice(0, 8)} (run ${file.lastPassed.runId})`,
    );
  } else {
    console.log(
      `   last passed: unknown (${file.lastPassedReason}; searched ${file.searchedRuns} run(s), ` +
        `${file.runsWithoutArtifact} without an artifact)`,
    );
  }
}

/** Every option this command accepts, and which of them consume the argument after them. */
const VALUED_FLAGS = new Set(['--file', '--test', '--ref', '--max-runs', '--workflow', '--pr']);
const KNOWN_FLAGS = new Set([...VALUED_FLAGS, '--json']);

/** Flag > guard.config.json > default. A corrupt config is a usage error, not a stack trace. */
function source(args: string[], cwd: string): BaselineSource {
  let configured: BaselineSource;
  try {
    configured = configuredSource(cwd);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const raw = flag(args, '--workflow');
  if (raw === undefined) return configured;
  const workflow = workflowSelector(raw);
  if (!workflow) throw new UsageError(`--workflow needs a workflow file name (got "${raw}")`);
  return { ...configured, workflow };
}

/**
 * Refuse anything this command does not understand.
 *
 * A stray positional — `devkit baseline-status cli/foo.test.mts` — reads as "tell me about this
 * file"; answering the run-level question instead returns a confident answer to a different
 * question, which is the failure mode this command exists to avoid.
 */
function assertOnlyKnownArgs(args: string[]): void {
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument ${arg}`);
    if (!KNOWN_FLAGS.has(arg)) throw new UsageError(`unknown option ${arg}`);
    // Repeats are refused rather than resolved: the value lookup takes the FIRST occurrence, so
    // `--file a --file b` would silently answer about `a` and drop the file the user typed last.
    if (seen.has(arg)) throw new UsageError(`${arg} given more than once`);
    seen.add(arg);
    if (VALUED_FLAGS.has(arg)) i++; // its value is consumed, not itself an argument
  }
}

/** What `baseline-status --pr` reports: the PR's checks as read once, then the attribution. */
interface PrAttribution extends Omit<Attribution, 'token'> {
  pr: string;
  token: AttributionToken | 'none';
  /** Set once every check has finished; a pending set has no outcome yet. */
  ci?: TerminalOutcome;
  failing?: string[];
  pending?: string[];
  cancelled?: string[];
  /** gh's own words when it could not list the checks. */
  detail?: string;
}

const names = (rows: CheckRow[]) => rows.map((row) => row.name);

/** An empty or unfinished check set is unknown, never none: one read cannot wait out either. */
function checksAnswer(cwd: string, pr: string, rows: CheckRow[]): PrAttribution {
  const s = summarise(rows);
  const seen = {
    pr,
    failing: names(s.failures),
    pending: names(s.pending),
    cancelled: names(s.cancelled),
  };
  if (rows.length === 0) return { ...seen, ...unknownAttribution('no-checks') };
  if (!s.terminal) {
    const pending = unknownAttribution('checks-pending');
    return { ...seen, ...pending, line: `${pending.line} pending=${capped(seen.pending)}` };
  }
  if (s.failures.length === 0) {
    const cancelled = seen.cancelled.length > 0 ? ` cancelled=${capped(seen.cancelled)}` : '';
    const line = `attribution=none ci=${s.outcome}${cancelled}`;
    return { ...seen, ci: s.outcome, token: 'none', inherited: 0, fresh: 0, line };
  }
  const found = attributeFailures({ cwd, pr, failures: s.failures });
  return {
    ...seen,
    ci: s.outcome,
    ...found,
    line: `failing=${capped(seen.failing)} ${found.line}`,
  };
}

/** `--pr`: one read of the PR's checks. Every other option asks about the default branch. */
function prStatus(args: string[], cwd: string, pr: string): number {
  if (!/^[1-9]\d*$/.test(pr)) throw new UsageError(`--pr needs a PR number (got "${pr}")`);
  const other = args.find((arg) => VALUED_FLAGS.has(arg) && arg !== '--pr');
  if (other) throw new UsageError(`--pr cannot be combined with ${other}`);
  source(args, cwd); // a corrupt guard.config.json is exit 1 before any gh call, not a stack trace
  const read = ghChecksPoller({ pr, cwd })();
  const answer: PrAttribution =
    read.kind === 'rows'
      ? checksAnswer(cwd, pr, read.rows)
      : { pr, ...unknownAttribution(read.reason), detail: read.message };
  if (args.includes('--json')) console.log(JSON.stringify(answer, null, 2));
  else renderPr(answer);
  return read.kind === 'rows' ? 0 : 2; // 2: gh could not list the checks, so nothing was read
}

function renderPr(answer: PrAttribution): void {
  console.log(`pr=${answer.pr} ${answer.line}`);
  if (answer.detail) console.log(`   ${answer.detail}`);
}

export default function baselineStatus(args: string[], cwd: string) {
  let answer: BaselineAnswer;
  try {
    assertOnlyKnownArgs(args);
    const pr = flag(args, '--pr');
    if (pr !== undefined) return prStatus(args, cwd, pr);
    const file = flag(args, '--file');
    const test = flag(args, '--test');
    if (test && !file) throw new UsageError('--test needs --file <path> (the file the test is in)');
    const maxRunsRaw = flag(args, '--max-runs');
    const maxRuns = maxRunsRaw ? Number(maxRunsRaw) : DEFAULT_MAX_RUNS;
    // Integer, not merely finite: `--limit 1.5` fails inside gh, so a bad ARGUMENT would surface as
    // a gh failure and exit 2 — the code reserved for "the query could not be performed".
    if (!Number.isInteger(maxRuns) || maxRuns < 1) {
      throw new UsageError(`--max-runs must be a positive whole number (got ${maxRunsRaw})`);
    }
    answer = queryBaseline({
      cwd,
      ref: flag(args, '--ref'),
      file,
      test,
      maxRuns,
      ...source(args, cwd),
    });
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`🚫 ${e.message}.`);
    return 1;
  }
  if (args.includes('--json')) console.log(JSON.stringify(answer, null, 2));
  else render(answer);
  // "No run carries data yet" is a successful query; see `meta.help` for the three-way contract.
  return UNPERFORMED.has(answer.reason ?? '') ? 2 : 0;
}
