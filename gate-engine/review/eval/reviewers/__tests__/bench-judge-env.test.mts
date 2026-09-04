/** runRow hands the judge the gate's env: DEVKIT_CHECKLIST_KEEP=1 keeps an all-pass checklist
 * artifact alive for the contract read (sc-2494 — every PASS row voided without it). */
import { describe, expect, it } from 'vitest';
import { BENCH_REVIEWERS, runRow } from '../bench.mts';
import { loadRows } from '../corpus.mts';

describe('runRow judge env', () => {
  it('spawns every judge pass with DEVKIT_CHECKLIST_KEEP=1', async () => {
    const reviewer = BENCH_REVIEWERS.find((r) => r.name === 'backend-performance-reviewer');
    const row = loadRows(reviewer, { only: 'beperf-decoy-bounded-startup-loop' })[0];
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];
    const exec = async (opts: { env?: NodeJS.ProcessEnv }) => {
      envs.push(opts.env);
      return 'VERDICT: PASS — bench stub';
    };
    const res = await runRow(row, { model: 'haiku', cascade: false, exec });
    expect(res.id).toBe(row.id);
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) expect(env?.DEVKIT_CHECKLIST_KEEP).toBe('1');
  });
});
