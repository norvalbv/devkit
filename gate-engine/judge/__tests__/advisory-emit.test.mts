/**
 * sc-2526: the advisory channel. The pure verdict reader carries the risk — it decides whether a
 * finding reaches the terminus at all, and its predecessor (the exit code) missed a whole class.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emitAdvisoryResult, reportFallowAudit, summariseFallowAudit } from '../advisory/emit.mts';

// vitest.setup holds DEVKIT_NO_TELEMETRY=1 suite-wide; an explicit sink + ship id opts back in.
const ENV_KEYS = ['DEVKIT_GATE_EVENTS', 'DEVKIT_SHIP_ID', 'DEVKIT_SHIP_BRANCH'];
const saved: Record<string, string | undefined> = {};
let sink: string;

const events = () => {
  try {
    return readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  sink = path.join(mkdtempSync(path.join(tmpdir(), 'advisory-emit-')), 'gate-events.jsonl');
  process.env.DEVKIT_GATE_EVENTS = sink;
  process.env.DEVKIT_SHIP_ID = 'ship-advisory';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('summariseFallowAudit', () => {
  it('treats a warn verdict as a FINDING — the case an exit code cannot see', () => {
    // Reproduced against fallow 3.10.0: a duplication-only changeset returns verdict=warn and
    // EXIT 0 while still reporting the clone group. An exit-code row would miss exactly this run.
    expect(
      summariseFallowAudit('{"verdict":"warn","attribution":{"duplication_introduced":1}}'),
    ).toEqual({
      token: 'findings',
      detail: 'verdict=warn · 1 duplication introduced — read the fallow section of the log',
    });
  });

  it('is clean only when the verdict passes AND nothing was introduced', () => {
    expect(summariseFallowAudit('{"verdict":"pass"}')?.token).toBe('clean');
    expect(
      summariseFallowAudit('{"verdict":"pass","attribution":{"complexity_introduced":0}}')?.token,
    ).toBe('clean');
    // A pass verdict over a non-zero counter is fallow demoting a finding, not the absence of one.
    expect(
      summariseFallowAudit('{"verdict":"pass","attribution":{"dead_code_introduced":2}}')?.token,
    ).toBe('findings');
  });

  it('names every non-zero counter fallow published, and omits the zeroes', () => {
    const detail = summariseFallowAudit(
      '{"verdict":"fail","attribution":{"complexity_introduced":3,"duplication_introduced":1,"dead_code_introduced":0}}',
    )?.detail;
    expect(detail).toContain('3 complexity, 1 duplication introduced');
    expect(detail).not.toContain('dead code');
  });

  it('refuses to call an unreadable report clean', () => {
    // Silence about a report devkit could not read is the same silence sc-2526 exists to remove.
    expect(summariseFallowAudit('not json')).toBeNull();
    expect(summariseFallowAudit('{"attribution":{}}')).toBeNull(); // no verdict
    expect(summariseFallowAudit('[]')).toBeNull();
    expect(summariseFallowAudit('null')).toBeNull();
  });

  it('ignores a counter that is not a finite number rather than throwing on it', () => {
    // The report is unvalidated vendor JSON: a declared shape is an assertion, not a guarantee.
    expect(
      summariseFallowAudit('{"verdict":"pass","attribution":{"complexity_introduced":"lots"}}')
        ?.token,
    ).toBe('clean');
  });
});

describe('reportFallowAudit', () => {
  it('emits nothing on a clean audit', () => {
    expect(reportFallowAudit(() => '{"verdict":"pass"}', false)).toBe('clean');
    expect(events()).toEqual([]);
  });

  it('emits a finding row without a family, so it can never claim it blocked the run', () => {
    expect(
      reportFallowAudit(
        () => '{"verdict":"fail","attribution":{"complexity_introduced":3}}',
        false,
      ),
    ).toBe('findings');
    const [ev] = events();
    expect(ev).toMatchObject({
      type: 'advisory_result',
      gate: 'fallow-advisory',
      status: 'finding',
      ship_id: 'ship-advisory',
    });
    expect(ev.family).toBeUndefined();
  });

  it('refuses a clean verdict from an audit that exited non-zero, rather than believing the report', () => {
    // fallow exits non-zero for a FAIL verdict, so non-zero is only contradictory beside a CLEAN
    // report — and a report its own process contradicts is not evidence of anything.
    expect(reportFallowAudit(() => '{"verdict":"pass"}', false, true)).toBe('unreadable');
    expect(events()[0]).toMatchObject({ status: 'could_not_run' });
    expect(events()[0].detail).toContain('exited non-zero');
  });

  it('still reports a normal finding when a non-zero exit accompanies a non-clean verdict', () => {
    // The ordinary blocking case: exit 1 AND verdict=fail agree, so the row is a finding, not a
    // could_not_run — treating every non-zero exit as unreadable would erase the common path.
    expect(
      reportFallowAudit(
        () => '{"verdict":"fail","attribution":{"complexity_introduced":2}}',
        false,
        true,
      ),
    ).toBe('findings');
    expect(events()[0]).toMatchObject({ status: 'finding' });
  });

  it('reports a could_not_run when fallow is absent or its report is unreadable', () => {
    expect(reportFallowAudit(() => '', true)).toBe('unreadable');
    expect(events()[0].detail).toContain('not on PATH');
  });

  it('contains a throwing reader rather than letting it reach the hook', () => {
    expect(
      reportFallowAudit(() => {
        throw new Error('ENOENT');
      }, false),
    ).toBe('unreadable');
    expect(events()[0]).toMatchObject({ status: 'could_not_run' });
  });
});

describe('emitAdvisoryResult', () => {
  it('caps detail so one row cannot tear a concurrent judges row in the shared sink', () => {
    emitAdvisoryResult('skill-projection', 'finding', 'x'.repeat(900));
    expect(events()[0].detail).toHaveLength(500);
  });

  it('keeps the WHOLE written line inside the atomic-append budget, not just its detail', () => {
    // What hits the disk is payload + envelope + ts, so capping `detail` alone is not the
    // guarantee — and an over-long line corrupts the CONCURRENT judge's row, not this one.
    process.env.DEVKIT_SHIP_BRANCH = `feat/${'b'.repeat(240)}`; // git allows ~255-char refnames
    emitAdvisoryResult('fallow-advisory', 'finding', 'y'.repeat(5000));
    const [line] = readFileSync(sink, 'utf8').split('\n').filter(Boolean);
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(4096);
  });
});

/**
 * Shapes the happy path does not model. All must degrade toward SAYING MORE: the advisory's purpose
 * is defeated by a silent path, never by a noisy one.
 */
