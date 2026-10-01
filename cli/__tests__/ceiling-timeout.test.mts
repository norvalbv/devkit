/** sc-2785: pins the ceiling-timeout classifier and the per-run load line, so a load-lost ceiling
 *  reads as load from the output alone. */
import { describe, expect, it } from 'vitest';
import { formatLoadLine, setup, teardown } from '../../vitest.global-setup.mjs';
import vitestConfig from '../../vitest.config.mjs';
import e2eConfig from '../../vitest.e2e.config.mjs';
import { ceilingTimeoutMessage } from './_helpers.mts';

const LOAD = { loadavg: [203.224, 210.65, 177.4], cpus: 10 };
const SNAPSHOT_CEILING =
  '⏱  devkit review: setup/teardown hit the 90s ceiling DURING: snapshot\n   No gate verdict was reached.';
const ASSETS = { marker: 'ASSET_WEDGE_STARTED', expected: 'assets', ...LOAD };

describe('ceilingTimeoutMessage', () => {
  it('labels a ceiling that fired before setup reached the wedge, naming both phases and the load', () => {
    const message = ceilingTimeoutMessage({ status: 124, output: SNAPSHOT_CEILING, ...ASSETS });
    expect(message).toMatch(/^ceiling-timeout: /);
    expect(message).toContain('fired during snapshot before reaching assets');
    expect(message).toContain('loadavg=203.22/210.65/177.40 cpus=10');
    // The raw output stays attached: the label adds a verdict, it must not hide the evidence.
    expect(message).toContain(SNAPSHOT_CEILING);
  });

  // The feature-critique's regression guard: a REACHED wedge with the wrong phase is a product
  // regression (phase naming broke), and labelling it load noise would invite an agent to ship it.
  it('stays silent once the wedge was reached, even when the ceiling names the wrong phase', () => {
    const output = `ASSET_WEDGE_STARTED\n${SNAPSHOT_CEILING}`;
    expect(ceilingTimeoutMessage({ status: 124, output, ...ASSETS })).toBeNull();
  });

  it.each([
    ['a passing run', 0],
    ['an ordinary failure', 1],
    ['a user interrupt', 143],
    ['a run killed by the spawn timeout (no exit status)', null],
  ])('stays silent for %s, which the existing assertions already report', (_name, status) => {
    expect(ceilingTimeoutMessage({ status, output: SNAPSHOT_CEILING, ...ASSETS })).toBeNull();
  });

  it('keeps a colon-qualified step name whole', () => {
    const output =
      '⏱  devkit review: setup/teardown hit the 90s ceiling DURING: preflight-verify:deps-snapshot\n';
    const message = ceilingTimeoutMessage({
      status: 124,
      output,
      marker: 'DEPS_VERIFY_WEDGE_STARTED',
      expected: 'preflight-verify:deps-final',
      ...LOAD,
    });
    expect(message).toContain(
      'fired during preflight-verify:deps-snapshot before reaching preflight-verify:deps-final',
    );
  });

  // review-target.sh accepts a fractional DEVKIT_PREFLIGHT_TIMEOUT and echoes it verbatim.
  it('parses a fractional ceiling', () => {
    const output = '⏱  devkit review: setup/teardown hit the 1.5s ceiling DURING: worktree-final\n';
    const message = ceilingTimeoutMessage({ status: 124, output, ...ASSETS });
    expect(message).toContain('the 1.5s setup ceiling fired during worktree-final');
  });

  // Another layer can also exit 124; without review's own banner nothing proves the setup ceiling fired.
  it('stays silent for a 124 that carries no setup-ceiling banner', () => {
    expect(ceilingTimeoutMessage({ status: 124, output: 'truncated', ...ASSETS })).toBeNull();
  });

  it('blames load only when the 1-minute loadavg exceeds the cpu count', () => {
    const message = ceilingTimeoutMessage({ status: 124, output: SNAPSHOT_CEILING, ...ASSETS });
    expect(message).toContain('machine load is the likely cause');
    expect(message).not.toContain('suspect a real hang');
  });

  // An earlier phase that genuinely hangs looks identical apart from the load, so the label must say so.
  it.each([
    ['an idle box', [0.5, 0.4, 0.3]],
    ['a box exactly at its cpu count', [10, 10, 10]],
  ])('points at a real hang in the reached phase on %s', (_name, loadavg) => {
    const message = ceilingTimeoutMessage({
      status: 124,
      output: SNAPSHOT_CEILING,
      ...ASSETS,
      loadavg,
      cpus: 10,
    });
    expect(message).toMatch(/^ceiling-timeout: /);
    expect(message).toContain('suspect a real hang in snapshot');
    expect(message).not.toContain('likely cause');
  });

  it('reads the live machine load when none is injected', () => {
    const message = ceilingTimeoutMessage({
      status: 124,
      output: SNAPSHOT_CEILING,
      marker: 'ASSET_WEDGE_STARTED',
      expected: 'assets',
    });
    expect(message).toMatch(/loadavg=\d+\.\d{2}\/\d+\.\d{2}\/\d+\.\d{2} cpus=[1-9]\d*/);
  });
});

describe('vitest load line', () => {
  it('formats a fixed, greppable line', () => {
    expect(formatLoadLine('start', [1.23456, 0, 12], 8)).toBe(
      'devkit test load: start loadavg=1.23/0.00/12.00 cpus=8',
    );
  });

  // Windows reports [0, 0, 0]: print it as-is rather than guessing, the cpu count still informs.
  it('prints an all-zero load verbatim', () => {
    expect(formatLoadLine('end', [0, 0, 0], 4)).toBe(
      'devkit test load: end loadavg=0.00/0.00/0.00 cpus=4',
    );
  });

  it('prints a start line on setup and an end line on teardown, to stderr only', () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: string) => lines.push(line);
    try {
      setup();
      teardown();
    } finally {
      console.error = original;
    }
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^devkit test load: start loadavg=/);
    expect(lines[1]).toMatch(/^devkit test load: end loadavg=/);
  });

  // Wiring: a reporter would be replaced by produce.mts's CLI --reporter flags, and a per-project
  // entry would print once per project. Root-level globalSetup runs once whatever reporter is active.
  it('is registered once, at the root, and not per project', () => {
    const test = vitestConfig.test ?? {};
    expect(test.globalSetup).toEqual(['./vitest.global-setup.mjs']);
    for (const project of test.projects ?? []) {
      expect(project).not.toHaveProperty('test.globalSetup');
    }
    // The e2e config keeps its build step and stamps load too, so "every run" holds for both suites.
    // Order matters: vitest stops at a throwing setup, so the stamp must precede the e2e build.
    expect(e2eConfig.test?.globalSetup).toEqual([
      './vitest.global-setup.mjs',
      './e2e/lib/global-setup.mts',
    ]);
  });
});
