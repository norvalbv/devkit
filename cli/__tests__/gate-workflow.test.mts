/** gate.yml's `required` job is main's one required status check: it must need every other job and
 *  pass only when each of them succeeded. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { testSpawnSync } from './_helpers.mts';

const gateWorkflow = fileURLToPath(new URL('../../.github/workflows/gate.yml', import.meta.url));
const text = readFileSync(gateWorkflow, 'utf8');
const jobs = text.slice(text.indexOf('\njobs:\n'));
/** A job key: two spaces in, nothing after the colon. Keys elsewhere either sit deeper or hold values. */
const JOB_KEY = /^ {2}([\w-]+):$/gm;

/** The `required` job's own lines, up to the next job key. */
function requiredJob(): string {
  const start = jobs.indexOf('\n  required:\n');
  expect(start, 'gate.yml must define a `required` job').toBeGreaterThan(-1);
  const rest = jobs.slice(start + 1);
  const next = rest.slice(1).search(/^ {2}[\w-]+:$/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('gate.yml required job', () => {
  it('needs every other job, so a job added later is required with no settings change', () => {
    const others = [...jobs.matchAll(JOB_KEY)].map((m) => m[1]).filter((id) => id !== 'required');
    const needs = /^ {4}needs: \[([^\]]*)\]$/m.exec(requiredJob())?.[1];
    expect(
      needs
        ?.split(',')
        .map((id) => id.trim())
        .toSorted(),
    ).toEqual(others.toSorted());
  });

  it('runs whatever its needs concluded, cancelled included, and reads them as RESULTS', () => {
    const job = requiredJob();
    expect(job).toMatch(/^ {4}if: always\(\)$/m);
    expect(job).toContain('RESULTS: ${{ toJSON(needs) }}');
  });

  it.each([
    [{ gate: { result: 'success' } }, 0],
    [{ gate: { result: 'failure' } }, 1],
    [{ gate: { result: 'cancelled' } }, 1],
    [{ gate: { result: 'success' }, later: { result: 'skipped' } }, 1],
    [{}, 1],
  ])('needs %j exits %i', (needs, status) => {
    const script = /run: \|\n([\s\S]*)$/.exec(requiredJob())?.[1];
    expect(script).toBeDefined();
    const result = testSpawnSync('bash', ['-c', script!], {
      encoding: 'utf8',
      env: { ...process.env, RESULTS: JSON.stringify(needs) },
    });
    // Exactly 1, jq -e's false: a missing jq (127) or a syntax error (3) must not pass as a refusal.
    expect(result.status, result.stderr).toBe(status);
  });
});
