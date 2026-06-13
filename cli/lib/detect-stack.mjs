/**
 * Stack detection from a consumer's package.json. Decides which devkit template set +
 * (later) which structure-lint preset a repo gets. Phase 1 only WIRES the generic
 * stack; the returned stack name lets `init --stack` default sensibly and lets a
 * future phase branch on it without re-detecting.
 */

import { join } from 'node:path';
import { readJson } from './fs-helpers.mjs';

// A dep is "present" if it appears in dependencies OR devDependencies.
function hasDep(pkg, name) {
  return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
}

/**
 * @param {string} cwd consumer repo root
 * @returns {'electron'|'next'|'react-app'|'node-service'|'generic'}
 */
export function detectStack(cwd = process.cwd()) {
  const pkg = readJson(join(cwd, 'package.json'));
  if (!pkg) return 'generic';

  // Electron first — an electron app may also pull react, so it must win over 'next'/'react-app'.
  if (hasDep(pkg, 'electron') || hasDep(pkg, 'electron-vite')) return 'electron';
  if (hasDep(pkg, 'next')) return 'next';

  // React (not next/electron) → the react-app structure preset. NOTE: this reads the manifest
  // at `cwd`, so a monorepo-style repo whose React lives in a SUBDIR (e.g. services/webapp,
  // with the root manifest framework-less) still detects 'generic' at the root — install in
  // that subdir, or pass `--stack react-app` + `--scan-root <subdir>/src` at the root.
  if (hasDep(pkg, 'react')) return 'react-app';

  // A non-React front-end framework still rules OUT a headless node service (no preset → generic).
  const hasOtherFrontend = hasDep(pkg, 'vue') || hasDep(pkg, 'svelte') || hasDep(pkg, 'solid-js');
  if (!hasOtherFrontend && pkg.type === 'module') return 'node-service';

  return 'generic';
}
