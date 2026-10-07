/** guard-coverage `scope: "diff"`: added-line coverage, fail-closed on unmeasured files and unknown
 * provenance; whole-repo mode refuses an artifact from a scoped `devkit coverage-run`. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isScopedRun, snapshotSource } from '../provenance.mts';
import {
  cleanupRepos,
  gate,
  git,
  measure,
  repo,
  stage,
  trackRoot,
  write,
} from './_provenance-fixtures.mts';

beforeEach(() => {
  vi.stubEnv('GUARD_COVERAGE_OK', '');
  vi.stubEnv('GUARD_NO_COVERAGE', '');
  vi.stubEnv('DEVKIT_RUN_MODE', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupRepos();
});

/** One artifact: repo-relative path → { line: hits }, keyed by `root` as istanbul writes it. */
function cov(root: string, files: Record<string, Record<number, number>>): string {
  const entry = (hits: Record<number, number>) => {
    const lines = Object.entries(hits);
    return {
      statementMap: Object.fromEntries(lines.map(([l], i) => [String(i), { start: { line: +l } }])),
      s: Object.fromEntries(lines.map(([, h], i) => [String(i), h])),
      f: {},
      b: {},
    };
  };
  return JSON.stringify(
    Object.fromEntries(Object.entries(files).map(([p, h]) => [`${root}/${p}`, entry(h)])),
  );
}

const A4 =
  'export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n';
const HALF = { 1: 1, 2: 1, 3: 1, 4: 0, 5: 0 };

/** a.mts gains lines 2-5, staged and measured with lines 4-5 uncovered: 2/4 added lines. */
function halfCovered(addedLines: number) {
  const { root } = repo('', { scope: 'diff', addedLines });
  write(root, 'src/a.mts', A4);
  stage(root);
  measure(root, undefined, cov(root, { 'src/a.mts': HALF }));
  return root;
}