describe('degraded and boundary inputs', () => {
  it('reports an EMPTY report file rather than reading it as clean', () => {
    // The real trigger: mktemp created the scratch file and fallow then died before writing it, so
    // the file exists and is zero bytes. Reading that as "nothing to report" would be the silence.
    expect(summariseFallowAudit('')).toBeNull();
    expect(reportFallowAudit(() => '', false)).toBe('unreadable');
    expect(events()[0]).toMatchObject({ status: 'could_not_run' });
  });

  it('counts only finite positive counters, whatever the payload puts in them', () => {
    const token = (attribution: string) =>
      summariseFallowAudit(`{"verdict":"pass","attribution":${attribution}}`)?.token;
    // A negative or zero counter introduced nothing; neither may be rendered as a finding.
    expect(token('{"complexity_introduced":0}')).toBe('clean');
    expect(token('{"complexity_introduced":-1}')).toBe('clean');
    // Infinity/NaN survive JSON only as these spellings, but a hand-fed report can carry them.
    expect(token('{"complexity_introduced":1e999}')).toBe('clean'); // Infinity — not finite
    expect(token('{"complexity_introduced":null}')).toBe('clean');
    // A real count still reads, at both ends of the range.
    expect(
      summariseFallowAudit('{"verdict":"pass","attribution":{"complexity_introduced":1}}')?.detail,
    ).toContain('1 complexity');
    expect(
      summariseFallowAudit(
        `{"verdict":"pass","attribution":{"complexity_introduced":${Number.MAX_SAFE_INTEGER}}}`,
      )?.detail,
    ).toContain(`${Number.MAX_SAFE_INTEGER} complexity`);
  });

  it('survives a report whose fields are not the types the schema declares', () => {
    // A fallow release could reshape any of these; none may throw in a hook. A verdict devkit
    // cannot interpret is an UNREADABLE report, never a finding rendered `verdict=[object Object]`.
    expect(summariseFallowAudit('{"verdict":{"code":"fail"}}')).toBeNull();
    expect(summariseFallowAudit('{"verdict":"renamed-in-a-future-fallow"}')).toBeNull();
    expect(summariseFallowAudit('{"verdict":0}')).toBeNull();
    expect(summariseFallowAudit('42')).toBeNull();
    // Attribution is different: a shape devkit cannot read there means zero counters, not an
    // unreadable report, because the verdict alone still answers "was this audit clean".
    expect(summariseFallowAudit('{"verdict":"pass","attribution":"none"}')?.token).toBe('clean');
    expect(summariseFallowAudit('{"verdict":"pass","attribution":[]}')?.token).toBe('clean');
    // A literal null is the one the parameter default cannot catch — defaults fire on undefined
    // only, so an unnormalised null reaches the counter reads and throws inside a commit hook.
    expect(summariseFallowAudit('{"verdict":"pass","attribution":null}')?.token).toBe('clean');
    expect(summariseFallowAudit('{"verdict":"fail","attribution":null}')?.detail).toBe(
      'verdict=fail — read the fallow section of the log',
    );
  });

  it('keeps printing the human report when telemetry is switched off', () => {
    // The row is best-effort; the PROSE is not. Suppressing the second fallow run because nothing
    // could be recorded would make DEVKIT_NO_TELEMETRY hide findings, not just stop measuring them.
    delete process.env.DEVKIT_GATE_EVENTS; // vitest.setup holds DEVKIT_NO_TELEMETRY=1 suite-wide
    expect(
      reportFallowAudit(
        () => '{"verdict":"fail","attribution":{"complexity_introduced":1}}',
        false,
      ),
    ).toBe('findings');
    expect(events()).toEqual([]);
  });
});

