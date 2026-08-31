import { proveRegression } from '../../lib/baseline-status/regression-proof.mjs';
export const meta = {
    name: 'prove-regression',
    summary: 'Capture the same test command at explicit red and green refs without editing checkout.',
    help: `devkit prove-regression — capture attributable red/green execution evidence.

Usage:
  devkit prove-regression --red <ref> --green <ref> \\
    [--vitest-report <working-directory-relative-json-path>] -- <test command> [args...]

The exact argv after -- runs from the same repository-relative directory in two independent,
unregistered disposable clones. Both refs must already contain the test and support files; the
normal workflow is an explicit test-only red commit followed by the fixed green commit.

Exit 0 means the same argv exited nonzero at red and zero at green, the caller's two sampled boundary
fingerprints matched, and the clone cleanup checks passed. The samples detect ordinary caller
mutation but are not an atomic filesystem snapshot. This is CAPTURED execution evidence, not
automatic proof that the red failure was caused by the ticket or that the whole suite is healthy.
Review the retained red output before publishing the Markdown.

--vitest-report optionally names a report file that the command writes inside each clone using
Vitest's built-in JSON reporter. Devkit records its exact test counts and bounded red failure
messages; when this adapter is requested, a missing or malformed report makes the capture
inconclusive without replacing the recorded process exits. Example:

  devkit prove-regression --red <test-only-sha> --green <fixed-sha> \\
    --vitest-report .proof.json -- node_modules/.bin/vitest run path/to/test.mts \\
    --root . --reporter=default --reporter=json --outputFile.json=.proof.json

The command never invokes a shell. Consumer commands remain unsandboxed, so run trusted test commands
only; deliberately daemonized children can evade portable cleanup. Repo-local GIT_* overrides are
removed before Git or the command runs so hook state cannot redirect work into the caller checkout.
When available, the caller's node_modules is copied into an isolated dependency snapshot and each
operand receives an independent copy; caller dependency bytes are never linked. The Vitest example
pins --root . because its output paths are root-relative; the named report must land at the
command-working-directory-relative path given to --vitest-report. Windows interruption terminates
only the direct helper through Node's retained process handle; descendants can outlive it because
tree-wide PID killing can target an unrelated process after PID reuse.

On a completed run, evidence.json, evidence.md, stdout/stderr, and optional reports are retained under
the printed temporary evidence directory. Exit 1 means inconclusive, invalid input, or setup failure;
a handled interruption returns the signal exit status.`,
};
export default async function proveRegressionCommand(args, cwd) {
    return await proveRegression(args, cwd);
}
