import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import { gitCached, headFile, indexFile, stagedFiles } from '../evidence/staged-git.mts';
import { selectRepositoryReviewers } from '../scope/repository.mts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'review-staged-git-'));
  roots.push(root);
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'devkit@example.test']);
  git(['config', 'user.name', 'Devkit Test']);
  writeFileSync(join(root, 'guard.config.json'), '{"scanRoots":["src"]}\n');
  git(['add', 'guard.config.json']);
  git(['commit', '-qm', 'baseline']);
  return root;
}

describe('review staged Git evidence', () => {
  it('literalizes pathspec-shaped and glob-shaped staged filenames', () => {
    const root = repo();
    const names = [':(exclude)runtime.mts', '[slug].mts', 'ordinary.mts'];
    for (const name of names)
      writeFileSync(join(root, name), `export const file = ${JSON.stringify(name)};\n`);
    execFileSync('git', ['add', '-A'], { cwd: root });

    for (const name of names) {
      const diff = gitCached(root, [], [name]);
      expect(diff).toContain(`b/${name}`);
      for (const other of names.filter((candidate) => candidate !== name))
        expect(diff).not.toContain(`b/${other}`);
    }
  });

  it('reads the committed config independently of the staged copy', () => {
    const root = repo();
    writeFileSync(join(root, 'guard.config.json'), '{"scanRoots":["new"]}\n');
    execFileSync('git', ['add', 'guard.config.json'], { cwd: root });
    expect(headFile(root, 'guard.config.json')).toBe('{"scanRoots":["src"]}\n');
    expect(indexFile(root, 'guard.config.json')).toBe('{"scanRoots":["new"]}\n');
  });

  it('reads an indexed config larger than the former 4 MiB buffer without treating it as absent', () => {
    const root = repo();
    const config = `${JSON.stringify({ padding: 'x'.repeat(4 * 1024 * 1024) })}\n`;
    writeFileSync(join(root, 'guard.config.json'), config);
    execFileSync('git', ['add', 'guard.config.json'], { cwd: root });
    expect(indexFile(root, 'guard.config.json')).toBe(config);
  });

  it('selects every reviewer from staged policy plus HEAD when the worktree has a third policy', () => {
    const root = repo();
    const policy = (path: string) =>
      `${JSON.stringify({
        scanRoots: ['legacy-runtime', 'new-runtime'],
        sourceExtensions: ['sh'],
        review: {
          backendRoots: ['legacy-runtime', 'new-runtime'],
          frontendRoots: [],
          paths: { include: [`${path}/**`], exclude: [] },
        },
      })}\n`;
    writeFileSync(join(root, 'guard.config.json'), policy('legacy-runtime'));
    execFileSync('git', ['add', 'guard.config.json'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'policy a'], { cwd: root });

    writeFileSync(join(root, 'guard.config.json'), policy('new-runtime'));
    for (const file of ['legacy-runtime/a.sh', 'new-runtime/b.sh']) {
      const absolute = join(root, file);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, '#!/bin/sh\n');
    }
    execFileSync('git', ['add', 'guard.config.json', 'legacy-runtime/a.sh', 'new-runtime/b.sh'], {
      cwd: root,
    });
    writeFileSync(join(root, 'guard.config.json'), policy('worktree-only'));

    const selected = selectRepositoryReviewers(stagedFiles(root), resolveGuardConfig(root));
    expect(selected.map((entry) => entry.reviewer.name)).toEqual([
      'api-security-reviewer',
      'backend-performance-reviewer',
      'commit-guard',
      'correctness-reviewer',
      'conventions-reviewer',
    ]);
    for (const entry of selected)
      expect(entry.files).toEqual(['legacy-runtime/a.sh', 'new-runtime/b.sh']);
  });

  it('ignores an unstaged worktree policy that would exempt staged runtime files', () => {
    const root = repo();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    execFileSync('git', ['add', 'src/a.ts'], { cwd: root });
    writeFileSync(
      join(root, 'guard.config.json'),
      `${JSON.stringify({
        scanRoots: ['other'],
        review: {
          backendRoots: ['other'],
          frontendRoots: [],
          paths: { include: ['other/**'], exclude: [] },
        },
      })}\n`,
    );

    const selected = selectRepositoryReviewers(stagedFiles(root), resolveGuardConfig(root));
    expect(selected.map((entry) => entry.reviewer.name)).toEqual([
      'api-security-reviewer',
      'backend-performance-reviewer',
      'commit-guard',
      'correctness-reviewer',
      'conventions-reviewer',
    ]);
    for (const entry of selected) expect(entry.files).toEqual(['src/a.ts']);
  });
});
