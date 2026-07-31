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
  it('keeps plugin resolution rooted in the ephemeral worktree when node_modules is symlinked', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'electron-structure-symlink-')));
    roots.push(root);
    const worktree = join(root, 'worktree');
    mkdirSync(join(worktree, 'src'), { recursive: true });
    symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(worktree, 'node_modules'));
    writeFileSync(join(worktree, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(worktree, 'eslint.config.mjs'),
      `import {
  createFolderStructure,
  projectStructureParser,
  projectStructurePlugin,
} from 'eslint-plugin-project-structure';

const structure = createFolderStructure({
  structureRoot: 'src',
  structure: { name: 'src', children: [{ name: 'allowed.ts' }] },
});

export default [{
  files: ['src/**/*.ts'],
  languageOptions: { parser: projectStructureParser },
  plugins: { 'project-structure': projectStructurePlugin },
  rules: { 'project-structure/folder-structure': ['error', structure] },
}];
`,
    );
    writeFileSync(join(worktree, 'src', 'wrong.ts'), 'export {};\n');

    const [command, ...args] = structureCmdFor('electron').split(' ');
    const result = spawnSync(command, args, { cwd: worktree, encoding: 'utf8' });

    expect(structureCmdFor('electron')).toContain('--preserve-symlinks');
    expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('wrong.ts');
  });
});
