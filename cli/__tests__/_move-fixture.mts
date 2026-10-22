/** Throwaway-repo fixture shared by the `devkit move` suites; `_`-prefixed so vitest never runs it. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI, rootRegistry, testSpawnSync } from './_helpers.mts';

export const { mkTmp, cleanup } = rootRegistry();

export const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });

export const DEFAULT_TSCONFIG = JSON.stringify({
  compilerOptions: { paths: { '@/*': ['./src/renderer/*'] } },
  include: ['src'],
});

export const writePath = (root, rel, content) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
};

export function fixture(tsconfigText = DEFAULT_TSCONFIG) {
  const root = mkTmp('move-');
  writePath(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0', type: 'module' }));
  writePath(root, 'tsconfig.json', tsconfigText);
  // the file to move + a non-moved dependency it imports relatively (tests re-anchor)
  writePath(
    root,
    'src/renderer/features/a/util.ts',
    "import { helper } from './helper';\nexport const x = helper;\n",
  );
  writePath(root, 'src/renderer/features/a/helper.ts', 'export const helper = 1;\n');
  // colocated test sibling — moves WITH util
  writePath(
    root,
    'src/renderer/features/a/util.test.ts',
    "import { x } from './util';\nexport const t = x;\n",
  );
  // relative importer (same dir) + alias importer (other feature)
  writePath(
    root,
    'src/renderer/features/a/sibling.ts',
    "import { x } from './util';\nexport const y = x;\n",
  );
  writePath(
    root,
    'src/renderer/features/b/use.ts',
    "import { x } from '@/features/a/util';\nexport const z = x;\n",
  );
  // vi.mock + dynamic import string args
  writePath(
    root,
    'src/renderer/features/c/c.test.ts',
    "import { vi } from 'vitest';\nvi.mock('@/features/a/util');\nexport const load = () => import('@/features/a/util');\n",
  );
  writePath(
    root,
    '.devkit/baselines/structure/renderer.mjs',
    'export const rendererStructureBaseline = [\n  "features/a/util.ts",\n  "features/a/util.test.ts",\n  "keep/other.ts"\n];\n',
  );
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  return root;
}

export const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
export const runMoveArgs = (cwd, ...args) =>
  testSpawnSync(process.execPath, [CLI, 'move', ...args], { cwd, encoding: 'utf8' });
// A readiness wait, not a speed assertion: tsconfig is now read and walked before the first git call.
export const waitForPath = async (path) => {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
};

export const MOVE_ARGS = ['move', 'src/renderer/features/a/util.ts', 'src/renderer/lib/utils'];
export const runMove = (root, ...extra) =>
  testSpawnSync(process.execPath, [CLI, ...MOVE_ARGS, ...extra], { cwd: root, encoding: 'utf8' });

/** A `git` on PATH that runs `onMv` (shell) before every `git mv`, to edit files mid-move. */
export const fakeGit = (root: string, onMv: string) => {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writePath(
    root,
    'bin/git',
    `#!/bin/sh\nif [ "$1" = "mv" ]; then\n${onMv}\nfi\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(join(root, 'bin/git'), 0o755);
  return { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` };
};
