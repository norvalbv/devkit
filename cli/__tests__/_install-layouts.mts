// Real installs of the structure-lint stack in each layout a consumer may use, fresh every run.
// Network-bound, so opt-in: DEVKIT_INSTALL_LAYOUTS=1 bun run test:run -- install-layouts

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

// Per run, never across runs: macOS reaps $TMPDIR files by atime, gutting a cached install.
const installs = new Map<InstallLayout, string>();
let installRoot: string | undefined;

/** Path of a real node_modules for `layout`, installed on first use in this run. */
export function installLayout(layout: InstallLayout): string {
  const installed = installs.get(layout);
  if (installed) return installed;
  installRoot ??= mkdtempSync(join(tmpdir(), 'devkit-install-layouts-'));
  const dir = join(installRoot, layout);
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), '{"name":"layout-fixture","private":true}\n');
  const [command, args] = INSTALLERS[layout];
  const result = spawnSync(command, [...args], { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${layout} install of ${PINS.join(' ')} failed (${result.status}):\n${result.stderr}`,
    );
  }
  installs.set(layout, join(dir, 'node_modules'));
  return join(dir, 'node_modules');
}

/** Removes every install this run made. */
export function removeInstallLayouts(): void {
  if (installRoot) rmSync(installRoot, { recursive: true, force: true });
  installRoot = undefined;
  installs.clear();
}

/** Links cwd/node_modules to a stub isolated store (eslint itself a link); returns the donor to clean up. */
export function linkStubIsolatedInstall(cwd: string): string {
  const donor = mkdtempSync(join(tmpdir(), 'isolated-store-'));
  const eslint = join(donor, 'node_modules', '.bun', 'eslint', 'node_modules', 'eslint');
  mkdirSync(join(eslint, 'bin'), { recursive: true });
  writeFileSync(join(eslint, 'bin', 'eslint.js'), "process.stdout.write('[]');\n");
  symlinkSync(eslint, join(donor, 'node_modules', 'eslint'));
  symlinkSync(join(donor, 'node_modules'), join(cwd, 'node_modules'));
  return donor;
}
