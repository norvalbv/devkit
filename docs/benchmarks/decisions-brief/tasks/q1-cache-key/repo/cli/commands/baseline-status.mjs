import { downloadSummary, latestRun } from '../lib/baseline-status/latest-run.mjs';

/** Answers "was this file passing on the base branch?" from the CI per-file summary. */
export async function baselineStatus(file) {
  const run = latestRun();
  if (!run) return { file, status: 'unknown' };
  const summary = await downloadSummary(run);
  return { file, status: summary.files?.[file] ?? 'absent', runStatus: summary.runStatus };
}