describe('scope "diff": the added-line threshold', () => {
  it('passes exactly at addedLines', () => {
    const { code, out } = gate(halfCovered(50));
    expect(code).toBe(0);
    expect(out).toContain('2/4 added executable lines covered (50.0%, min 50%)');
  });

  it('fails just below it and names the uncovered added lines', () => {
    const { code, out } = gate(halfCovered(51));
    expect(code).toBe(1);
    expect(out).toContain('uncovered: 4-5');
    expect(out).toContain('GUARD_COVERAGE_OK=1');
  });

  it('reads paths per file, so a diff prefix config changes nothing', () => {
    const root = halfCovered(50);
    git(root, 'config', 'diff.mnemonicPrefix', 'true');
    git(root, 'config', 'diff.noprefix', 'true');
    expect(gate(root).code).toBe(0);
  });

  it('judges a renamed file only on the lines the move changed', () => {
    const { root } = repo('', { scope: 'diff', addedLines: 50 });
    write(root, 'src/old.mts', 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n');
    stage(root);
    git(root, 'commit', '-q', '-m', 'old');
    git(root, 'mv', 'src/old.mts', 'src/new.mts');
    write(root, 'src/new.mts', 'export const x = 1;\nexport const y = 22;\nexport const z = 3;\n');
    stage(root);
    measure(root, undefined, cov(root, { 'src/new.mts': { 1: 0, 2: 1, 3: 0 } }));
    const { code, out } = gate(root);
    expect(out).toContain('1/1 added executable lines');
    expect(code).toBe(0);
  });
});

describe('scope "diff": fail closed', () => {
  it('a new source file absent from the artifact blocks as not measured', () => {
    const { root } = repo('', { scope: 'diff', addedLines: 0 });
    write(root, 'src/b.mts', 'export const b = 2;\n');
    stage(root);
    measure(root, undefined, cov(root, { 'src/a.mts': { 1: 1 } }));
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain('Not measured');
    expect(out).toContain('src/b.mts');
  });

  it('an entry without istanbul maps is corrupt data; empty maps are a file with no statements', () => {
    const { root } = repo('', { scope: 'diff', addedLines: 100 });
    write(root, 'src/a.mts', A4);
    stage(root);
    measure(root, undefined, JSON.stringify({ [`${root}/src/a.mts`]: {} }));
    expect(gate(root).out).toContain('not valid coverage data');
    measure(
      root,
      undefined,
      JSON.stringify({ [`${root}/src/a.mts`]: { statementMap: {}, s: {} } }),
    );
    expect(gate(root).code).toBe(0);
  });

  it('an artifact with no manifest blocks: its line numbers describe an unknown tree', () => {
    const { root } = repo('', { scope: 'diff', addedLines: 0 });
    write(root, 'src/a.mts', A4);
    stage(root);
    write(root, 'coverage/coverage-final.json', cov(root, { 'src/a.mts': HALF }));
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain('provenance unknown');
  });

  it('a source edit after the run blocks and names the scoped re-run', () => {
    const root = halfCovered(0);
    write(root, 'src/a.mts', `${A4}export const f = 6;\n`);
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain('predates');
    expect(out).toContain('devkit coverage-run <test files>');
  });

  it('added production lines with no artifact block, naming the files and the scoped run', () => {
    const { root } = repo('', { scope: 'diff', addedLines: 0 });
    write(root, 'src/a.mts', A4);
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain('src/a.mts');
    expect(out).toContain('devkit coverage-run <test files');
    expect(out).toContain('GUARD_COVERAGE_OK=1');
  });

  it('an artifact that measured no files blocks', () => {
    const { root } = repo('', { scope: 'diff', addedLines: 0 });
    write(root, 'src/a.mts', A4);
    stage(root);
    measure(root, undefined, '{}');
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain('measured no files');
  });

  it('review mode reports a stale artifact as NOT MEASURED, never as a block', () => {
    const root = halfCovered(0);
    write(root, 'src/a.mts', `${A4}export const f = 6;\n`);
    stage(root);
    vi.stubEnv('DEVKIT_RUN_MODE', 'review');
    const { code, out } = gate(root);
    expect(code).toBe(2);
    expect(out).not.toContain('FAILED');
  });

  it('review mode reports absent and unknown artifacts as NOT MEASURED (exit 2)', () => {
    vi.stubEnv('DEVKIT_RUN_MODE', 'review');
    const { root } = repo('', { scope: 'diff', addedLines: 0 });
    write(root, 'src/a.mts', A4);
    stage(root);
    expect(gate(root).code).toBe(2);
    write(root, 'coverage/coverage-final.json', cov(root, { 'src/a.mts': HALF }));
    expect(gate(root).code).toBe(2);
  });

  it.each([
    [{ scope: 'diff' }, 'addedLines'],
    [{ scope: 'diff', addedLines: '80' }, 'addedLines'],
    [{ scope: 'diff', addedLines: 101 }, 'addedLines'],
    [{ scope: 'dif', addedLines: 80 }, 'coverage.scope'],
  ])('config %j is an error naming %s, never a pass', (coverage, key) => {
    // SAFETY: deliberately malformed configs; the gate must reject what the type forbids.
    const { root } = repo('', coverage as never);
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain(key);
  });
});

describe('scope "diff": what needs no artifact, and where the artifact comes from', () => {
  it('a tests-and-docs-only change passes with no coverage run at all', () => {
    const { root } = repo('', { scope: 'diff', addedLines: 90 });
    write(root, 'src/a.test.mts', 'test("a", () => {});\ntest("b", () => {});\n');
    write(root, 'README.md', '# r\n\nmore\n');
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(0);
    expect(out).toContain('no artifact needed');
    expect(existsSync(join(root, 'coverage'))).toBe(false);
  });

  it('a change that only deletes production lines needs no artifact', () => {
    const { root } = repo('', { scope: 'diff', addedLines: 90 });
    write(root, 'src/a.mts', A4);
    stage(root);
    git(root, 'commit', '-q', '-m', 'four');
    write(root, 'src/a.mts', 'export const a = 1;\n');
    stage(root);
    expect(gate(root).out).toContain('no artifact needed');
  });

  it('a test file edited after the run warns and still passes', () => {
    const root = halfCovered(50);
    write(root, 'src/a.test.mts', 'test("a", () => {});\ntest("late", () => {});\n');
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(0);
    expect(out).toContain('predates 1 briefed test file');
  });

  it('a package gate judges its own subtree and ignores staged source outside it', () => {
    const { root, cwd } = repo('pkg', { scope: 'diff', addedLines: 50 });
    write(root, 'pkg/src/a.mts', A4);
    write(root, 'other/src/z.mts', 'export const z = 1;\n');
    stage(root);
    measure(cwd, undefined, cov(root, { 'pkg/src/a.mts': HALF }));
    const { code, out } = gate(cwd);
    expect(out).toContain('2/4 added executable lines');
    expect(code).toBe(0);
  });

  it("judges only the commit's own index on a pathspec commit", () => {
    const { root } = repo('', { scope: 'diff', addedLines: 50 });
    write(root, 'src/a.mts', A4);
    write(root, 'src/b.mts', 'export const b = 2;\n');
    stage(root);
    measure(root, undefined, cov(root, { 'src/a.mts': HALF }));
    const index = join(trackRoot(mkdtempSync(join(tmpdir(), 'coverage-diff-index-'))), 'index');
    const env = { ...process.env, GIT_INDEX_FILE: index };
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: root, env });
    execFileSync('git', ['add', 'src/a.mts'], { cwd: root, env });
    vi.stubEnv('GIT_INDEX_FILE', index);
    expect(gate(root).code).toBe(0);
  });

  it('a ship-style worktree reads the linked artifact through the manifest roots', () => {
    const root = halfCovered(50);
    const wt = join(trackRoot(mkdtempSync(join(tmpdir(), 'coverage-diff-ship-'))), 'ship wt');
    git(root, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    symlinkSync(join(root, 'coverage'), join(wt, 'coverage'));
    write(wt, 'src/a.mts', A4);
    stage(wt);
    const { code, out } = gate(wt);
    expect(out).toContain('2/4 added executable lines');
    expect(code).toBe(0);
  });
});

