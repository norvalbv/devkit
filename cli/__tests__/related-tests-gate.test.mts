import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNHANDLED_REPORTER } from '../../gate-engine/coverage/failures.mts';
import type { UnhandledError } from '../../gate-engine/coverage/unhandled-reporter.mts';
import {
  GATE_REASON_ENV,
  readGateReason,
  reasonDetail,
  reasonReport,
} from '../../gate-engine/deterministic/reason.mts';
import { configExtraGates } from '../../gate-engine/deterministic/command-gates.mts';
import {
  forcedTests,
  listRelated,
  noteUnmapped,
  relatedPaths,
  relatedTestsReason,
  runRelatedTests,
  unmappedPaths,
} from '../lib/husky/gate-policy/related-tests.mts';

const GATE = join(import.meta.dirname, '..', 'lib', 'husky', 'gate-policy', 'related-tests.mts');

function fakeExec(code: number, interrupted = false) {
  return vi.fn(async (_bin: string, _args: string[], _cwd: string, _env: NodeJS.ProcessEnv) => ({
    code,
    interrupted,
  }));
}

// Drops the json-report flags the gate adds, so selection tests compare only what vitest runs.
const withoutReport = (args: string[]) =>
  args.filter((a) => !/^--(outputFile\.json=|reporter=(json$|\/))/.test(a));

const REACH = 'cli/__tests__/test-graph-reach.test.mts';
const SCRUB = 'cli/__tests__/vitest-setup-env-scrub.test.mts';

const dirs: string[] = [];
// A failing run writes its reason only where a test points it, never into an enclosing gate's file.
beforeEach(() => vi.stubEnv(GATE_REASON_ENV, ''));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

// A committed a.mts + b.mts, both then edited on disk, with nothing staged yet.
function editedRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'related-tests-')));
  dirs.push(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.mts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'b.mts'), 'export const b = 1;\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  writeFileSync(join(repo, 'a.mts'), 'export const a = 2;\n');
  writeFileSync(join(repo, 'b.mts'), 'export const b = 2;\n');
  return repo;
}

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

  it('names forced tests that exist, so a rename cannot silently select nothing', () => {
    const root = join(import.meta.dirname, '..', '..');
    const tests = forcedTests(['cli/lib/ship/reship.sh', 'vitest.setup.mjs']);
    expect(tests).not.toEqual([]);
    for (const test of tests) expect(existsSync(join(root, test)), test).toBe(true);
  });
});

