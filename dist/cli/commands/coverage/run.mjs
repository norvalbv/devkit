/**
 * `devkit coverage-run` — produce the artifact the coverage gate reads, safely under parallel agents.
 *
 * A consumer that selected the `coverage` guard points its own script at this:
 *   "test:run:coverage": "devkit coverage-run"
 * and nothing else changes — no vitest.config edit, because the reports directory is overridden on
 * vitest's command line. See gate-engine/coverage/produce.mts for why that isolation is required.
 */
import { produceCoverage } from '../../../gate-engine/coverage/produce.mjs';
export const meta = {
    name: 'coverage-run',
    agentFacing: false,
    notRoutedBecause: "Wired ONCE as the consumer's own test:run:coverage script; the coverage gate consumes" +
        "the artifact it leaves behind. An agent runs the repo's own test script, not this.",
    summary: 'Run vitest with coverage in an isolated reports dir (parallel-agent safe).',
    help: `devkit coverage-run — run the test suite with coverage without racing a sibling agent.

Usage (wire it as the consumer's own coverage script):
  "test:run:coverage": "devkit coverage-run"

  devkit coverage-run [...vitest args]     extra args are forwarded to \`vitest run\`

Each run gets its own coverage/.runs/<unique> reports directory and republishes to
coverage/coverage-final.json — the path \`guard-coverage\` reads — so two agents running tests in one
working tree can no longer delete each other's coverage temp files mid-run.

A run that produces no report (failing tests) REMOVES the stable artifact rather than leaving a stale
one, keeping the coverage gate fail-closed. It also leaves coverage/.last-clear.json recording what
failed, so the gate can say "discarded by a failed run, none of it staged" instead of just "no
coverage data".

Two flags are added on your behalf. Both step aside when you name them on the command line.
Precedence against your vitest.config, verified against vitest 4.1.10:
  - a 'reporters' array in vitest.config WINS over our --reporter, so no devkit report is
    produced; the retry then says so on stderr rather than rescuing a test silently.
  - a 'retry' in vitest.config also wins: the dotted --retry.count we pass does NOT reduce it
    (only the plain --retry does, and we never pass that), so your retry policy is kept.
  --retry.count=1 --retry.condition='(Test|Hook) timed out'
      Retries a test that TIMED OUT, once. Assertion failures are never retried. A test that only
      passes on the retry is reported as flaky on stderr, not swallowed. Pass any --retry form
      (--retry=0 disables) to take full ownership. Needs vitest >=4.1; below that it is skipped
      out loud.
  --reporter=default --reporter=json --outputFile.json=<run dir>/results.json
      How the failed-file and flaky reporting is read. Pass your own --reporter, configure
      'reporters' in vitest.config, or set DEVKIT_COVERAGE_NO_DIAGNOSIS=1, to drop it.

Exits with vitest's exit code. Vitest-only; the gate itself accepts any istanbul-shaped report.`,
};
export default async function coverageRun(args, cwd) {
    return await produceCoverage(cwd, args);
}
