/** gate.yml's `required` job is main's one required status check: it must need every other job and
 *  pass only when each of them succeeded. The `gate` job must run the Node that engines allows. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { testSpawnSync } from './_helpers.mts';

const gateWorkflow = fileURLToPath(new URL('../../.github/workflows/gate.yml', import.meta.url));
const text = readFileSync(gateWorkflow, 'utf8');
const jobs = text.slice(text.indexOf('\njobs:\n'));
/** A job key: two spaces in, nothing after the colon. Keys elsewhere either sit deeper or hold values. */
const JOB_KEY = /^ {2}([\w-]+):$/gm;

/** A job's own lines, up to the next job key. */
function job(id: string): string {
  const start = jobs.indexOf(`\n  ${id}:\n`);
  expect(start, `gate.yml must define a \`${id}\` job`).toBeGreaterThan(-1);
  const rest = jobs.slice(start + 1);
  const next = rest.slice(1).search(/^ {2}[\w-]+:$/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('gate.yml required job', () => {
  it('needs every other job, so a job added later is required with no settings change', () => {
    const others = [...jobs.matchAll(JOB_KEY)].map((m) => m[1]).filter((id) => id !== 'required');
    const needs = /^ {4}needs: \[([^\]]*)\]$/m.exec(job('required'))?.[1];
    expect(
      needs
        ?.split(',')
        .map((id) => id.trim())
        .toSorted(),
    ).toEqual(others.toSorted());
  });

  it('runs whatever its needs concluded, cancelled included, and reads them as RESULTS', () => {
    const required = job('required');
    expect(required).toMatch(/^ {4}if: always\(\)$/m);
    expect(required).toContain('RESULTS: ${{ toJSON(needs) }}');
  });

  it('posts its check run as `required`, the context main ruleset names, with no name or matrix', () => {
    expect(job('required')).not.toMatch(/^ {4}(name|strategy):/m);
  });

  it('runs on every pull request, so no PR waits forever on a check that never reports', () => {
    expect(text).toMatch(/^ {2}pull_request:\n(?!(?:[ \t]*(?:#.*)?\n)* {3})/m);
  });

  it.each([
    [{ gate: { result: 'success' } }, 0],
    [{ gate: { result: 'failure' } }, 1],
    [{ gate: { result: 'cancelled' } }, 1],
    [{ gate: { result: 'success' }, later: { result: 'skipped' } }, 1],
    [{}, 1],
  ])('needs %j exits %i', (needs, status) => {
    const script = /run: \|\n([\s\S]*)$/.exec(job('required'))?.[1];
    expect(script).toBeDefined();
    const result = testSpawnSync('bash', ['-c', script!], {
      encoding: 'utf8',
      env: { ...process.env, RESULTS: JSON.stringify(needs) },
    });
    // Exactly 1, jq -e's false: a missing jq (127) or a syntax error (3) must not pass as a refusal.
    expect(result.status, result.stderr).toBe(status);
  });
});

/** A version's three parts as one sortable string; a missing part reads as 0. */
function rank(parts: RegExpExecArray): string {
  return parts
    .slice(1, 4)
    .map((part = '0') => part.padStart(6, '0'))
    .join('.');
}

/** Whether .nvmrc's version meets a plain `>=X[.Y[.Z]]` engines floor; any other shape is false. */
function nvmrcMeetsEngines(nvmrc: string, engines: string): boolean {
  const pinned = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(nvmrc.trim());
  const floor = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(engines);
  return pinned !== null && floor !== null && rank(pinned) >= rank(floor);
}

describe('gate.yml gate job Node', () => {
  it('sets up node from .nvmrc before Install, so no step runs the runner default', () => {
    const steps = job('gate').split(/^ {6}- /m);
    const setup = steps.findIndex((step) => step.startsWith('uses: actions/setup-node@'));
    expect(setup, 'gate job must use actions/setup-node').toBeGreaterThan(-1);
    expect(steps[setup]).toMatch(/^ {10}node-version-file: \.nvmrc$/m);
    expect(setup).toBeLessThan(steps.findIndex((step) => step.startsWith('name: Install\n')));
  });

  it('pins an .nvmrc version that package.json engines allows', () => {
    const root = new URL('../../', import.meta.url);
    const manifest = z.object({ engines: z.object({ node: z.string() }) });
    const engines = manifest.parse(JSON.parse(readFileSync(new URL('package.json', root), 'utf8')))
      .engines.node;
    const nvmrc = readFileSync(new URL('.nvmrc', root), 'utf8');
    expect(nvmrcMeetsEngines(nvmrc, engines), `.nvmrc ${nvmrc.trim()} vs ${engines}`).toBe(true);
  });

  it.each([
    ['24', '>=23.6', true],
    ['23.6', '>=23.6', true],
    ['23.6.0', '>= 23.6.1', false],
    ['23.5.9', '>=23.6', false],
    ['22.99', '>=23.6', false],
    ['23', '>=23.6', false],
    ['v24.1.0\r\n', '>=23', true],
    ['lts/*', '>=23.6', false],
    ['24', '^24 || >=26', false],
    ['100', '>=99.6', true],
  ])('.nvmrc %j against engines %j meets it: %s', (nvmrc, engines, meets) => {
    expect(nvmrcMeetsEngines(nvmrc, engines)).toBe(meets);
  });
});
