// Real installs of the structure-lint stack in each layout a consumer may use, cached across runs.
// Network-bound, so opt-in: DEVKIT_INSTALL_LAYOUTS=1 bun run test:run -- install-layouts

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testSpawnSync as spawnSync } from './_helpers.mts';

export const INSTALL_LAYOUTS_ENABLED = process.env.DEVKIT_INSTALL_LAYOUTS === '1';

const PINS = ['eslint@9.39.5', 'eslint-plugin-project-structure@3.14.5'];

export const INSTALL_LAYOUTS = ['bun-hoisted', 'pnpm', 'bun-isolated'] as const;
export type InstallLayout = (typeof INSTALL_LAYOUTS)[number];

const INSTALLERS = {
  'bun-hoisted': ['bun', ['add', '--linker', 'hoisted', ...PINS]],
  pnpm: ['bunx', ['pnpm@9', 'add', ...PINS]],
  'bun-isolated': ['bun', ['add', '--linker', 'isolated', ...PINS]],
} satisfies Record<InstallLayout, [string, string[]]>;

/** Path of a real node_modules for `layout`, installed once and reused while the pins hold. */
export function installLayout(layout: InstallLayout): string {
  const dir = join(tmpdir(), 'devkit-install-layouts', `${layout}-${PINS.join('-')}`);
  const ready = join(dir, '.ready');
  if (existsSync(ready)) return join(dir, 'node_modules');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"layout-fixture","private":true}\n');
  const [command, args] = INSTALLERS[layout];
  const result = spawnSync(command, [...args], { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${layout} install failed (${result.status}):\n${result.stderr}`);
  }
  writeFileSync(ready, '');
  return join(dir, 'node_modules');
}