describe('runRelatedTests', () => {
  it('passes without listing or running vitest when nothing is staged', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const list = vi.fn(async () => ['/repo/a.test.mts']);
    const exec = fakeExec(0);
    const none = { code: 0, interrupted: false };
    expect(await runRelatedTests('/repo', { staged: [], list, exec })).toEqual(none);
    expect(await runRelatedTests('/repo', { staged: ['package.json'], list, exec })).toEqual(none);
    expect(list).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('related-tests: none selected');
  });

  it('passes without spawning vitest when no test relates to the staged paths', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(0);
    const list = vi.fn(async () => []);
    expect(
      (await runRelatedTests('/repo', { staged: ['guard.config.json'], list, exec })).code,
    ).toBe(0);
    expect(list).toHaveBeenCalledWith('/repo', ['guard.config.json']);
    expect(exec).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('related-tests: no test relates to the 1 staged path(s)');
  });

  it('blocks without spawning vitest when the related set cannot be listed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = fakeExec(0);
    const list = vi.fn(async () => {
      throw new Error('Transform failed');
    });
    expect((await runRelatedTests('/repo', { staged: ['cli/a.mts'], list, exec })).code).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(
      '✗ related-tests could not list related tests: Transform failed',
    );
  });

  it('runs exactly the listed test files and propagates a failure', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(1);
    const list = vi.fn(async () => ['/repo/cli/a.test.mts']);
    expect((await runRelatedTests('/repo', { staged: ['cli/a.mts'], list, exec })).code).toBe(1);
    expect(exec).toHaveBeenCalledWith(
      join('/repo', 'node_modules', '.bin', 'vitest'),
      [
        'run',
        '--reporter=dot',
        '--silent=passed-only',
        '--reporter=json',
        expect.stringMatching(/^--outputFile\.json=.+results\.json$/),
        `--reporter=${UNHANDLED_REPORTER}`,
        '/repo/cli/a.test.mts',
        join('/repo', REACH),
      ],
      '/repo',
      expect.any(Object),
    );
  });

  it('passes the reach test once, even when it is itself staged', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(0);
    const list = vi.fn(async () => [join('/repo', REACH)]);
    await runRelatedTests('/repo', { staged: [REACH], list, exec });
    expect(withoutReport(exec.mock.calls[0][1])).toEqual(['run', '--reporter=dot', '--silent=passed-only', join('/repo', REACH)]);
  });

  it('adds the forced test once, however many ship scripts are staged and when itself staged', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(0);
    const staged = ['cli/lib/ship/reship.sh', SCRUB, 'cli/lib/ship/b.sh'];
    await runRelatedTests('/repo', {
      staged,
      list: vi.fn(async () => [join('/repo', SCRUB)]),
      exec,
    });
    expect(withoutReport(exec.mock.calls[0][1])).toEqual([
      'run',
      '--reporter=dot',
      '--silent=passed-only',
      join('/repo', SCRUB),
      join('/repo', REACH),
    ]);
  });

  it('runs the forced test when the setup file is staged alone', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(1);
    const list = vi.fn(async () => []);
    expect(
      (await runRelatedTests('/repo', { staged: ['vitest.setup.mjs'], list, exec })).code,
    ).toBe(1);
    expect(list).not.toHaveBeenCalled();
    expect(withoutReport(exec.mock.calls[0][1])).toEqual([
      'run',
      '--reporter=dot',
      '--silent=passed-only',
      join('/repo', SCRUB),
      join('/repo', REACH),
    ]);
    expect(log).toHaveBeenCalledWith(
      'related-tests: 2 test file(s) for 0 staged path(s), 1 forced',
    );
  });

  it('passes an interrupted run through, so the entrypoint can skip the unmapped note', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const list = vi.fn(async () => ['/repo/cli/a.test.mts']);
    const exec = fakeExec(143, true);
    expect(await runRelatedTests('/repo', { staged: ['cli/a.mts'], list, exec })).toEqual({
      code: 143,
      interrupted: true,
    });
  });

  it('blocks an interrupted run even when vitest exits 0', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const list = vi.fn(async () => ['/repo/cli/a.test.mts']);
    const exec = fakeExec(0, true);
    expect(await runRelatedTests('/repo', { staged: ['cli/a.mts'], list, exec })).toEqual({
      code: 1,
      interrupted: true,
    });
  });
});

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
  function logged(paths: string[], grep: (root: string, needles: string[]) => Hits): string[] {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    noteUnmapped('/repo', paths, grep);
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
    expect(logged(['cli/lib/ship/reship.sh'], grep)).toEqual([
      'related-tests: 1 staged path(s) have no import-graph tests — not run here, CI will:',
      '  cli/lib/ship/reship.sh ← reship.test.mts',
    ]);
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

describe('related-tests entrypoint', () => {
  // devkit never spawns a {staged} gate with nothing staged, so no paths means a dropped token.
  it('blocks when it is given no paths', () => {
    const r = spawnSync(process.execPath, [GATE], { cwd: tmpdir(), encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('related-tests got no paths');
  });

  // No vitest in the fixture repo, so the run blocks; the note still prints and the code is kept.
  it('names a staged script and its tests after the run, keeping the exit code', () => {
    const repo = editedRepo();
    mkdirSync(join(repo, 'scripts'));
    mkdirSync(join(repo, '__tests__'));
    writeFileSync(join(repo, '__tests__', 'foo.test.mts'), "spawn('scripts/foo.sh');\n");
    writeFileSync(
      join(repo, '__tests__', 'other.test.mts'),
      "read('a/check.sh'); spawn('refoo.sh'); read('a/x[1].sh');\n",
    );
    for (const dir of ['a', 'b', 'dist/scripts']) mkdirSync(join(repo, dir), { recursive: true });
    for (const f of ['a/check.sh', 'b/check.sh', 'a/x[1].sh', 'b/x[1].sh', 'dist/scripts/foo.sh'])
      writeFileSync(join(repo, f), '');
    git(repo, 'add', '__tests__', 'a', 'b', 'dist');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'tests');
    writeFileSync(join(repo, 'scripts', 'foo.sh'), 'echo hi\n');
    writeFileSync(join(repo, 'notes.md'), 'no test names this\n');
    writeFileSync(join(repo, 'a', 'check.sh'), 'echo edited\n');
    writeFileSync(join(repo, 'a', 'x[1].sh'), 'echo edited\n');
    git(repo, 'add', 'scripts/foo.sh', 'notes.md', 'a/check.sh', 'a/x[1].sh', 'a.mts');
    const staged = ['scripts/foo.sh', 'notes.md', 'a/check.sh', 'a/x[1].sh', 'a.mts'];
    const r = spawnSync(process.execPath, [GATE, ...staged], { cwd: repo, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      'related-tests: 1 staged path(s) have no import-graph tests — not run here, CI will:\n' +
        '  scripts/foo.sh ← foo.test.mts\n', // refoo.sh in other.test.mts is a different name
    );
    expect(r.stdout).not.toContain('notes.md');
    // a/check.sh shares its basename with b/check.sh, so a test naming check.sh is ambiguous.
    expect(r.stdout).not.toContain('check.sh');
    // `[1]` is literal in a name, never a glob class matching x1.sh.
    expect(r.stdout).not.toContain('x[1].sh');
  });

  // relatedPaths drops vitest.setup.mjs, so the note must read the raw staged set to see it.
  it('does not list a test the staged setup file forced as not run', () => {
    const repo = editedRepo();
    mkdirSync(join(repo, 'cli', '__tests__'), { recursive: true });
    mkdirSync(join(repo, 'cli', 'lib', 'ship', 'review'), { recursive: true });
    writeFileSync(join(repo, SCRUB), "read('cli/lib/ship/review/x.sh');\n");
    writeFileSync(join(repo, 'cli', 'lib', 'ship', 'review', 'x.sh'), 'echo hi\n');
    writeFileSync(join(repo, 'vitest.setup.mjs'), 'export {};\n');
    git(repo, 'add', '.');
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: repo,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    const r = spawnSync(process.execPath, [GATE, ...staged], { cwd: repo, encoding: 'utf8' });
    expect(r.stdout).toContain(', 1 forced');
    expect(r.stdout).not.toContain('not run here');
  });
});

// A git repo where only a.test.mts imports a.mts, and nothing imports data.json.
function graphRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'related-list-')));
  dirs.push(root);
  writeFileSync(join(root, 'a.mts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'data.json'), '{}\n');
  writeFileSync(
    join(root, 'a.test.mts'),
    "import { expect, it } from 'vitest';\nimport { a } from './a.mts';\nit('a', () => expect(a).toBe(1));\n",
  );
  git(root, 'init', '-q');
  return root;
}

function runGate(root: string, ...staged: string[]) {
  return spawnSync(process.execPath, [GATE, ...staged], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90_000,
  });
}

