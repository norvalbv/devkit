import { subtractionTrial } from '../../lib/baseline-status/subtraction-trial.mts';

export const meta = {
  name: 'subtraction-trial',
  agentFacing: true,
  summary: 'Observe a candidate deletion or native-mode ref with a known-invalid control.',
  valueFlags: ['--baseline', '--candidate', '--control', '--oracle', '--vitest-report'],
  help: `devkit subtraction-trial — advisory subtraction experiment (prototype).

Usage:
  devkit subtraction-trial --baseline <ref> --candidate <ref> --control <ref> \\
    --oracle <repo-relative-file> [--oracle <file> ...] --vitest-report <json-path> \\
    -- <test command> [args...]

Prepare three committed refs: passing baseline, proposed deletion/native-mode candidate, and a
known-invalid control that should fail the selected assertions. Declare every test/config/script
file governing your oracle with --oracle; these tracked regular files must be identical at all refs.
The harness checks declared files only. Selecting a sufficient oracle and a relevant control remain
review obligations. Vitest's standard JSON report must be written at the command-relative path.

The same exact argv runs in independent disposable clones using prove-regression's capture engine.
Exit 0 means nonempty assertions passed at both baseline runs and candidate, with equal assertion
counts and at least one failed control assertion. This tests-preserved observation does not prove
redundancy or authorize deleting code. A candidate assertion failure is tests-failed; blind controls
or zero executed assertions are oracle_blind. Unavailable reports, incomplete results and unsafe
capture facts are inconclusive (all exit 1). Removed-hunk coverage is not measured in this prototype.

The candidate diff, diff hash, explicit SHAs, oracle identities and raw execution artifacts are
retained at the printed evidence paths. Commands are trusted and unsandboxed; the existing capture
engine's process and non-atomic caller-sample limits apply. Every operand copies one isolated
dependency template prepared before any test runs. This v0 requires
Vitest-compatible reports; support for other reporters is future work.`,
};

export default async function subtractionTrialCommand(args: string[], cwd: string) {
  return await subtractionTrial(args, cwd);
}
