import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { structureCmdFor } from '../lib/components.mts';
import { testSpawnSync as spawnSync } from './_helpers.mts';

const DEVKIT_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('electron structure lint in a ship worktree', () => {
  const stage = (cwd, ...paths) => {
    const result = spawnSync('git', ['add', '--', ...paths], { cwd, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  };

  const initializeGit = (cwd) => {
    for (const args of [
      ['init'],
      ['config', 'user.email', 'devkit-test@example.com'],
      ['config', 'user.name', 'Devkit Test'],
    ]) {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    }
  };

  const stagedGate = (cwd) =>
    spawnSync(process.execPath, [join(DEVKIT_ROOT, 'gate-engine/structure/run.mts'), 'staged'], {
      cwd,
      encoding: 'utf8',
    });

  const writeElectronConfig = (cwd, body) => {
    writeFileSync(join(cwd, 'guard.config.json'), '{"scanRoots":["src"]}\n');
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(cwd, 'eslint.config.mjs'),
      `import {
  createFolderStructure,
  projectStructureParser,
  projectStructurePlugin,
} from 'eslint-plugin-project-structure';

const structure = createFolderStructure({
  structureRoot: 'src',
  structure: ${body},
});

export default [{
  files: ['src/**/*.ts'],
  languageOptions: { parser: projectStructureParser },
  plugins: { 'project-structure': projectStructurePlugin },
  rules: { 'project-structure/folder-structure': ['error', structure] },
}];
`,
    );
  };

  it('keeps plugin resolution rooted in a package worktree when node_modules is symlinked', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'electron-structure-symlink-')));
    roots.push(root);
    // Git reports index paths from the monorepo root; the generated hook runs from this package.
    // A violation proves the staged runner re-addresses those paths before it calls Electron ESLint.
    const worktree = join(root, 'packages', 'desktop');
    mkdirSync(join(worktree, 'src'), { recursive: true });
    symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(worktree, 'node_modules'));
    writeElectronConfig(worktree, "{ name: 'src', children: [{ name: 'allowed.ts' }] }");
    writeFileSync(join(worktree, 'src', 'wrong.ts'), 'export {};\n');
    initializeGit(root);
    stage(
      root,
      'packages/desktop/package.json',
      'packages/desktop/guard.config.json',
      'packages/desktop/eslint.config.mjs',
      'packages/desktop/src/wrong.ts',
    );

    const result = stagedGate(worktree);

    expect(structureCmdFor('electron')).toBe('guard-structure staged');
    expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('wrong.ts');
  });

  it('probes a staged deletion so a missing required index still blocks', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'electron-structure-deletion-')));
    roots.push(root);
    const worktree = join(root, 'worktree');
    mkdirSync(join(worktree, 'src', 'Feature'), { recursive: true });
    symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(worktree, 'node_modules'));
    writeElectronConfig(
      worktree,
      "{ name: 'src', children: [{ name: 'Feature', enforceExistence: 'index.ts', children: [{ name: 'index.ts' }, { name: 'constants.ts' }] }] }",
    );
    writeFileSync(join(worktree, 'src', 'Feature', 'constants.ts'), 'export {};\n');
    writeFileSync(join(worktree, 'src', 'Feature', 'index.ts'), 'export {};\n');
    initializeGit(worktree);
    stage(
      worktree,
      'package.json',
      'guard.config.json',
      'eslint.config.mjs',
      'src/Feature/index.ts',
      'src/Feature/constants.ts',
    );
    const initial = spawnSync('git', ['commit', '-m', 'initial'], {
      cwd: worktree,
      encoding: 'utf8',
    });
    expect(initial.status, initial.stderr).toBe(0);

    rmSync(join(worktree, 'src', 'Feature', 'index.ts'));
    const deleted = spawnSync('git', ['add', '-u', '--', 'src/Feature/index.ts'], {
      cwd: worktree,
      encoding: 'utf8',
    });
    expect(deleted.status, deleted.stderr).toBe(0);

    const result = stagedGate(worktree);
    expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /Feature[\s\S]*index\.ts|index\.ts[\s\S]*Feature/,
    );
  });
});