describe('listRelated', () => {
  it('resolves the import graph: a JSON no test imports selects nothing', async () => {
    const root = graphRepo();
    expect(await listRelated(root, ['data.json'])).toEqual([]);
    expect(await listRelated(root, ['a.mts'])).toEqual([join(root, 'a.test.mts')]);
  }, 60_000);

  // A test-only commit must still run the staged test, as `vitest related` did.
  it('selects a staged test file itself', async () => {
    const root = graphRepo();
    expect(await listRelated(root, ['a.test.mts'])).toEqual([join(root, 'a.test.mts')]);
  }, 60_000);
});

describe('related-tests gate process', () => {
  // The fixture has no node_modules/.bin/vitest, so any spawn would fail and block.
  it('passes a config-only commit without spawning vitest, and exits', () => {
    const root = graphRepo();
    git(root, 'add', 'data.json');
    const r = runGate(root, 'data.json');
    expect(r.stdout).toContain('related-tests: no test relates to the 1 staged path(s)');
    expect(r.status).toBe(0);
  }, 90_000);

  // A listed file vitest run does not select would print "No test files found" and exit 1.
  it('runs the listed test file through vitest run', () => {
    const root = graphRepo();
    symlinkSync(join(import.meta.dirname, '..', '..', 'node_modules'), join(root, 'node_modules'));
    git(root, 'add', 'a.mts');
    const r = runGate(root, 'a.mts');
    expect(r.stdout).toContain('related-tests: 2 test file(s) for 1 staged path(s)');
    // CI forces colour, so vitest's summary carries ANSI codes between its words.
    expect(stripVTControlCharacters(r.stdout)).toMatch(/Tests\s+1 passed/);
    expect(r.status).toBe(0);
  }, 90_000);
});

