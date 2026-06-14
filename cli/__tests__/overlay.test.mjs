/**
 * Overlay (local-only): use devkit on a repo you can't modify. Must be INVISIBLE to git
 * (.git/info/exclude → clean `git status`), NON-INVASIVE (package.json + the team's husky hook
 * untouched), and layer ours-extends-theirs configs + a local hook that chains to the team's.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyInit } from '../commands/init.mjs';
import { defaultSelection } from '../lib/components.mjs';

let roots = [];

// A work repo that already has a committed husky hook + flat eslint + biome (the team's).
function workRepo() {
  const root = mkdtempSync(join(tmpdir(), 'overlay-'));
  roots.push(root);
  const git = (...a) => execFileSync('git', a, { cwd: root });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'work', devDependencies: { react: '^18' } }, null, 2),
  );
  mkdirSync(join(root, '.husky'), { recursive: true });
  writeFileSync(join(root, '.husky', 'pre-commit'), '#!/bin/sh\necho team-hook\n');
  writeFileSync(join(root, 'eslint.config.mjs'), 'export default [{ rules: {} }];\n');
  writeFileSync(join(root, 'biome.jsonc'), '{ "linter": { "enabled": true } }\n');
  git('config', 'core.hooksPath', '.husky/_'); // simulate husky owning the hook
  git('add', '-A');
  git('commit', '-qm', 'init');
  return root;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

describe('overlay (local-only) install', () => {
  it('invisible + non-invasive: extends the repo, chains to the team hook, git status clean', async () => {
    const root = workRepo();
    const pkgBefore = readFileSync(join(root, 'package.json'), 'utf8');
    const huskyBefore = readFileSync(join(root, '.husky', 'pre-commit'), 'utf8');

    await applyInit(root, {
      stack: 'react-app',
      selection: defaultSelection(),
      overlay: true,
      devkitRef: 'v0.7.0',
    });

    // NON-INVASIVE: package.json + the team's hook are byte-identical
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(pkgBefore);
    expect(readFileSync(join(root, '.husky', 'pre-commit'), 'utf8')).toBe(huskyBefore);

    // INVISIBLE: git status clean (every devkit file is in .git/info/exclude)
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.devkit/');
    expect(exclude).toContain('guard.config.json');
    expect(exclude).toContain('eslint.config.devkit.mjs');

    // LOCAL HOOK: core.hooksPath points at the git-ignored dir; hook chains to the team's + is valid sh
    expect(
      execFileSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    ).toBe('.devkit/hooks');
    const hook = readFileSync(join(root, '.devkit', 'hooks', 'pre-commit'), 'utf8');
    expect(hook).toContain('__dk_gate');
    expect(hook).toContain('.husky/pre-commit'); // chains to the team's committed hook
    expect(() =>
      execFileSync('sh', ['-n', join(root, '.devkit', 'hooks', 'pre-commit')], { stdio: 'pipe' }),
    ).not.toThrow();

    // OURS-EXTENDS-THEIRS: local configs extend the repo's committed ones
    expect(readFileSync(join(root, 'eslint.config.devkit.mjs'), 'utf8')).toContain(
      "import repoConfig from './eslint.config.mjs'",
    );
    expect(JSON.parse(readFileSync(join(root, 'biome.devkit.jsonc'), 'utf8')).extends).toEqual([
      './biome.jsonc',
      './.devkit/biome/react.jsonc',
    ]);

    // config records overlay
    expect(JSON.parse(readFileSync(join(root, '.devkit', 'config.json'), 'utf8')).overlay).toBe(
      true,
    );
  });
});
