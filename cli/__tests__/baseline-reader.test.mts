/** sc-1934: the shared reader-floor predicate. The installed version judges; unknown never refuses. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BASELINE_READER_REMEDIATION,
  baselineReaderCheck,
  baselineReaderMismatch,
  CANONICAL_BASELINE_READER_FLOOR,
  canonicalOnlyRatchetBaselines,
  canonicalOnlyRatchetBaselinesInRepo,
  stalePinnedBaselineReader,
} from '../lib/doctor/pin/baseline-reader.mts';
import { rootRegistry, testExecFileSync as execFileSync } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

function seed(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}

/** A package-mode consumer with devkit `installed` in node_modules and `declared` in package.json. */
/** The `.devkit/config.json` fields these fixtures vary. */
interface FixtureConfig {
  stack?: string;
  overlay?: boolean;
  selfHost?: boolean;
  devkitRef?: string;
}

function consumer({
  installed,
  declared = installed,
  config = { stack: 'generic' },
}: {
  installed?: string;
  declared?: string;
  config?: FixtureConfig;
}): string {
  const root = mkTmp('reader-');
  mkdirSync(join(root, '.git'));
  seed(root, {
    '.devkit/config.json': JSON.stringify(config),
    'package.json': JSON.stringify({
      devDependencies: declared ? { '@norvalbv/devkit': `git+https://x/y.git#v${declared}` } : {},
    }),
  });
  if (installed)
    seed(root, {
      'node_modules/@norvalbv/devkit/package.json': JSON.stringify({ version: installed }),
    });
  return root;
}

describe('stalePinnedBaselineReader — the 0.53.0 floor', () => {
  it.each([
    ['0.52.99', true],
    ['0.9.0', true], // numeric, not lexical: 9 < 53
    ['0.0.0', true],
    [CANONICAL_BASELINE_READER_FLOOR, false],
    ['0.100.0', false], // lexically "0.100" < "0.53" — must still read as newer
    ['1.0.0', false],
  ])('installed %s → stale=%s', (installed, stale) => {
    expect(stalePinnedBaselineReader(consumer({ installed })).stale).toBe(stale);
  });

  it('judges the INSTALLED devkit: a bumped-but-not-installed pin is still the old reader', () => {
    const root = consumer({ installed: '0.52.0', declared: '0.63.0' });
    expect(stalePinnedBaselineReader(root)).toEqual({ stale: true, installed: '0.52.0' });
  });

  it('a fresh install under a stale declaration (link:/file: workflows) is not stale', () => {
    expect(
      stalePinnedBaselineReader(consumer({ installed: '0.60.0', declared: '0.40.0' })).stale,
    ).toBe(false);
  });

  it.each([
    ['self-host', { selfHost: true }],
    ['overlay', { overlay: true, devkitRef: 'v0.40.0' }],
  ])('%s is never stale — its reader is not node_modules', (_mode, config) => {
    expect(stalePinnedBaselineReader(consumer({ installed: '0.40.0', config })).stale).toBe(false);
  });

  it.each([
    ['no install', undefined],
    ['a prerelease', '0.52.0-beta.1'],
    ['garbage', 'latest'],
  ])('%s is unknown, and unknown never refuses', (_label, installed) => {
    expect(stalePinnedBaselineReader(consumer({ installed })).stale).toBe(false);
  });

  it('a corrupt installed package.json answers "not stale" instead of crashing init/doctor', () => {
    const root = consumer({});
    seed(root, { 'node_modules/@norvalbv/devkit/package.json': '{ not json' });
    expect(() => stalePinnedBaselineReader(root)).not.toThrow();
    expect(stalePinnedBaselineReader(root).stale).toBe(false);
  });

  it('a corrupt .devkit/config.json does not crash the lookup', () => {
    const root = consumer({ installed: '0.52.0' });
    seed(root, { '.devkit/config.json': '{ nope' });
    expect(stalePinnedBaselineReader(root).stale).toBe(true);
  });

  it('monorepo: a package dir resolves the install at the git root', () => {
    const root = consumer({ installed: '0.52.0' });
    const pkg = join(root, 'packages', 'app');
    seed(pkg, { '.devkit/config.json': '{}', 'package.json': '{}' });
    expect(stalePinnedBaselineReader(pkg).stale).toBe(true);
  });
});