const failed = (file: string, ...names: string[]) => ({
  name: file,
  status: 'failed',
  assertionResults: names.map((fullName) => ({
    status: 'failed',
    fullName,
    failureMessages: ['x'],
  })),
});

// vitest writes its json report where --outputFile.json points; this stands in for that run.
const reportPath = (args: string[]) =>
  args.find((a) => a.startsWith('--outputFile.json='))?.slice('--outputFile.json='.length);

interface FakeReport {
  testResults: unknown[];
}

// unhandled.json stands in for what devkit's unhandled reporter writes beside the json report.
function reportingExec(status: number, report: FakeReport, unhandled?: UnhandledError[]) {
  return vi.fn(async (_cmd: string, args: string[], _cwd: string, _env: NodeJS.ProcessEnv) => {
    const out = reportPath(args);
    if (out) writeFileSync(out, JSON.stringify(report));
    if (out && unhandled)
      writeFileSync(join(dirname(out), 'unhandled.json'), JSON.stringify(unhandled));
    return { code: status, interrupted: false };
  });
}

function reasonFile(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'related-tests-reason-')));
  dirs.push(dir);
  const file = join(dir, 'reason.txt');
  vi.stubEnv(GATE_REASON_ENV, file);
  return file;
}

describe('relatedTestsReason', () => {
  const ran = { status: 1 };

  it('names up to five failing tests by file and title, then counts the rest', () => {
    const names = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
    const diagnosis = {
      failedFiles: ['/repo/cli/a.test.mts'],
      flaky: [],
      failures: {
        tests: names.map((name) => ({ file: '/repo/cli/a.test.mts', name })),
        allTimedOut: false,
        timeoutMs: null,
      },
    };
    expect(relatedTestsReason(ran, diagnosis, '/repo')).toEqual([
      '1 test file(s) failed:',
      ...names.slice(0, 5).map((n) => `cli/a.test.mts > ${n}`),
      '(2 more in the full log above)',
    ]);
  });

  it('names a file that failed to load with the first line of its error', () => {
    const diagnosis = {
      failedFiles: ['/repo/cli/b.test.mts'],
      flaky: [],
      failures: { tests: [], allTimedOut: false, timeoutMs: null },
      collection: [
        { file: '/repo/cli/b.test.mts', message: 'Error: Cannot find module x\n  at y' },
      ],
    };
    expect(relatedTestsReason(ran, diagnosis, '/repo')).toEqual([
      '1 test file(s) failed:',
      'cli/b.test.mts — failed to load: Error: Cannot find module x',
    ]);
  });

  it('names what ended a run in which no test failed', () => {
    const diagnosis = {
      failedFiles: [],
      flaky: [],
      unhandled: [
        { file: '/repo/cli/c.test.mts', message: 'TypeError: boom' },
        { file: null, message: 'Error: late' },
      ],
    };
    expect(relatedTestsReason(ran, diagnosis, '/repo')).toEqual([
      'No test failed; the run ended on:',
      'cli/c.test.mts: TypeError: boom',
      'Error: late',
    ]);
  });

  it('says there is no report rather than inventing a cause', () => {
    expect(relatedTestsReason(ran, null, '/repo')).toEqual([
      'vitest exited 1 without a test report — its output is in the full log above',
    ]);
  });

  it('says vitest could not run when it never started or was killed', () => {
    const error = new Error('spawn ENOENT');
    expect(relatedTestsReason({ status: null, error }, null, '/repo')).toEqual([
      'related-tests could not run vitest: spawn ENOENT',
    ]);
    expect(relatedTestsReason({ status: null }, null, '/repo')).toEqual([
      'related-tests could not run vitest: it was killed before exiting',
    ]);
  });
});

