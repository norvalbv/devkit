// Real installs of the structure-lint stack in each layout a consumer may use, cached across runs.
// Network-bound, so opt-in: DEVKIT_INSTALL_LAYOUTS=1 bun run test:run -- install-layouts

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

/** Links cwd/node_modules to a stub isolated store whose eslint echoes its argv and exits `exitCode`. */
export function linkStubIsolatedInstall(cwd: string, exitCode = 0): string {
  const donor = mkdtempSync(join(tmpdir(), 'isolated-store-'));
  const eslint = join(donor, 'node_modules', '.bun', 'eslint', 'node_modules', 'eslint');
  mkdirSync(join(eslint, 'bin'), { recursive: true });
  writeFileSync(
    join(eslint, 'bin', 'eslint.js'),
    `process.stdout.write(JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = ${exitCode};\n`,
  );
  symlinkSync(eslint, join(donor, 'node_modules', 'eslint'));
  symlinkSync(join(donor, 'node_modules'), join(cwd, 'node_modules'));
  return donor;
}

/** Links cwd/node_modules to an isolated-shaped store whose eslint and plugin are links into `modules`. */
export function linkIsolatedInstall(cwd: string, modules: string): string {
  const donor = mkdtempSync(join(tmpdir(), 'isolated-store-'));
  mkdirSync(join(donor, 'node_modules'));
  for (const pkg of ['eslint', 'eslint-plugin-project-structure']) {
    symlinkSync(join(modules, pkg), join(donor, 'node_modules', pkg));
  }
  symlinkSync(join(donor, 'node_modules'), join(cwd, 'node_modules'));
  return donor;
}
