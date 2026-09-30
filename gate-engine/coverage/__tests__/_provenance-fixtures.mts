/** Real-git fixtures shared by the provenance and review coverage suites. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { publishCoverage } from '../produce.mts';
import { snapshotSource } from '../provenance.mts';
import { runCoverage } from '../run.mts';

let roots: string[] = [];
let runSeq = 0;

/** Remove every repo made since the last call; call from afterEach. */
export function cleanupRepos(): void {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
}

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export const write = (root: string, rel: string, body: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), body);
};

export const COV = JSON.stringify({
  '/x/a.mts': { statementMap: { '0': { start: { line: 1 } } }, s: { '0': 1 }, f: {}, b: {} },
});

/** A committed repo: one source file, its test, a README, and a coverage-selecting config. */
/** The guard.config.json `coverage` thresholds a fixture repo enforces. */
export type Thresholds = Partial<Record<'statements' | 'functions' | 'branches' | 'lines', number>>;

export function repo(pkg = '', coverage: Thresholds = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coverage-provenance-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  const at = (rel: string) => (pkg ? `${pkg}/${rel}` : rel);
  write(root, '.gitignore', 'coverage/\n');
  write(root, at('guard.config.json'), JSON.stringify({ sourceExtensions: ['mts'], coverage }));
  write(root, at('src/a.mts'), 'export const a = 1;\n');
  write(root, at('src/a.test.mts'), 'test("a", () => {});\n');
  write(root, at('README.md'), '# r\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return { root, cwd: pkg ? join(root, pkg) : root };
}

/** Track a scratch directory made outside repo() (e.g. a worktree) for cleanupRepos. */
export function trackRoot(root: string): string {
  roots.push(root);
  return root;
}

/** Simulate `devkit coverage-run`: snapshot the tree, then publish a report with its manifest. */
export function measure(cwd: string, snapshot = snapshotSource(cwd), cov = COV): void {
  const runDir = join(cwd, 'coverage', '.runs', `run-${++runSeq}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'coverage-final.json'), cov);
  expect(publishCoverage(runDir, cwd, null, [], snapshot)).toBe('published');
}

/** Stage everything, as the committer would before the hook runs. */
export function stage(root: string): void {
  git(root, 'add', '-A');
}

export function gate(cwd: string) {
  const lines: string[] = [];
  const capture = (...a: unknown[]) => {
    lines.push(a.join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  const code = runCoverage(cwd);
  vi.restoreAllMocks();
  return { code, out: lines.join('\n') };
}
