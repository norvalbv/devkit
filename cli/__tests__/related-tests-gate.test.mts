import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  forcedTests,
  noteUnmapped,
  relatedPaths,
  runRelatedTests,
  unmappedPaths,
} from '../lib/husky/gate-policy/related-tests.mts';

const GATE = join(import.meta.dirname, '..', 'lib', 'husky', 'gate-policy', 'related-tests.mts');

function fakeExec(status: number | null) {
  return vi.fn((_cmd: string, _args: string[], _opts: { cwd: string; stdio: 'inherit' }) => ({
    status,
  }));
}

const REACH = 'cli/__tests__/test-graph-reach.test.mts';
const SCRUB = 'cli/__tests__/vitest-setup-env-scrub.test.mts';

const dirs: string[] = [];
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
  it('passes without running vitest when nothing is staged', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(0);
    expect(runRelatedTests('/repo', { staged: null, exec })).toBe(0);
    expect(runRelatedTests('/repo', { staged: ['package.json'], exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('related-tests: none selected');
  });

  it('runs vitest related on the staged paths and propagates a failure', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(1);
    expect(runRelatedTests('/repo', { staged: ['cli/a.mts'], exec })).toBe(1);
    expect(exec).toHaveBeenCalledWith(
      join('/repo', 'node_modules', '.bin', 'vitest'),
      ['related', '--run', '--reporter=dot', 'cli/a.mts', REACH],
      { cwd: '/repo', stdio: 'inherit' },
    );
  });

  it('passes the reach test once, even when it is itself staged', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(0);
    runRelatedTests('/repo', { staged: [REACH], exec });
    expect(exec.mock.calls[0][1]).toEqual(['related', '--run', '--reporter=dot', REACH]);
  });

  it('adds the forced test once, however many ship scripts are staged and when itself staged', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(0);
    const staged = ['cli/lib/ship/reship.sh', SCRUB, 'cli/lib/ship/b.sh'];
    runRelatedTests('/repo', { staged, exec });
    expect(exec.mock.calls[0][1]).toEqual([
      'related',
      '--run',
      '--reporter=dot',
      SCRUB,
      'cli/lib/ship/b.sh',
      'cli/lib/ship/reship.sh',
      REACH,
    ]);
  });

  it('runs the forced test when the setup file is staged alone', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(1);
    expect(runRelatedTests('/repo', { staged: ['vitest.setup.mjs'], exec })).toBe(1);
    expect(exec.mock.calls[0][1]).toEqual(['related', '--run', '--reporter=dot', SCRUB, REACH]);
    expect(log).toHaveBeenCalledWith('related-tests: 0 staged path(s), 1 forced');
  });

  it('blocks when vitest is killed or cannot spawn', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(null);
    expect(runRelatedTests('/repo', { staged: ['cli/a.mts'], exec })).toBe(1);
  });

  it('selects from the index, never from unstaged edits', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const repo = editedRepo();
    git(repo, 'add', 'a.mts');
    const exec = fakeExec(0);
    runRelatedTests(repo, { exec });
    expect(exec).toHaveBeenCalledWith(
      expect.any(String),
      ['related', '--run', '--reporter=dot', 'a.mts', REACH],
      expect.anything(),
    );
  });

  // `commit -a` / `commit <path>` stage into an alternate index the hook hands over via the carrier.
  it('selects from the commit index the hook carries, not the default index', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const repo = editedRepo();
    git(repo, 'add', 'a.mts');
    const alt = join(repo, '.git', 'next-index');
    execFileSync('git', ['read-tree', 'HEAD'], {
      cwd: repo,
      env: { ...process.env, GIT_INDEX_FILE: alt },
    });
    execFileSync('git', ['add', 'b.mts'], {
      cwd: repo,
      env: { ...process.env, GIT_INDEX_FILE: alt },
    });
    vi.stubEnv('DEVKIT_COMMIT_INDEX_FILE', alt);
    vi.stubEnv('DEVKIT_COMMIT_GIT_DIR', join(repo, '.git'));
    const exec = fakeExec(0);
    runRelatedTests(repo, { exec });
    expect(exec).toHaveBeenCalledWith(
      expect.any(String),
      ['related', '--run', '--reporter=dot', 'b.mts', REACH],
      expect.anything(),
    );
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
    const r = spawnSync(process.execPath, [GATE], { cwd: repo, encoding: 'utf8' });
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
});