/** fallow 3.10.0 tags each complexity finding; the report itself carries no estimation flag. */
describe('estimated CRAP marker', () => {
  interface Finding {
    exceeded?: string;
    coverage_source?: string;
    introduced?: boolean;
  }
  const MEASURED = 'verdict=fail · 1 complexity introduced — read the fallow section of the log';
  const finding = (over: Finding = {}): Finding => ({
    exceeded: 'crap',
    coverage_source: 'estimated',
    introduced: true,
    ...over,
  });
  const findings = (...list: Finding[]) => JSON.stringify({ findings: list });
  const audit = (complexity: string, verdict = 'fail', introduced = 1) =>
    `{"verdict":"${verdict}","attribution":{"complexity_introduced":${introduced}},"complexity":${complexity}}`;
  const detail = (complexity: string) => summariseFallowAudit(audit(complexity))?.detail;

  it('names the devkit remedy when a CRAP-only finding was scored without coverage', () => {
    const estimated =
      'verdict=fail (CRAP estimated, no coverage: run `devkit coverage-run <their tests>` in this checkout, then re-ship) · 1 complexity introduced — read the fallow section of the log';
    expect(detail(findings(finding()))).toBe(estimated);
    expect(detail(findings(finding({ coverage_source: 'estimated_component_inherited' })))).toBe(
      estimated,
    );
  });

  it('leaves a measured audit byte-identical to the line it printed before', () => {
    expect(detail(findings(finding({ coverage_source: 'istanbul' })))).toBe(MEASURED);
  });

  it('marks a mixed audit when any introduced CRAP-only finding is estimated', () => {
    expect(detail(findings(finding({ coverage_source: 'istanbul' }), finding()))).toContain(
      'CRAP estimated',
    );
  });

  it('stays silent for an inherited finding and for breaches coverage cannot clear', () => {
    expect(detail(findings(finding({ introduced: false })))).toBe(MEASURED);
    for (const exceeded of ['cognitive_crap', 'cyclomatic_crap', 'all', 'cognitive'])
      expect(detail(findings(finding({ exceeded })))).toBe(MEASURED);
  });

  it('reads a malformed complexity block as no marker, never a throw', () => {
    for (const complexity of [
      'null',
      '"x"',
      '3',
      '[]',
      '{"findings":"x"}',
      '{"findings":[null,3,"y"]}',
    ])
      expect(detail(complexity)).toBe(MEASURED);
    expect(detail(findings(finding({ coverage_source: 'estimatedish' })))).toBe(MEASURED);
  });

  it('keeps a clean audit silent even beside an inherited estimated finding', () => {
    const text = audit(findings(finding({ introduced: false })), 'pass', 0);
    expect(summariseFallowAudit(text)?.token).toBe('clean');
    expect(reportFallowAudit(() => text, false)).toBe('clean');
    expect(events()).toEqual([]);
  });

  it('marks a finding from a gate=all audit, which publishes no `introduced` field', () => {
    // Probed on fallow 3.10.0: `--gate all` skips attribution, so every counter is 0 and each
    // finding omits `introduced` while still deciding the verdict.
    const { introduced: _, ...unattributed } = finding();
    const text = audit(findings(unattributed), 'fail', 0);
    expect(summariseFallowAudit(text)?.detail).toContain('CRAP estimated');
  });

  it('carries the marker into the advisory row the ship digest renders', () => {
    expect(reportFallowAudit(() => audit(findings(finding())), false, true)).toBe('findings');
    expect(events()[0].detail).toContain('devkit coverage-run');
  });
});

