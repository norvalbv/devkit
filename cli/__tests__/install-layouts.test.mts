// Both spawned-eslint sites against REAL installs behind a linked node_modules (ship worktree shape).
// Run: DEVKIT_INSTALL_LAYOUTS=1 bun run test:run -- install-layouts (first run installs over the network).

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { eslintOverlayContent } from '../lib/install/overlay-lint-configs.mts';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import { overlayStagedStep, runHookFragment } from './_husky-hook-harness.mts';
import {
  INSTALL_LAYOUTS,
  INSTALL_LAYOUTS_ENABLED,
  type InstallLayout,
  installLayout,
} from './_install-layouts.mts';

const DEVKIT_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ESLINT_CONFIG = `import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFolderStructure,
  createIndependentModules,
  projectStructurePlugin,
} from 'eslint-plugin-project-structure';

const structure = createFolderStructure({
  structureRoot: 'src',
  projectRoot: dirname(fileURLToPath(import.meta.url)),
  structure: {
    name: 'src',
    children: [
      { name: 'main', children: [{ name: '{kebab-case}.ts' }] },
      { name: 'renderer', children: [{ name: '{kebab-case}.ts' }] },
    ],
  },
});
const walls = createIndependentModules({
  modules: [
    { name: 'main', pattern: 'src/main/**', allowImportsFrom: ['src/main/**'] },
    { name: 'renderer', pattern: 'src/renderer/**', allowImportsFrom: ['src/renderer/**'] },
  ],
});

export default [{
  files: ['src/**/*.ts'],
  plugins: { 'project-structure': projectStructurePlugin },
  rules: {
    'project-structure/folder-structure': ['error', structure],
    'project-structure/independent-modules': ['error', walls],
  },
}];
`;

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}

/** A staged electron worktree with one misnamed file and one import across a wall. */
function linkedWorktree(layout: InstallLayout): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), `install-layout-${layout}-`)));
  roots.push(cwd);
  mkdirSync(join(cwd, 'src', 'main'), { recursive: true });
  mkdirSync(join(cwd, 'src', 'renderer'));
  symlinkSync(installLayout(layout), join(cwd, 'node_modules'));
  writeFileSync(join(cwd, 'guard.config.json'), '{"scanRoots":["src"]}\n');
  writeFileSync(
    join(cwd, 'package.json'),
    '{"type":"module","devDependencies":{"electron":"^30.0.0"}}\n',
  );
  writeFileSync(join(cwd, 'eslint.config.mjs'), ESLINT_CONFIG);
  writeFileSync(join(cwd, 'eslint.config.devkit.mjs'), eslintOverlayContent('eslint.config.mjs'));
  writeFileSync(join(cwd, 'src', 'renderer', 'view.ts'), 'export const view = 1;\n');
  writeFileSync(
    join(cwd, 'src', 'main', 'entry.ts'),
    "import { view } from '../renderer/view';\nexport const entry = view;\n",
  );
  writeFileSync(join(cwd, 'src', 'main', 'Bad_Name.ts'), 'export {};\n');
  git(cwd, 'init');
  git(cwd, 'add', '--', 'src', 'package.json', 'guard.config.json', 'eslint.config.mjs');
  return cwd;
}

function overlayStep(cwd: string) {
  return runHookFragment(overlayStagedStep(), { cwd });
}

function structureGate(cwd: string) {
  const run = join(DEVKIT_ROOT, 'gate-engine/structure/run.mts');
  return spawnSync(process.execPath, [run, 'staged'], { cwd, encoding: 'utf8' });
}

const SITES = { 'overlay staged eslint': overlayStep, 'guard-structure preset': structureGate };

describe.skipIf(!INSTALL_LAYOUTS_ENABLED)('spawned eslint across real install layouts', () => {
  for (const layout of INSTALL_LAYOUTS) {
    for (const [site, run] of Object.entries(SITES)) {
      it(`${site} on a linked ${layout} install`, () => {
        const result = run(linkedWorktree(layout));
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).not.toContain('Cannot find module');
        if (layout === 'bun-hoisted') {
          expect(result.status, output).toBe(1);
          expect(output).toContain('project-structure/folder-structure');
          expect(output).toContain('project-structure/independent-modules');
        } else {
          // No --preserve-symlinks on an isolated store: the absolute projectRoot still roots the
          // folder rules here, while import walls (which ignore it) never report from this worktree.
          expect(result.status, output).toBe(1);
          expect(output).toContain('project-structure/folder-structure');
          expect(output).not.toContain('project-structure/independent-modules');
          if (site === 'guard-structure preset') {
            expect(output).toContain('import walls (independent-modules) did not run');
          }
        }
      });
    }
  }
});
