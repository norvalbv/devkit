import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as nativePlanner from '../../../corpus/chunk-guard.mts';
import { censusSource } from '../census.mts';
import { sha256 } from '../../claim-inventory.mts';

function fixture() {
  const parent = path.join(os.homedir(), '.devkit', 'research');
  mkdirSync(parent, { recursive: true });
  const repo = mkdtempSync(path.join(parent, 'census-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(path.join(repo, 'src'));
  const source = 'export const value = 2;\n';
  writeFileSync(path.join(repo, 'src/item.ts'), 'export const value = 1;\n');
  git('add', '.');
  git(
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=Census',
    '-c',
    'user.email=census@example.invalid',
    'commit',
    '-qm',
    'fixture',
  );
  const baseSha = git('rev-parse', 'HEAD').trim();
  writeFileSync(path.join(repo, 'src/item.ts'), source);
  git('add', '.');
  const hash = sha256('synthetic adapter test');
  const manifest = {
    version: 1,
    mode: 'zero-judge-source-census',
    selectedFamilies: ['family-001'],
    entries: [
      {
        id: 'case-001',
        family: 'family-001',
        incidentSha256: hash,
        exposure: 'exposed-development',
        role: 'bug',
        variantOf: null,
        targetLens: 'state-transitions',
        qualification: 'unresolved',
        source: {
          repoAlias: 'repo-001',
          baseSha,
          diffSha256: sha256(git('diff', '--cached', '--no-ext-diff')),
          provenanceSha256: hash,
        },
        evidence: { requirementSha256: null, controlSha256: null, assessmentSha256: null },
        spans: [
          {
            file: 'src/item.ts',
            side: 'post',
            start: 1,
            end: 1,
            fileSha256: sha256(source),
            spanSha256: sha256(source.trimEnd()),
          },
        ],
      },
    ],
  };
  return { repo, manifest, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

describe('private native source census', () => {
  it('binds the native plan and refuses a changed snapshot without leaking source into the result', () => {
    const fx = fixture();
    try {
      const report = censusSource(JSON.stringify(fx.manifest), 'case-001', fx.repo);
      expect(report.tasks).toHaveLength(4);
      expect(report.tasks.every((task) => task.required[0].status === 'supplied')).toBe(true);
      expect(report.condition.judgeCalls).toBe(0);
      expect(report.qualification).toBe('unresolved');
      expect(JSON.stringify(report)).not.toContain('src/item.ts');
      expect(JSON.stringify(report)).not.toContain('export const');
      writeFileSync(path.join(fx.repo, 'src/item.ts'), 'export const value = 3;\n');
      expect(() => censusSource(JSON.stringify(fx.manifest), 'case-001', fx.repo)).toThrow(
        'WORKTREE_CHANGED',
      );
      fx.manifest.entries[0].source.baseSha = '0'.repeat(40);
      expect(() => censusSource(JSON.stringify(fx.manifest), 'case-001', fx.repo)).toThrow(
        'BASE_MISMATCH',
      );
    } finally {
      fx.cleanup();
    }
  });
  it('ignores untracked configuration outside the frozen tree', () => {
    const fx = fixture();
    try {
      writeFileSync(
        path.join(fx.repo, 'guard.config.json'),
        JSON.stringify({ review: { paths: { include: ['elsewhere/**'] } } }),
      );
      const report = censusSource(JSON.stringify(fx.manifest), 'case-001', fx.repo);
      expect(report.tasks).toHaveLength(4);
      expect(report.condition.configSourceSha256).toBeNull();
    } finally {
      fx.cleanup();
    }
  });
  it('plans from the pinned tree when the live index changes and changes back', () => {
    const fx = fixture();
    const original = nativePlanner.planFixture;
    const file = path.join(fx.repo, 'src/item.ts');
    const stage = (value) => {
      writeFileSync(file, `export const value = ${value};\n`);
      execFileSync('git', ['add', 'src/item.ts'], { cwd: fx.repo });
    };
    const planner = vi.spyOn(nativePlanner, 'planFixture').mockImplementation((...args) => {
      stage(3);
      try {
        return original(...args);
      } finally {
        stage(2);
      }
    });
    try {
      const report = censusSource(JSON.stringify(fx.manifest), 'case-001', fx.repo);
      expect(
        report.tasks.every((task) => task.diffSha256 === fx.manifest.entries[0].source.diffSha256),
      ).toBe(true);
      expect(report.tasks.every((task) => task.required[0].status === 'supplied')).toBe(true);
    } finally {
      planner.mockRestore();
      fx.cleanup();
    }
  });
  it('gives concurrent CLI invocations separate outputs and sanitizes errors', async () => {
    const fx = fixture();
    try {
      const file = path.join(fx.repo, 'input.json');
      writeFileSync(file, JSON.stringify(fx.manifest));
      const cli = fileURLToPath(new URL('../census-cli.mts', import.meta.url));
      const args = [cli, file, 'case-001', fx.repo, fx.repo];
      const run = () => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000 });
      const [first, second] = await Promise.all([
        promisify(execFile)(process.execPath, args, { encoding: 'utf8', timeout: 30000 }),
        promisify(execFile)(process.execPath, args, { encoding: 'utf8', timeout: 30000 }),
      ]);
      expect(JSON.parse(first.stdout)).toEqual(JSON.parse(second.stdout));
      writeFileSync(file, '{ "privateClaim": "SECRET_FILE_NAME" }');
      const invalid = run();
      expect(invalid.status).toBe(1);
      expect(invalid.stdout).toBe('');
      expect(invalid.stderr).toContain('CENSUS_FAILED');
      expect(invalid.stderr).not.toContain('SECRET_FILE_NAME');
      expect(invalid.stderr).not.toContain(fx.repo);
      expect(readFileSync(file, 'utf8')).toContain('SECRET_FILE_NAME');
      fx.manifest.entries[0].spans[0].file = 'src/SECRET_FILE_NAME.ts';
      writeFileSync(file, JSON.stringify(fx.manifest));
      const missingSource = run();
      expect(missingSource.status).toBe(1);
      expect(missingSource.stdout).toBe('');
      expect(missingSource.stderr).toContain('CENSUS_FAILED');
      expect(missingSource.stderr).not.toContain('SECRET_FILE_NAME');
      expect(missingSource.stderr).not.toContain(fx.repo);
    } finally {
      fx.cleanup();
    }
  });
});
