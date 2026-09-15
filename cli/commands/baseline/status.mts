/** `devkit baseline-status` (sc-2245) — see `meta.help` below for the full contract. */
import {
  type BaselineAnswer,
  DEFAULT_ARTIFACT,
  DEFAULT_MAX_RUNS,
  DEFAULT_WORKFLOW,
  queryBaseline,
} from '../../lib/baseline-status/query.mts';

export const meta = {
  name: 'baseline-status',
  agentFacing: true,
  summary: 'Report which test files are failing on the default branch (and whether yours is).',
  help: `devkit baseline-status — decompose a red default branch into per-file facts.

Usage:
  devkit baseline-status [--file <path>] [--json] [--ref <branch>] [--max-runs <n>]

  --file <path>    answer for one test file, plus the last run in which it passed
  --json           machine-readable output (the intended interface for agents)
  --ref <branch>   branch to read (default: the remote's HEAD, else main)
  --max-runs <n>   how far back to walk for --file (default: ${DEFAULT_MAX_RUNS})

Reads the \`${DEFAULT_ARTIFACT}\` artifact that \`devkit test-report-run\` uploads from
${DEFAULT_WORKFLOW}. No log scraping: a CI log interleaves failures from nested test runs, so
grepping it cannot prove a file passed.

Two verdicts are reported separately, because they differ constantly:
  runStatus     the whole run — lint, typecheck, ratchets AND tests
  testsStatus   the test step alone

A file is passed / failed / skipped / excluded (existed but the runner did not collect it) /
absent (did not exist at that commit) / unknown. Those are not interchangeable: an undifferentiated
"did not run" reads as reassurance and would swallow a path typo.

This never guesses. Missing gh, no GitHub remote, an expired artifact or a run killed before the
reporter flushed all report \`unknown\` with a named reason.

Exit 0 = the query ran, including "no run carries data yet". Exit 2 = it could not be performed at
all (no gh, not authenticated, no GitHub remote). Exit 1 = a bad argument.

\`--file\` history begins at the first run carrying the artifact; before that it reports
lastPassedReason "no-artifact-history" rather than implying the file never passed.
Set DEVKIT_BASELINE_DEBUG=1 to surface gh's stderr.`,
};

/** A malformed invocation, reported as exit 1 rather than surfacing a stack trace. */
class UsageError extends Error {}

/** Reasons that mean the query never ran, as opposed to running and finding nothing. */
const UNPERFORMED = new Set(['gh-missing', 'gh-unauthenticated', 'not-a-github-repo', 'gh-failed']);

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

function render(answer: BaselineAnswer): void {
  if (answer.reason) {
    console.log(`❔ baseline unknown on ${answer.ref} — ${answer.reason}`);
    console.log(`   ${answer.detail ?? ''}`);
    for (const skipped of answer.skippedRuns) {
      console.log(`   skipped run ${skipped.runId} (${skipped.conclusion}): ${skipped.why}`);
    }
    return;
  }
  const icon = answer.runStatus === 'green' ? '✅' : '❌';
  console.log(
    `${icon} ${answer.ref} run ${answer.runId} (attempt ${answer.attempt}, ${answer.sha?.slice(0, 8)})`,
  );
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
const KNOWN_FLAGS = new Set(['--file', '--json', '--ref', '--max-runs']);
const VALUED_FLAGS = new Set(['--file', '--ref', '--max-runs']);

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

export default function baselineStatus(args: string[], cwd: string) {
  let answer: BaselineAnswer;
  try {
    assertOnlyKnownArgs(args);
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
      file: flag(args, '--file'),
      maxRuns,
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
