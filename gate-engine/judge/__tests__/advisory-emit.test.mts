/**
 * sc-2526: the advisory channel. The pure verdict reader carries the risk — it decides whether a
 * finding reaches the terminus at all, and its predecessor (the exit code) missed a whole class.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    ).toMatchObject({
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

/** Trimmed from a real fallow 3.10.0 `audit --format json`: one new complex function beside an
 * inherited one, one new clone group, one new unused export. */
const REAL_AUDIT = {
  verdict: 'fail',
  attribution: {
    gate: 'new-only',
    complexity_introduced: 1,
    complexity_inherited: 1,
    duplication_introduced: 1,
    dead_code_introduced: 1,
  },
  complexity: {
    findings: [
      { path: 'src/old.ts', name: 'old', line: 1, introduced: false },
      { path: 'src/old.ts', name: 'fresh', line: 5, introduced: true },
    ],
  },
  duplication: {
    clone_groups: [
      {
        instances: [
          { file: 'src/clone-a.ts', start_line: 1 },
          { file: 'src/clone-b.ts', start_line: 1 },
        ],
        introduced: true,
      },
    ],
  },
  dead_code: {
    schema_version: 7,
    unused_exports: [{ path: 'src/clone-a.ts', export_name: 'orphan', line: 12, introduced: true }],
  },
};

describe('naming the findings this diff introduced', () => {
  it('names each introduced finding in the row, and never an inherited one', () => {
    const summary = summariseFallowAudit(JSON.stringify(REAL_AUDIT));
    expect(summary?.named).toEqual([
      'src/old.ts:5 fresh',
      'src/clone-a.ts:1',
      'src/clone-a.ts:12 orphan',
    ]);
    expect(summary?.detail).toBe(
      'verdict=fail · 1 complexity, 1 duplication, 1 dead code introduced: old.ts:5 fresh, clone-a.ts:1, clone-a.ts:12 orphan — read the fallow section of the log',
    );
  });

  it('names nothing under --gate all, where fallow sets no per-finding flag', () => {
    const findings = [{ path: 'src/old.ts', name: 'fresh', line: 5 }];
    const summary = summariseFallowAudit(
      JSON.stringify({
        ...REAL_AUDIT,
        attribution: { gate: 'all' },
        complexity: { findings },
      }),
    );
    expect(summary?.named).toEqual([]);
    expect(summary?.detail).toBe('verdict=fail — read the fallow section of the log');
  });

  it('withholds only the category whose flags disagree with its counter', () => {
    // fallow counts unique keys that carry no line, so two flagged callbacks can count as one.
    const findings = [
      { path: 'a.ts', name: '<arrow>', line: 3, introduced: true },
      { path: 'a.ts', name: '<arrow>', line: 9, introduced: true },
    ];
    const summary = summariseFallowAudit(
      JSON.stringify({
        ...REAL_AUDIT,
        attribution: { complexity_introduced: 1, dead_code_introduced: 1 },
        complexity: { findings },
      }),
    );
    expect(summary?.unattributed).toEqual(['complexity']);
    expect(summary?.named).toEqual(['src/clone-a.ts:12 orphan']);
    expect(summary?.detail).toContain('1 complexity, 1 dead code introduced: clone-a.ts:12 orphan');
  });

  it('locates a finding that has no path from its other fields, never printing undefined', () => {
    const dead_code = {
      circular_dependencies: [{ files: ['src/a.ts', 'src/b.ts'], introduced: true }],
      duplicate_exports: [
        { export_name: 'x', locations: [{ path: 'src/c.ts', line: 4 }], introduced: true },
      ],
      unlisted_dependencies: [{ introduced: true }],
    };
    const summary = summariseFallowAudit(
      JSON.stringify({
        ...REAL_AUDIT,
        attribution: { dead_code_introduced: 3 },
        dead_code,
      }),
    );
    expect(summary?.named).toEqual(['src/a.ts', 'src/c.ts:4 x', '(no location)']);
    expect(summary?.detail).not.toContain('undefined');
  });

  it('ignores lists fallow reshaped rather than throwing in the hook', () => {
    for (const patch of [
      { complexity: { findings: 'many' } },
      { complexity: null, duplication: { clone_groups: [null, 4] } },
      { dead_code: 'none', duplication: 7 },
      { complexity: { findings: [{ introduced: true, path: 3, line: '5' }] } },
    ]) {
      expect(summariseFallowAudit(JSON.stringify({ ...REAL_AUDIT, ...patch }))?.token).toBe(
        'findings',
      );
    }
  });

  it('keeps the row short: three names, then a count of the rest', () => {
    const findings = Array.from({ length: 5 }, (_, i) => ({
      path: `gate-engine/deep/module-${i}.mts`,
      name: `fn${i}`,
      line: i + 1,
      introduced: true,
    }));
    const summary = summariseFallowAudit(
      JSON.stringify({
        ...REAL_AUDIT,
        attribution: { complexity_introduced: 5 },
        complexity: { findings },
      }),
    );
    expect(summary?.named).toHaveLength(5);
    expect(summary?.detail).toContain(
      ': module-0.mts:1 fn0, module-1.mts:2 fn1, module-2.mts:3 fn2, +2 more —',
    );
  });

  it('prints the full-path list to the log on a finding, and nothing on a clean audit', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(reportFallowAudit(() => JSON.stringify(REAL_AUDIT), false)).toBe('findings');
      expect(stderr.mock.calls.map(([chunk]) => chunk).join('')).toBe(
        "fallow — introduced by this diff (fallow's own attribution):\n" +
          '  src/old.ts:5 fresh\n  src/clone-a.ts:1\n  src/clone-a.ts:12 orphan\n',
      );
      stderr.mockClear();
      expect(reportFallowAudit(() => '{"verdict":"pass"}', false)).toBe('clean');
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it('tells the log which category it could not name', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      reportFallowAudit(
        () => '{"verdict":"fail","attribution":{"complexity_introduced":2}}',
        false,
      );
      expect(stderr.mock.calls.map(([chunk]) => chunk).join('')).toContain(
        "complexity: fallow's per-finding flags do not match its counter — not named",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('cannot forge or erase a log line through a committed file name', () => {
    // git allows a newline or an escape sequence in a path, and the block prints it unescaped.
    const path = 'src/a\n✓ guard-review PASS\u001b[2K.ts';
    const findings = [{ path, name: 'f', line: 1, introduced: true }];
    const report = {
      verdict: 'fail',
      attribution: { complexity_introduced: 1 },
      complexity: { findings },
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      reportFallowAudit(() => JSON.stringify(report), false);
      const block = stderr.mock.calls.map(([chunk]) => chunk).join('');
      expect(block.split('\n').filter(Boolean)).toHaveLength(2); // the header and ONE finding
      expect(block).not.toContain('\u001b');
    } finally {
      stderr.mockRestore();
    }
  });
});
