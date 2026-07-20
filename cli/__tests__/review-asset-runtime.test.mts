import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../gate-engine/config.mts';
import { REVIEWERS, type ReviewerSelection } from '../../gate-engine/review/reviewers.mts';
import {
  PACKAGED_REVIEW_ASSET_PATHS,
  preflightReviewAssets,
} from '../../gate-engine/review/runtime.mts';
import { materializeReviewAssetRuntime } from '../lib/ship/review/asset-runtime.mts';
import { reviewRuntimeFingerprint } from '../lib/ship/review/runtime-fingerprint.mts';
import { rootRegistry } from './_helpers.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET_CLI = join(HERE, '../lib/ship/review/asset-runtime.mts');
const FINGERPRINT_CLI = join(HERE, '../lib/ship/review/runtime-fingerprint.mts');
const EXPECTED_ASSETS = [
  'agents/api-security-reviewer.md',
  'agents/backend-performance-reviewer.md',
  'agents/commit-guard.md',
  'agents/conventions-reviewer.md',
  'agents/correctness-reviewer.md',
  'agents/frontend-performance-reviewer.md',
  'agents/frontend-security-reviewer.md',
  'skills/_devkit/review-roots.mjs',
  'skills/api-security/SKILL.md',
  'skills/api-security/scripts/checklist.mjs',
  'skills/backend-performance/SKILL.md',
  'skills/backend-performance/scripts/checklist.mjs',
  'skills/commit-guard/SKILL.md',
  'skills/commit-guard/scripts/checklist.mjs',
  'skills/correctness/SKILL.md',
  'skills/correctness/scripts/checklist.mjs',
  'skills/frontend-performance/SKILL.md',
  'skills/frontend-performance/scripts/checklist.mjs',
  'skills/frontend-security/SKILL.md',
  'skills/frontend-security/scripts/checklist.mjs',
] as const;

const { mkTmp, cleanup } = rootRegistry();

afterEach(cleanup);

function write(root: string, path: string, contents = `asset:${path}\n`): string {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
  return destination;
}

function packageFixture(prefix = 'devkit-review-package-'): string {
  const root = mkTmp(prefix);
  for (const assetPath of PACKAGED_REVIEW_ASSET_PATHS) write(root, assetPath);
  return root;
}

function destination(prefix = 'devkit-review-assets-parent-'): string {
  return join(mkTmp(prefix), 'runtime');
}

function verifyFingerprint(expected: string, path: string) {
  return spawnSync(process.execPath, [FINGERPRINT_CLI, '--verify', expected, path], {
    encoding: 'utf8',
  });
}

