/**
 * On-disk cache for per-file test summaries, under .cache/baseline/.
 *
 * @param {{ sha: string, branch: string, runId: number, attempt: number }} run  the CI run on the base branch
 * @param {(run: object) => Promise<object>} fetchSummary  downloads the summary artifact for `run`
 * @returns {Promise<object>} the summary
 */
export async function getCached(run, fetchSummary) {
  // TODO: no cache yet — always downloads.
  return fetchSummary(run);
}
