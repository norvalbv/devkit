import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GATE_REASON_ENV } from '../../gate-engine/deterministic/reason.mts';
import { runRelatedTests } from '../lib/husky/gate-policy/related-tests.mts';
import {
  forcedTests,
  noteUnmapped,
  previousSelection,
  recordSelection,
  relatedDrivers,
  relatedPaths,
  selectionLines,
  triggerLine,
  unmappedPaths,
} from '../lib/husky/gate-policy/related-tests-selection.mts';

const dirs: string[] = [];
beforeEach(() => vi.stubEnv(GATE_REASON_ENV, ''));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** A sink with the ship identity a gate run inside `devkit ship` has. */
function inShip(repo = 'devkit', branch = 'feature'): string {
  const sink = join(tempDir('related-selection-sink-'), 'events.jsonl');
  vi.stubEnv('DEVKIT_GATE_EVENTS', sink);
  vi.stubEnv('DEVKIT_SHIP_ID', 'ship-1');
  vi.stubEnv('DEVKIT_SHIP_REPO', repo);
  vi.stubEnv('DEVKIT_SHIP_BRANCH', branch);
  return sink;
}

const row = (
  files: number,
  slowest: { file: string; ms: number }[],
  over: { repo?: string; branch?: string } = {},
) =>
  JSON.stringify({
    type: 'related_tests_selection',
    repo: 'devkit',
    branch: 'feature',
    files,
    slowest,
    ...over,
  });

describe('relatedPaths', () => {
  it('drops the full-suite triggers and sorts the rest', () => {
    expect(
      relatedPaths([
        'src/b.mts',
        'package.json',
        'vitest.config.mjs',
        'src/a.mts',
        'vitest.setup.mjs',
      ]),
    ).toEqual(['src/a.mts', 'src/b.mts']);
  });

  // vitest's triggers are `**/package.json` and `**/{vitest,vite}.config.*`; every release stages dist/package.json.
  it('drops nested trigger files too, keeping look-alikes', () => {
    expect(
      relatedPaths([
        'dist/package.json',
        'templates/app/vite.config.ts',
        'vitest.e2e.config.mjs',
        'cli/package-json.mts',
      ]),
    ).toEqual(['cli/package-json.mts', 'vitest.e2e.config.mjs']);
  });
});

describe('triggerLine', () => {
  it('is undefined when no full-suite trigger is staged', () => {
    expect(triggerLine(['cli/a.mts', 'cli/package-json.mts', 'vitest.e2e.config.mjs'])).toBe(
      undefined,
    );
  });

  it('names every staged trigger, sorted, nested ones included', () => {
    expect(
      triggerLine(['vitest.setup.mjs', 'cli/a.mts', 'dist/package.json', 'package.json']),
    ).toBe(
      "related-tests: 3 staged full-suite trigger(s), so CI runs vitest's whole suite: dist/package.json, package.json, vitest.setup.mjs",
    );
  });

  // A benchmark data commit can stage dozens of package.json files at once.
  it('names the first three and counts the rest', () => {
    const staged = [
      'e/package.json',
      'd/package.json',
      'c/package.json',
      'b/package.json',
      'a/package.json',
    ];
    expect(triggerLine(staged)).toBe(
      "related-tests: 5 staged full-suite trigger(s), so CI runs vitest's whole suite: a/package.json, b/package.json, c/package.json (+2)",
    );
  });
});

describe('selectionLines', () => {
  const root = '/repo';
  const files = ['/repo/a.test.mts', '/repo/b.test.mts', '/repo/c.test.mts'];

  it('names the paths that select most, the change since the previous attempt, and its slowest files', () => {
    const drivers: [string, number][] = [
      ['hub.mts', 170],
      ['b.mts', 12],
      ['c.mts', 3],
      ['d.mts', 1],
    ];
    const previous = {
      type: 'related_tests_selection' as const,
      repo: 'devkit',
      branch: 'feature',
      files: 27,
      slowest: [
        { file: 'gone.test.mts', ms: 900_000 },
        { file: 'b.test.mts', ms: 214_400 },
        { file: 'a.test.mts', ms: 60_000 },
      ],
    };
    expect(selectionLines(files, root, drivers, previous)).toEqual([
      'related-tests: most selected by hub.mts (170), b.mts (12), c.mts (3)',
      'related-tests: 27 test file(s) on the previous attempt of this branch',
      'related-tests: slowest of these on the previous attempt: b.test.mts 214s, a.test.mts 60s',
    ]);
  });

  it('adds nothing without drivers or a previous attempt, and no count line when the size held', () => {
    expect(selectionLines(files, root, [], undefined)).toEqual([]);
    const same = {
      type: 'related_tests_selection' as const,
      repo: 'r',
      branch: 'b',
      files: 3,
      slowest: [],
    };
    expect(selectionLines(files, root, [], same)).toEqual([]);
  });
});

