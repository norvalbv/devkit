import { spawnSync } from 'node:child_process';

/** The newest CI run on the base branch: { sha, branch, runId, attempt }. */
export function latestRun(branch = 'main') {
  const out = spawnSync(
    'gh',
    ['run', 'list', '--branch', branch, '--limit', '1', '--json', 'headSha,databaseId,attempt'],
    { encoding: 'utf8' },
  ).stdout;
  const [r] = JSON.parse(out || '[]');
  return r ? { sha: r.headSha, branch, runId: r.databaseId, attempt: r.attempt } : null;
}

/** Downloads the per-file summary artifact of one run. */
export async function downloadSummary(run) {
  const out = spawnSync('gh', ['run', 'download', String(run.runId), '-n', 'test-summary', '-D', '-'], {
    encoding: 'utf8',
  }).stdout;
  return JSON.parse(out);
}