// Pins the fixture shapes above to the real binary: a field rename in a fallow upgrade fails here.
const hasFallow = spawnSync('fallow', ['--version'], { encoding: 'utf8' }).status === 0;
const FALLOW_ENV = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('FALLOW_')),
  ),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

describe.skipIf(!hasFallow)('estimated CRAP marker against the real fallow binary', () => {
  it('marks an untested CRAP-only function and drops the marker once coverage measures it', () => {
    const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'advisory-fallow-')));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: FALLOW_ENV });
    const file = path.join(repo, 'a.js');
    writeFileSync(path.join(repo, 'package.json'), '{"name":"x","version":"1.0.0","main":"a.js"}');
    writeFileSync(file, 'export const z = 1;\n');
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'base');
    // Seven paths keep cyclomatic and cognitive under fallow's limits, so only CRAP can breach.
    const cases = [1, 2, 3, 4, 5, 6].map((n) => `    case ${n}: return '${n}';`);
    const lines = [
      'export function g(a) {',
      '  switch (a) {',
      ...cases,
      "    default: return 'z';",
    ];
    writeFileSync(file, `${[...lines, '  }', '}'].join('\n')}\n`);
    git('add', 'a.js');
    const audit = (env: Record<string, string> = {}) =>
      spawnSync('fallow', ['audit', '--base', 'HEAD', '--no-cache', '--format', 'json'], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...FALLOW_ENV, ...env },
      }).stdout;

    expect(summariseFallowAudit(audit())?.detail).toContain('CRAP estimated');

    const statementMap = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [
        i,
        { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 30 } },
      ]),
    );
    const loc = { start: { line: 1, column: 0 }, end: { line: 11, column: 1 } };
    const fnMap = { 0: { name: 'g', decl: loc, loc, line: 1 } };
    const s = Object.fromEntries(Object.keys(statementMap).map((k) => [k, 3]));
    const map = {
      [file]: { path: file, statementMap, fnMap, branchMap: {}, s, f: { 0: 3 }, b: {} },
    };
    const coverage = path.join(repo, 'coverage-final.json');
    writeFileSync(coverage, JSON.stringify(map));
    expect(summariseFallowAudit(audit({ FALLOW_COVERAGE: coverage }))).toEqual({
      token: 'clean',
      detail: '',
    });
  });
});