describe('previousSelection', () => {
  it("reads this repo and branch's newest row and skips others and malformed lines", () => {
    const sink = inShip();
    writeFileSync(
      sink,
      [
        row(10, []),
        row(99, [], { branch: 'other' }),
        '{not json',
        row(27, [{ file: 'a.test.mts', ms: 5 }]),
        row(50, [], { repo: 'frink' }),
      ].join('\n') + '\n',
    );
    expect(previousSelection()?.files).toBe(27);
  });

  it('reads nothing outside a ship', () => {
    expect(previousSelection({})).toBeUndefined();
  });
});

describe('recordSelection', () => {
  const report = (results: unknown[]) => {
    const file = join(tempDir('related-selection-report-'), 'results.json');
    writeFileSync(file, JSON.stringify({ testResults: results }));
    return file;
  };
  const timed = (name: string, ms: number) => ({ name, startTime: 1000, endTime: 1000 + ms });

  it('records the selection size and its slowest files, slowest first, only inside a ship', () => {
    const results = [timed('/repo/a.test.mts', 5), timed('/repo/b.test.mts', 900), { name: 'x' }];
    recordSelection(report(results), '/repo', 2);
    const sink = inShip();
    recordSelection(report(results), '/repo', 2);
    const rows = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows).toEqual([
      expect.objectContaining({
        type: 'related_tests_selection',
        files: 2,
        slowest: [
          { file: 'b.test.mts', ms: 900 },
          { file: 'a.test.mts', ms: 5 },
        ],
        repo: 'devkit',
        branch: 'feature',
      }),
    ]);
  });

  it('records nothing for an unreadable report', () => {
    const sink = inShip();
    recordSelection(join(tempDir('related-selection-none-'), 'missing.json'), '/repo', 2);
    expect(existsSync(sink)).toBe(false);
  });
});

describe('relatedDrivers', () => {
  function graphRoot(): string {
    const root = tempDir('related-drivers-');
    writeFileSync(join(root, 'hub.mts'), 'export const hub = 1;\n');
    writeFileSync(join(root, 'leaf.mts'), 'export const leaf = 1;\n');
    const test = (name: string, from: string) =>
      writeFileSync(
        join(root, name),
        `import { expect, it } from 'vitest';\nimport * as m from './${from}';\nit('x', () => expect(m).toBeTruthy());\n`,
      );
    test('one.test.mts', 'hub.mts');
    test('two.test.mts', 'hub.mts');
    test('three.test.mts', 'leaf.mts');
    execFileSync('git', ['init', '-q'], { cwd: root });
    return root;
  }

  it('counts the test files each briefed path selects, from one vitest context', async () => {
    const root = graphRoot();
    expect(await relatedDrivers(root, ['leaf.mts', 'hub.mts'], 20)).toEqual([
      ['hub.mts', 2],
      ['leaf.mts', 1],
    ]);
  }, 60_000);

  it('skips the walk for one path or a small selection', async () => {
    expect(await relatedDrivers('/nowhere', ['a.mts'], 500)).toEqual([]);
    expect(await relatedDrivers('/nowhere', ['a.mts', 'b.mts'], 19)).toEqual([]);
  });
});

describe('runRelatedTests selection lines', () => {
  it('prints the drivers and the previous attempt before vitest starts, then records this run', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(line));
    const sink = inShip();
    writeFileSync(sink, `${row(27, [{ file: 'a.test.mts', ms: 214_000 }])}\n`);
    const root = tempDir('related-selection-run-');
    let printedBeforeRun = 0;
    const exec = vi.fn(async (_bin: string, args: string[]) => {
      printedBeforeRun = logs.length;
      const out = args.find((a) => a.startsWith('--outputFile.json='))?.split('=')[1];
      if (out)
        writeFileSync(
          out,
          JSON.stringify({
            testResults: [{ name: join(root, 'a.test.mts'), startTime: 0, endTime: 7 }],
          }),
        );
      return { code: 0, interrupted: false };
    });
    await runRelatedTests(root, {
      staged: ['a.mts', 'hub.mts'],
      list: async () => [join(root, 'a.test.mts')],
      drivers: async () => [['hub.mts', 1]],
      exec,
    });

    expect(logs.slice(0, printedBeforeRun)).toEqual([
      'related-tests: 2 test file(s) for 2 staged path(s)',
      'related-tests: most selected by hub.mts (1)',
      'related-tests: 27 test file(s) on the previous attempt of this branch',
      'related-tests: slowest of these on the previous attempt: a.test.mts 214s',
    ]);
    const rows = readFileSync(sink, 'utf8').trim().split('\n');
    expect(JSON.parse(rows.at(-1) ?? '')).toMatchObject({
      files: 2,
      slowest: [{ file: 'a.test.mts', ms: 7 }],
    });
  });
});

