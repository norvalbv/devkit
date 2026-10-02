/**
 * `devkit coverage-run --changed` (gate-engine/coverage/changed.mts): a per-file coverage table for a
 * branch's diff that never touches the coverage gate's artifact.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI, testSpawnSync } from '../../../cli/__tests__/_helpers.mts';
import { changedArgs, DEFAULT_BASE, includeGlobs, takeChanged } from '../changed.mts';
import { COVERAGE_FILE, RUNS_DIR } from '../produce.mts';

const DEVKIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-changed-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

const coverageRun = (root: string, ...args: string[]) =>
  testSpawnSync(process.execPath, [CLI, 'coverage-run', ...args], { cwd: root, encoding: 'utf8' });

const git = (root: string, ...args: string[]) =>
  testSpawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: root,
    encoding: 'utf8',
  });

describe('takeChanged', () => {
  it('is null without --changed, so the producer path is untouched', () => {
    expect(takeChanged(['--bail=1'])).toBeNull();
  });

  it('defaults a bare --changed to the remote default branch, not vitest’s "uncommitted only"', () => {
    expect(takeChanged(['--changed', '--bail=1'])).toEqual({
      base: DEFAULT_BASE,
      rest: ['--bail=1'],
    });
  });

  it('accepts both vitest spellings of an explicit base', () => {
    expect(takeChanged(['--changed=HEAD~1'])).toEqual({ base: 'HEAD~1', rest: [] });
    expect(takeChanged(['--changed', 'origin/main', '--bail=1'])).toEqual({
      base: 'origin/main',
      rest: ['--bail=1'],
    });
  });
});

describe('includeGlobs', () => {
  it('builds one glob per scan root and extension, normalising both', () => {
    expect(includeGlobs(['./src', 'relay/src/', '.'], ['.ts', 'tsx'])).toEqual([
      'src/**/*.ts',
      'src/**/*.tsx',
      'relay/src/**/*.ts',
      'relay/src/**/*.tsx',
      '**/*.ts',
      '**/*.tsx',
    ]);
  });
});

describe('changedArgs', () => {
  it('passes one --changed, a private reports dir, a text table and the config-derived include', () => {
    const args = changedArgs('main', [], '/r/run', ['src'], ['ts']);
    expect(args.filter((a) => a.startsWith('--changed'))).toEqual(['--changed=main']);
    expect(args).toContain('--coverage.reportsDirectory=/r/run');
    expect(args).toContain('--coverage.reporter=text');
    expect(args).toContain('--coverage.include=src/**/*.ts');
  });

  it('leaves reporter and include to a caller who sets them', () => {
    const args = changedArgs(
      'main',
      ['--coverage.reporter=json', '--coverage.include=lib/**'],
      '/r',
      ['src'],
      ['ts'],
    );
    expect(args.filter((a) => a.startsWith('--coverage.reporter'))).toEqual([
      '--coverage.reporter=json',
    ]);
    expect(args.filter((a) => a.startsWith('--coverage.include'))).toEqual([
      '--coverage.include=lib/**',
    ]);
  });
});

describe('devkit coverage-run --changed refusals', () => {
  // vitest crashes with a raw "Expected a single value" stack on a second --changed.
  it('refuses a second --changed with a usable message', () => {
    const r = coverageRun(makeRoot(), '--changed=main', '--changed=HEAD');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--changed was given twice');
  });

  it('names the remedy when the base does not resolve', () => {
    const root = makeRoot();
    symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(root, 'node_modules'));
    git(root, 'init', '-q');
    git(root, 'commit', '-q', '--allow-empty', '-m', 'base');
    const r = coverageRun(root, '--changed');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('git remote set-head origin --auto');
  });
});

describe('devkit coverage-run --changed against real vitest', () => {
  it('tables exactly the changed source files and leaves the gate artifact alone', () => {
    const root = makeRoot();
    symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(root, 'node_modules'));
    writeFileSync(
      join(root, 'guard.config.json'),
      JSON.stringify({ scanRoots: ['src'], sourceExtensions: ['mjs'] }),
    );
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      "export default { test: { include: ['src/**/*.test.mjs'], coverage: { provider: 'v8' } } };\n",
    );
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'touched.mjs'), 'export const touched = (n) => n + 1;\n');
    writeFileSync(join(root, 'src', 'untouched.mjs'), 'export const untouched = (n) => n - 1;\n');
    writeFileSync(
      join(root, 'src', 'touched.test.mjs'),
      "import { expect, it } from 'vitest';\nimport { touched } from './touched.mjs';\nit('adds', () => expect(touched(1)).toBe(2));\n",
    );
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');

    // The branch's diff: one tested file edited, one untested file added (untracked).
    writeFileSync(
      join(root, 'src', 'touched.mjs'),
      'export const touched = (n) => n + 1;\nexport const twice = (n) => n * 2;\n',
    );
    writeFileSync(join(root, 'src', 'orphan.mjs'), 'export const orphan = () => 0;\n');
    // A prior full run's artifact: vitest's startup clean would delete it from a shared directory.
    mkdirSync(join(root, 'coverage'));
    writeFileSync(join(root, COVERAGE_FILE), 'SENTINEL');

    const r = coverageRun(root, '--changed=HEAD');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\btouched\.mjs/);
    expect(r.stdout).toMatch(/orphan\.mjs\s*\|\s*0\b/);
    expect(r.stdout).not.toMatch(/untouched\.mjs/);
    expect(readFileSync(join(root, COVERAGE_FILE), 'utf8')).toBe('SENTINEL');
    const runs = join(root, RUNS_DIR);
    expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([]);
  });
});