describe('runRelatedTests failure reason', () => {
  const list = async () => ['/repo/cli/a.test.mts'];

  it('records the failing test for the aggregated block and the digest, then removes its report', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = reasonFile();
    const exec = reportingExec(1, {
      testResults: [
        failed('/repo/cli/__tests__/x.test.mts', 'readCodexRateLimits > keeps the answer'),
      ],
    });
    expect((await runRelatedTests('/repo', { staged: ['cli/x.mts'], list, exec })).code).toBe(1);

    const reason = readGateReason(file);
    expect(reason).toEqual([
      '1 test file(s) failed:',
      'cli/__tests__/x.test.mts > readCodexRateLimits > keeps the answer',
    ]);
    expect(reasonReport([{ label: 'related-tests', reason }]).join('\n')).toContain(
      '     cli/__tests__/x.test.mts > readCodexRateLimits > keeps the answer',
    );
    expect(reasonDetail('related-tests', reason)).toBe(
      'related-tests: 1 test file(s) failed: · cli/__tests__/x.test.mts > readCodexRateLimits > keeps the answer',
    );
    const [, args, , env] = exec.mock.calls[0];
    expect(env[GATE_REASON_ENV]).toBeUndefined();
    const out = reportPath(args)!;
    expect(existsSync(dirname(out))).toBe(false);
  });

  it('keeps the count and the first test inside the digest detail cap', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = reasonFile();
    const long = 'x'.repeat(300);
    const exec = reportingExec(1, {
      testResults: [failed('/repo/cli/a.test.mts', `${long} 1`, `${long} 2`, `${long} 3`)],
    });
    await runRelatedTests('/repo', { staged: ['cli/a.mts'], list, exec });
    const detail = reasonDetail('related-tests', readGateReason(file));
    expect(Array.from(detail).length).toBeLessThanOrEqual(500);
    expect(detail).toContain(`1 test file(s) failed: · cli/a.test.mts > ${long} 1`);
  });

  // vitest exits 1 on an error thrown outside any test; "0 test file(s) failed" would hide it.
  it("names the unhandled error devkit's reporter wrote beside the report", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = reasonFile();
    const exec = reportingExec(1, { testResults: [] }, [
      { file: '/repo/cli/__tests__/y.test.mts', message: 'TypeError: late boom' },
    ]);
    expect((await runRelatedTests('/repo', { staged: ['cli/y.mts'], list, exec })).code).toBe(1);
    expect(readGateReason(file)).toEqual([
      'No test failed; the run ended on:',
      'cli/__tests__/y.test.mts: TypeError: late boom',
    ]);
  });

  it('records nothing when the related tests pass', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = reasonFile();
    expect(
      (
        await runRelatedTests('/repo', {
          staged: ['cli/a.mts'],
          list,
          exec: reportingExec(0, { testResults: [] }),
        })
      ).code,
    ).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('still runs, unnarrated, when no report directory can be made', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('TMPDIR', join(tmpdir(), 'related-tests-missing', 'nope'));
    const exec = fakeExec(0);
    expect((await runRelatedTests('/repo', { staged: ['cli/a.mts'], list, exec })).code).toBe(0);
    expect(withoutReport(exec.mock.calls[0][1])).toEqual(['run', '--reporter=dot', '--silent=passed-only', '/repo/cli/a.test.mts', join('/repo', REACH)]);
  });
});

describe('self-host registration', () => {
  it("devkit's guard.config.json declares related-tests afterGreen, so a cheap failure skips it", () => {
    const root = join(import.meta.dirname, '..', '..');
    expect(configExtraGates(root)).toContainEqual({
      label: 'related-tests',
      cmd: 'node cli/lib/husky/gate-policy/related-tests.mts {staged}',
      afterGreen: true,
    });
  });
});