const SCRUB = 'cli/__tests__/vitest-setup-env-scrub.test.mts';
const PARITY = 'cli/__tests__/agent-asset-projection-parity.test.mts';

describe('forcedTests', () => {
  it('forces the env-scrub test for a top-level ship script or the setup file it binds', () => {
    expect(forcedTests(['cli/a.mts', 'cli/lib/ship/reship.sh'])).toEqual([SCRUB]);
    expect(forcedTests(['vitest.setup.mjs'])).toEqual([SCRUB]);
  });

  // The scrub test also reads both configs to pin that they share the setup file.
  it('forces the env-scrub test for either vitest config it reads', () => {
    expect(forcedTests(['vitest.config.mjs'])).toEqual([SCRUB]);
    expect(forcedTests(['vitest.e2e.config.mjs'])).toEqual([SCRUB]);
    expect(forcedTests(['templates/app/vitest.config.mjs'])).toEqual([]);
  });

  // The scrub test scans cli/lib/ship at the top level only, so a deeper script is not its input.
  it('forces nothing for a nested or mirrored script, or a module', () => {
    expect(
      forcedTests(['cli/lib/ship/review/x.sh', 'dist/cli/lib/ship/reship.sh', 'cli/a.mts']),
    ).toEqual([]);
  });

  // The parity test reads hook sources, projections and the selection from disk.
  it('forces the agent-asset parity test for a hook source, projection or the selection', () => {
    expect(forcedTests(['agents-hooks/prior-art-gate.mjs'])).toEqual([PARITY]);
    expect(forcedTests(['.codex/hooks/knip-check.sh'])).toEqual([PARITY]);
    expect(forcedTests(['.devkit/config.json'])).toEqual([PARITY]);
    expect(forcedTests(['dist/agents-hooks/x.mjs', '.claude/hooks.json'])).toEqual([]);
    expect(forcedTests(['vitest.setup.mjs', '.claude/hooks/x.mjs'])).toEqual([SCRUB, PARITY]);
  });

  // No other commit gate checks agent projections; skill projections have their own gate.
  it('forces the parity test for an agent source, projection or manifest, not for skills', () => {
    expect(forcedTests(['agents/correctness-reviewer.md'])).toEqual([PARITY]);
    expect(forcedTests(['.cursor/agents/correctness-reviewer.md'])).toEqual([PARITY]);
    expect(forcedTests(['.devkit/agents-manifest.json'])).toEqual([PARITY]);
    expect(forcedTests(['.devkit/agent-hooks-manifest.json'])).toEqual([PARITY]);
    expect(forcedTests(['.devkit/skills-manifest.json'])).toEqual([]);
    expect(
      forcedTests(['dist/agents/x.md', 'skills/a/SKILL.md', '.claude/skills/a/SKILL.md']),
    ).toEqual([]);
  });

  it('names forced tests that exist, so a rename cannot silently select nothing', () => {
    const root = join(import.meta.dirname, '..', '..');
    const tests = forcedTests(['cli/lib/ship/reship.sh', 'agents-hooks/prior-art-gate.mjs']);
    expect(tests).toEqual([SCRUB, PARITY]);
    for (const test of tests) expect(existsSync(join(root, test)), test).toBe(true);
  });
});

const REACH = 'cli/__tests__/test-graph-reach.test.mts';

describe('unmappedPaths', () => {
  it('keeps the paths vite cannot hold in its module graph', () => {
    expect(
      unmappedPaths([
        'cli/lib/ship/reship.sh',
        'docs/x.md',
        'templates/x.hbs',
        'cli/a.mts',
        'src/b.ts',
        'dist/c.mjs',
        'src/d.tsx',
        'fixtures/e.json',
      ]),
    ).toEqual(['cli/lib/ship/reship.sh', 'docs/x.md', 'templates/x.hbs']);
  });
});

