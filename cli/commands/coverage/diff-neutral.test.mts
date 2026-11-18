/** `devkit coverage-diff` carries the scope "diff" gate's verdict on runtime-neutral edits too. */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupRepos,
  gate,
  git,
  measure,
  repo,
  write,
} from '../../../gate-engine/coverage/__tests__/_provenance-fixtures.mts';
import { snapshotSource } from '../../../gate-engine/coverage/provenance.mts';
import coverageDiff from './diff.mts';

beforeEach(() => {
  vi.stubEnv('DEVKIT_BASE_REF', '');
  vi.stubEnv('GUARD_COVERAGE_OK', '');
  vi.stubEnv('GUARD_NO_COVERAGE', '');
  vi.stubEnv('DEVKIT_RUN_MODE', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupRepos();
});

function run(cwd: string) {
  const lines: string[] = [];
  const capture = (...a: unknown[]) => {
    lines.push(a.join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  const code = coverageDiff([], cwd);
  vi.restoreAllMocks();
  return { code, out: lines.join('\n') };
}

/** An istanbul artifact: repo-relative path → statement start lines, every one hit. */
const cov = (root: string, files: Record<string, number[]>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(files).map(([rel, starts]) => [
        join(root, rel),
        {
          statementMap: Object.fromEntries(
            starts.map((l, i) => [String(i), { start: { line: l } }]),
          ),
          s: Object.fromEntries(starts.map((_, i) => [String(i), 1])),
          f: {},
          b: {},
        },
      ]),
    ),
  );

/** A diff-scope repo on a feature branch cut from origin/main. */
function featureRepo(): string {
  const { root } = repo('', { scope: 'diff', addedLines: 70 });
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'switch', '-q', '-c', 'feature');
  return root;
}

/** Gate on the staged tree, coverage-diff on the same working tree: their verdicts must agree. */
function both(root: string) {
  git(root, 'add', '-A');
  const g = gate(root);
  const d = run(root);
  expect(d.code).toBe(g.code);
  return { g, d };
}

const TYPES = '/**\n * One.\n * Two.\n * Three.\n */\nexport interface T {\n  a: string;\n}\n';

describe('devkit coverage-diff — runtime-neutral edits', () => {
  it('passes a JSDoc-only edit as adding no production lines', () => {
    const root = featureRepo();
    write(root, 'src/a.mts', '/** The answer. */\nexport const a = 1;\n');
    write(root, 'coverage/coverage-final.json', cov(root, { 'src/a.mts': [2] }));
    const { d } = both(root);
    expect(d.code).toBe(0);
    expect(d.out).toContain('would pass — no added lines in production source');
  });

  it('passes a types-only file whose JSDoc shrank after the run, and lists it nowhere as stale', () => {
    const root = featureRepo();
    write(root, 'src/a.mts', 'export const a = 1;\nexport const b = 2;\n');
    write(root, 'src/types.mts', TYPES);
    measure(root, snapshotSource(root), cov(root, { 'src/a.mts': [1, 2], 'src/types.mts': [] }));
    write(root, 'src/types.mts', TYPES.replace(' * Two.\n', ''));
    const { g, d } = both(root);
    expect(g.code).toBe(0);
    expect(d.out).toContain('would pass — 1/1 added executable lines covered');
    expect(d.out).not.toContain('Changed since the coverage run');
  });

  it('does not list an untracked types-only file as never measured', () => {
    const root = featureRepo();
    write(root, 'src/a.mts', 'export const a = 1;\nexport const b = 2;\n');
    git(root, 'add', 'src/a.mts');
    write(root, 'src/types.mts', TYPES);
    measure(root, snapshotSource(root), cov(root, { 'src/a.mts': [1, 2] }));
    const d = run(root);
    expect(d.code).toBe(0);
    expect(d.out).not.toContain('Not measured');
    expect(d.out).toContain('would pass — 1/1 added executable lines covered');
  });

  it('fails both when a runtime export lands in that file after the run', () => {
    const root = featureRepo();
    write(root, 'src/a.mts', 'export const a = 1;\nexport const b = 2;\n');
    write(root, 'src/types.mts', TYPES);
    measure(root, snapshotSource(root), cov(root, { 'src/a.mts': [1, 2], 'src/types.mts': [] }));
    write(root, 'src/types.mts', `${TYPES}export const x = 1;\n`);
    const { g, d } = both(root);
    expect(g.code).toBe(1);
    expect(d.out).toContain('would FAIL if this ships');
  });
});
