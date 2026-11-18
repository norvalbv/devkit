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
  previousSelection,
  recordSelection,
  relatedDrivers,
  selectionLines,
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