describe('noteUnmapped', () => {
  type Hits = ReadonlyMap<string, Iterable<string>>;
  function logged(
    paths: string[],
    grep: (root: string, needles: string[]) => Hits,
    ran: string[] = [],
  ): string[] {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    noteUnmapped('/repo', paths, ran, grep);
    return log.mock.calls.map((c) => String(c[0]));
  }

  it('names each unmapped path with the tests that mention it, capped at three', () => {
    const tests = ['a/w.test.mts', 'x.test.mts', 'reship-anchor.test.mts', 'b/reship.test.mts'];
    const grep = vi.fn(
      (_root: string, _needles: string[]): Hits => new Map([['reship.sh', tests]]),
    );
    expect(logged(['cli/a.mts', 'cli/lib/ship/reship.sh', 'docs/x.md'], grep)).toEqual([
      'related-tests: 1 staged path(s) have no import-graph tests — not run here, CI will:',
      '  cli/lib/ship/reship.sh ← reship.test.mts, reship-anchor.test.mts, w.test.mts (+1)',
    ]);
  });

  it('does not report a forced test as not run', () => {
    const grep = vi.fn(
      (_root: string, _needles: string[]): Hits =>
        new Map([['reship.sh', [SCRUB, 'cli/__tests__/reship.test.mts']]]),
    );
    expect(logged(['cli/lib/ship/reship.sh'], grep, [SCRUB, REACH])).toEqual([
      'related-tests: 1 staged path(s) have no import-graph tests — not run here, CI will:',
      '  cli/lib/ship/reship.sh ← reship.test.mts',
    ]);
  });

  // A doc test selected through its glob edge ran, so only the tests naming it that did not stay.
  it('does not report a graph-selected doc test as not run', () => {
    const doc = 'cli/__tests__/root-routing-doc.test.mts';
    const other = 'gate-engine/judge/__tests__/codex-home.test.mts';
    const grep = vi.fn(
      (_root: string, _needles: string[]): Hits => new Map([['AGENTS.md', [doc, other]]]),
    );
    expect(logged(['AGENTS.md'], grep, [doc, REACH])).toEqual([
      'related-tests: 1 staged path(s) have no import-graph tests — not run here, CI will:',
      '  AGENTS.md ← codex-home.test.mts',
    ]);
  });

  it('prints nothing when every test naming the path ran', () => {
    const doc = 'cli/__tests__/root-routing-doc.test.mts';
    const grep = vi.fn(
      (_root: string, _needles: string[]): Hits => new Map([['AGENTS.md', [doc]]]),
    );
    expect(logged(['AGENTS.md'], grep, [doc, REACH])).toEqual([]);
  });

  // A nested script forces nothing, so a test naming it really was not run and stays listed.
  it('still lists the scrub test for a staged path that did not force it', () => {
    const grep = vi.fn((_root: string, _needles: string[]): Hits => new Map([['x.sh', [SCRUB]]]));
    expect(logged(['cli/lib/ship/review/x.sh'], grep)).toEqual([
      'related-tests: 1 staged path(s) have no import-graph tests — not run here, CI will:',
      '  cli/lib/ship/review/x.sh ← vitest-setup-env-scrub.test.mts',
    ]);
  });

  // One git lookup per run, however many paths: a docs commit stages dozens.
  it('looks every unmapped basename up in one batch, once each', () => {
    const grep = vi.fn((_root: string, _needles: string[]): Hits => new Map());
    logged(['cli/lib/ship/reship.sh', 'dist/cli/lib/ship/reship.sh', 'docs/x.md'], grep);
    expect(grep.mock.calls).toEqual([['/repo', ['reship.sh', 'x.md']]]);
  });

  it('prints nothing for module paths or for paths no test names', () => {
    const grep = vi.fn((_root: string, _needles: string[]): Hits => new Map());
    expect(logged(['cli/a.mts', 'src/b.json'], grep)).toEqual([]);
    expect(grep).not.toHaveBeenCalled();
    expect(logged(['docs/x.md'], grep)).toEqual([]);
  });

  it('stays silent when the lookup fails', () => {
    const grep = (): Hits => {
      throw new Error('git grep failed');
    };
    expect(logged(['cli/lib/ship/reship.sh'], grep)).toEqual([]);
  });
});