describe('packaged reviewer asset runtime', () => {
  it('derives one exact, sorted asset set from the reviewer registry', () => {
    expect(PACKAGED_REVIEW_ASSET_PATHS).toEqual(EXPECTED_ASSETS);
    expect(PACKAGED_REVIEW_ASSET_PATHS).not.toContain('agents/frontend-accessibility-reviewer.md');
    expect(PACKAGED_REVIEW_ASSET_PATHS).not.toContain('skills/brainstorming/SKILL.md');
  });

  it('copies only registered assets, dereferences links, preserves executability, and keeps preflight identity', () => {
    const source = packageFixture('devkit review package ');
    const originalBrief = join(source, 'agents/api-security-reviewer.md');
    const linkedBrief = write(
      source,
      'private/api-security-reviewer.md',
      readFileSync(originalBrief, 'utf8'),
    );
    rmSync(originalBrief);
    symlinkSync(relative(dirname(originalBrief), linkedBrief), originalBrief);
    write(source, 'agents/unregistered.md');
    write(source, 'skills/unregistered/SKILL.md');
    const executable = join(source, 'skills/api-security/scripts/checklist.mjs');
    chmodSync(executable, 0o755);

    const requested = destination();
    const captured = materializeReviewAssetRuntime(source, requested);

    expect(captured.root).toBe(realpathSync(requested));
    expect(captured.paths).toEqual(EXPECTED_ASSETS);
    expect(captured.fingerprint).toBe(reviewRuntimeFingerprint(captured.root));
    expect(existsSync(join(captured.root, 'agents/unregistered.md'))).toBe(false);
    expect(existsSync(join(captured.root, 'skills/unregistered'))).toBe(false);
    expect(lstatSync(join(captured.root, 'agents/api-security-reviewer.md')).isFile()).toBe(true);
    expect(lstatSync(join(captured.root, 'agents/api-security-reviewer.md')).isSymbolicLink()).toBe(
      false,
    );
    expect(
      lstatSync(join(captured.root, 'skills/api-security/scripts/checklist.mjs')).mode & 0o111,
    ).not.toBe(0);

    const selected: ReviewerSelection[] = REVIEWERS.map((reviewer) => ({
      reviewer,
      files: ['src/example.ts'],
    }));
    const cfg = resolveGuardConfig(source);
    expect([...preflightReviewAssets(captured.root, selected, cfg)]).toEqual([
      ...preflightReviewAssets(source, selected, cfg),
    ]);
  });

  it('fails coherently and removes the private runtime when package bytes change during capture', () => {
    const source = packageFixture();
    const runtime = destination();
    const brief = join(source, 'agents/api-security-reviewer.md');

    expect(() =>
      materializeReviewAssetRuntime(source, runtime, {
        beforeSourceVerification: () => writeFileSync(brief, 'changed\n'),
      }),
    ).toThrow(/changed during private runtime capture/);
    expect(existsSync(runtime)).toBe(false);
  });

  it('rejects assets whose symlink target escapes the canonical package root', () => {
    const source = packageFixture();
    const runtime = destination();
    const brief = join(source, 'agents/api-security-reviewer.md');
    const external = write(mkTmp('devkit-review-external-'), 'brief.md');
    rmSync(brief);
    symlinkSync(external, brief);

    expect(() => materializeReviewAssetRuntime(source, runtime)).toThrow(/escapes package root/);
    expect(existsSync(runtime)).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('rejects special packaged asset entries', () => {
    const source = packageFixture();
    const runtime = destination();
    const brief = join(source, 'agents/api-security-reviewer.md');
    rmSync(brief);
    const made = spawnSync('mkfifo', [brief], { encoding: 'utf8' });
    expect(made.status, made.stderr).toBe(0);

    expect(() => materializeReviewAssetRuntime(source, runtime)).toThrow(/not a regular file/);
    expect(existsSync(runtime)).toBe(false);
  });

  it('requires a fresh tool-grammar-safe destination', () => {
    const source = packageFixture();
    const unsafe = destination('devkit-review-unsafe-parent-').replace(
      /runtime$/,
      'runtime unsafe',
    );
    expect(() => materializeReviewAssetRuntime(source, unsafe)).toThrow(/unsafe for the judge/);

    const existing = destination();
    mkdirSync(existing);
    expect(() => materializeReviewAssetRuntime(source, existing)).toThrow(/already exists/);
  });

  it('isolates a successful capture from later package changes and detects persistent private mutation', () => {
    const source = packageFixture();
    const captured = materializeReviewAssetRuntime(source, destination());
    const expected = captured.fingerprint;
    writeFileSync(join(source, 'agents/api-security-reviewer.md'), 'package upgraded\n');

    expect(reviewRuntimeFingerprint(captured.root)).toBe(expected);
    expect(verifyFingerprint(expected, captured.root).status).toBe(0);

    writeFileSync(join(captured.root, 'agents/api-security-reviewer.md'), 'persistent mutation\n');
    const mutated = verifyFingerprint(expected, captured.root);
    expect(mutated.status).toBe(1);
    expect(mutated.stderr).toContain(captured.root);
  });

  it('materializes through the CLI when the package path is a symlink containing spaces', () => {
    const source = packageFixture();
    const parent = mkTmp('devkit-review-package-link-');
    const packageLink = join(parent, 'package with spaces');
    symlinkSync(source, packageLink);
    const runtime = destination();

    const result = spawnSync(process.execPath, [ASSET_CLI, packageLink, runtime], {
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^[a-f0-9]{64}$/);
    expect(result.stdout).toBe(reviewRuntimeFingerprint(runtime));
  });
});