describe('canonicalOnlyRatchetBaselines — what a legacy-only reader would miss', () => {
  it('lists a canonical file with no legacy copy', () => {
    const root = consumer({});
    seed(root, { '.devkit/baselines/size-lines.json': '{}' });
    expect(canonicalOnlyRatchetBaselines(root)).toEqual(['.devkit/baselines/size-lines.json']);
  });

  it('judges each pair on its own: a legacy sibling does not cover a different file', () => {
    const root = consumer({});
    seed(root, {
      '.devkit/baselines/size.json': '{}',
      'eslint/baselines/size-lines.json': '{}',
    });
    expect(canonicalOnlyRatchetBaselines(root)).toEqual(['.devkit/baselines/size.json']);
  });

  it('a pair present on both sides is still readable by the old reader', () => {
    const root = consumer({});
    seed(root, { '.devkit/baselines/size.json': '{}', 'eslint/baselines/size.json': '{}' });
    expect(canonicalOnlyRatchetBaselines(root)).toEqual([]);
  });

  it('covers structure modules and the import wall, not only the JSON ratchets', () => {
    const root = consumer({});
    seed(root, {
      '.devkit/baselines/structure/src.mjs': 'export default {};',
      '.devkit/baselines/imports.mjs': 'export default {};',
    });
    expect(canonicalOnlyRatchetBaselines(root)).toEqual([
      '.devkit/baselines/imports.mjs',
      '.devkit/baselines/structure/src.mjs',
    ]);
  });
});

describe('baselineReaderMismatch / baselineReaderCheck — both halves required', () => {
  it('stale reader + canonical-only state → a DRIFT row naming the files and devkit upgrade', () => {
    const root = consumer({ installed: '0.52.0' });
    seed(root, { '.devkit/baselines/size-lines.json': '{}' });
    const row = baselineReaderCheck(root);
    expect(row).toMatchObject({ name: 'ratchet baseline reader', status: 'DRIFT', fixable: false });
    expect(row?.detail).toContain('0.52.0');
    expect(row?.detail).toContain('.devkit/baselines/size-lines.json');
    expect(row?.remediation).toBe(BASELINE_READER_REMEDIATION);
  });

  it('a stale reader over legacy-only state is consistent — no row', () => {
    const root = consumer({ installed: '0.52.0' });
    seed(root, { 'eslint/baselines/size-lines.json': '{}' });
    expect(baselineReaderMismatch(root)).toBeNull();
    expect(baselineReaderCheck(root)).toBeNull();
  });

  it('a current reader over canonical-only state — no row', () => {
    const root = consumer({ installed: '0.62.0' });
    seed(root, { '.devkit/baselines/size-lines.json': '{}' });
    expect(baselineReaderCheck(root)).toBeNull();
  });
});

describe('monorepo — the reader and the baselines can live in different package dirs', () => {
  it('doctor from a package dir sees root-level canonical-only baselines', () => {
    const root = consumer({ installed: '0.52.0' });
    seed(root, { '.devkit/baselines/size-lines.json': '{}' });
    const pkg = join(root, 'packages', 'app');
    seed(pkg, { '.devkit/config.json': '{}' });
    expect(baselineReaderMismatch(pkg)?.unread).toEqual(['.devkit/baselines/size-lines.json']);
  });

  it('scans every package that tracks a .devkit/config.json, as repo-relative paths', () => {
    const root = mkTmp('reader-mono-');
    execFileSync('git', ['init', '-q'], { cwd: root });
    seed(root, {
      'packages/a/.devkit/config.json': '{}',
      'packages/a/.devkit/baselines/size.json': '{}',
      'packages/b/.devkit/config.json': '{}',
      'packages/b/eslint/baselines/size.json': '{}',
      'packages/b/.devkit/baselines/size.json': '{}',
    });
    execFileSync('git', ['add', '.'], { cwd: root });
    expect(canonicalOnlyRatchetBaselinesInRepo(root)).toEqual([
      'packages/a/.devkit/baselines/size.json',
    ]);
  });
});
