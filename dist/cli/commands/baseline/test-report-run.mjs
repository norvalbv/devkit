/** `devkit test-report-run` (sc-2245) — see `meta.help` below for the consumer wiring. */
import { REPORT_NAME, RUNS_DIR, SUMMARY_NAME, produceTestReport, } from '../../lib/baseline-status/produce.mjs';
export const meta = {
    name: 'test-report-run',
    summary: 'Run vitest and emit a machine-readable per-file test report for CI.',
    help: `devkit test-report-run — run the test suite and record WHICH files passed.

Usage (wire it as the consumer's own script, then run it in CI):
  "test:run:report": "devkit test-report-run"

  devkit test-report-run [...vitest args]   extra args are forwarded to \`vitest run\`

Writes this run's own directory under ${RUNS_DIR}/<run>/ and exits with vitest's exit code:
  ${REPORT_NAME}    vitest's full report (multi-MB on a large suite)
  ${SUMMARY_NAME}   a few-KB per-file reduction — what \`devkit baseline-status\` reads

Nothing is written to a shared path, so concurrent runs in one checkout cannot overwrite or delete
each other's output. Upload the two names as SEPARATE CI artifacts with \`if: always()\` — a red run
is the one the per-file record exists to decompose, and keeping them apart lets a baseline query
fetch only the small one. The reader selects by the provenance recorded inside the summary, never by
filename, so a directory left behind by an earlier run cannot be mistaken for this one's.

The console summary and the GitHub PR annotations are preserved — the json reporter is added
alongside them, never in place of them. Vitest-only; \`devkit baseline-status\` is not.`,
};
export default async function testReportRun(args, cwd) {
    return await produceTestReport(cwd, args);
}
