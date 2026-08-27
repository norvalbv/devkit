import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ANTI_SLOP_UPSTREAM } from './constants.mts';
import {
  gitBaselineEnvelope,
  withBaseAntiSlopSnapshot,
  withStagedAntiSlopSnapshot,
} from './git-snapshot.mts';

const roots: string[] = [];
const EMPTY_BASELINE = `${JSON.stringify(
  { schemaVersion: 1, upstreamCommit: ANTI_SLOP_UPSTREAM, entries: [] },
  null,
  2,
)}\n`;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repository(withCommit = true): string {
  const root = mkdtempSync(join(tmpdir(), 'anti-slop-git-snapshot-'));
  roots.push(root);
  git(root, ['init', '-q']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.anti-slop-baseline.json'), EMPTY_BASELINE);
  writeFileSync(join(root, 'src', 'file.ts'), 'export const value = "base";\n');
  git(root, ['add', '-A']);
  if (withCommit) {
    git(root, [
      '-c',
      'user.name=Devkit test',
      '-c',
      'user.email=devkit@test.invalid',
      'commit',
      '-qm',
      'base',
    ]);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('anti-slop staged Git snapshot', () => {
  it('reads staged bytes even when the working tree contains different bytes', () => {
    const root = repository();
    writeFileSync(join(root, 'src', 'file.ts'), 'export const value = "staged";\n');
    git(root, ['add', 'src/file.ts']);
    writeFileSync(join(root, 'src', 'file.ts'), 'export const value = "working";\n');

    withStagedAntiSlopSnapshot(root, (snapshot) => {
      expect(snapshot.paths).toEqual(['src/file.ts']);
      expect(readFileSync(join(snapshot.cwd, 'src', 'file.ts'), 'utf8')).toContain('"staged"');
      expect(snapshot.base?.entries).toEqual([]);
    });
  });

  it('forces a full scan for baseline, root config, or managed capability changes', () => {
    const root = repository();
    writeFileSync(join(root, '.anti-slop-baseline.json'), `${EMPTY_BASELINE.trim()}\n\n`);
    git(root, ['add', '.anti-slop-baseline.json']);

    withStagedAntiSlopSnapshot(root, (snapshot) => {
      expect(snapshot.fullScan).toBe(true);
      expect(snapshot.paths).toEqual([]);
      expect(snapshot.skipped).toBe(false);
    });
  });

  it.each(['.oxlintrc.json', '.oxlintrc.jsonc', 'oxlint.config.ts', 'oxlint.config.mts'])(
    'forces a full scan when the recognized root config %s changes',
    (config) => {
      const root = repository();
      writeFileSync(join(root, config), '{}\n');
      git(root, ['add', config]);

      withStagedAntiSlopSnapshot(root, (snapshot) => {
        expect(snapshot.changedFiles).toContain(config);
        expect(snapshot.fullScan).toBe(true);
        expect(snapshot.paths).toEqual([]);
        expect(snapshot.skipped).toBe(false);
      });
    },
  );

  it('preserves spaces and newlines in staged source paths', () => {
    const root = repository();
    const names = ['src/space file.ts', 'src/line\nbreak.ts'];
    for (const name of names) writeFileSync(join(root, name), 'export const added = true;\n');
    git(root, ['add', ...names]);

    withStagedAntiSlopSnapshot(root, (snapshot) => {
      expect(new Set(snapshot.paths)).toEqual(new Set(names));
    });
  });

  it('scopes a monorepo package and ignores staged siblings', () => {
    const root = repository();
    const app = join(root, 'packages', 'app');
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, '.anti-slop-baseline.json'), EMPTY_BASELINE);
    writeFileSync(join(app, 'src', 'inside.ts'), 'export const inside = 1;\n');
    writeFileSync(join(root, 'src', 'outside.ts'), 'export const outside = 1;\n');
    git(root, ['add', '-A']);

    withStagedAntiSlopSnapshot(app, (snapshot) => {
      expect(snapshot.paths).toEqual([]);
      expect(snapshot.changedFiles).toEqual(['.anti-slop-baseline.json', 'src/inside.ts']);
      expect(snapshot.fullScan).toBe(true);
    });
  });

  it('supports an initial commit and records exact renames', () => {
    const initial = repository(false);
    withStagedAntiSlopSnapshot(initial, (snapshot) => {
      expect(snapshot.base).toBeNull();
      expect(snapshot.fullScan).toBe(true);
    });

    const renamed = repository();
    git(renamed, ['mv', 'src/file.ts', 'src/renamed.ts']);
    withStagedAntiSlopSnapshot(renamed, (snapshot) => {
      expect(snapshot.renames.get('src/file.ts')).toBe('src/renamed.ts');
      expect(snapshot.paths).toEqual(['src/renamed.ts']);
    });
  });

  it('materializes selected files from the exact base tree and omits candidate-only paths', () => {
    const root = repository();
    const base = git(root, ['rev-parse', 'HEAD']);
    writeFileSync(join(root, 'src', 'file.ts'), 'export const value = "candidate";\n');
    writeFileSync(join(root, 'src', 'candidate.ts'), 'export const candidate = true;\n');
    git(root, ['add', '-A']);
    const envelope = gitBaselineEnvelope(root, base);
    expect(envelope.introducedPaths).toEqual(new Set(['src/candidate.ts']));

    withBaseAntiSlopSnapshot(
      root,
      root,
      envelope.baseTree,
      ['src/file.ts', 'src/candidate.ts'],
      (snapshot) => {
        expect(snapshot.paths).toEqual(['src/file.ts']);
        expect(readFileSync(join(snapshot.cwd, 'src', 'file.ts'), 'utf8')).toContain('"base"');
      },
    );
  });
});