describe('whole-repo mode refuses a scoped artifact', () => {
  const scopedRepo = (args: string[]) => {
    const { root } = repo();
    measure(root, snapshotSource(root, args), cov(root, { 'src/a.mts': { 1: 1 } }));
    return root;
  };

  it('blocks a run that named test files, and review reports it NOT MEASURED', () => {
    const root = scopedRepo(['src/a.test.mts']);
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain('scoped run');
    vi.stubEnv('DEVKIT_RUN_MODE', 'review');
    expect(gate(root).code).toBe(2);
  });

  it('passes a run whose args only tune the runner', () => {
    expect(gate(scopedRepo(['--reporter', 'json', '--maxWorkers', '4'])).code).toBe(0);
  });

  it('passes an older manifest written before args were recorded', () => {
    const root = scopedRepo([]);
    const manifest = join(root, 'coverage', 'coverage-manifest.json');
    const { args: _args, ...older } = JSON.parse(readFileSync(manifest, 'utf8'));
    writeFileSync(manifest, JSON.stringify(older));
    expect(gate(root).code).toBe(0);
  });
});

describe('isScopedRun', () => {
  it.each([
    [['src/a.test.ts']],
    [['-t', 'x']],
    [['--project=unit']],
    [['--shard', '1/2']],
    [['--silent', 'src/a.test.ts']],
    [['--unknownFlag', 'src/a.test.ts']],
  ])('%j is scoped', (args) => expect(isScopedRun(args)).toBe(true));
  it.each([
    [[]],
    [['--reporter', 'json']],
    [['--maxWorkers', '4']],
    [['--retry=2', '--silent']],
    [['--silent', 'passed-only']],
    [['--coverage.include', 'src/**']],
    [['--browser', 'chromium', '--sequence.seed', '7']],
  ])('%j is not', (args) => expect(isScopedRun(args)).toBe(false));
});
