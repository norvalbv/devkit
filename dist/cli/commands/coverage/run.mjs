/**
 * `devkit coverage-run` — produce the artifact the coverage gate reads, safely under parallel agents.
 *
 * A consumer that selected the `coverage` guard points its own script at this:
 *   "test:run:coverage": "devkit coverage-run"
 * and nothing else changes — no vitest.config edit, because the reports directory is overridden on
 * vitest's command line. See gate-engine/coverage/produce.mts for why that isolation is required.
 */
import { produceCoverage } from "../../../gate-engine/coverage/produce.mjs";
export const meta = {
    name: 'coverage-run',
    summary: 'Run vitest with coverage in an isolated reports dir (parallel-agent safe).',
    help: `devkit coverage-run — run the test suite with coverage without racing a sibling agent.

Usage (wire it as the consumer's own coverage script):
  "test:run:coverage": "devkit coverage-run"

  devkit coverage-run [...vitest args]     extra args are forwarded to \`vitest run\`

Each run gets its own coverage/.runs/<unique> reports directory and republishes to
coverage/coverage-final.json — the path \`guard-coverage\` reads — so two agents running tests in one
working tree can no longer delete each other's coverage temp files mid-run.

A run that produces no report (failing tests) REMOVES the stable artifact rather than leaving a stale
one, keeping the coverage gate fail-closed. Exits with vitest's exit code. Vitest-only; the gate
itself accepts any istanbul-shaped report.`,
};
export default async function coverageRun(args, cwd) {
    return await produceCoverage(cwd, args);
}
