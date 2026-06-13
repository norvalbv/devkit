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
 * @returns {'electron'|'next'|'node-service'|'generic'}
 */
export function detectStack(cwd = process.cwd()) {
  const pkg = readJson(join(cwd, 'package.json'));
  if (!pkg) return 'generic';

  // Electron first — an electron app may also pull react, so it must win over 'next'/'generic'.
  if (hasDep(pkg, 'electron') || hasDep(pkg, 'electron-vite')) return 'electron';
  if (hasDep(pkg, 'next')) return 'next';

  // Front-end framework presence rules OUT a headless node service.
  const hasFrontend =
    hasDep(pkg, 'react') || hasDep(pkg, 'vue') || hasDep(pkg, 'svelte') || hasDep(pkg, 'solid-js');
  if (!hasFrontend && pkg.type === 'module') return 'node-service';

  return 'generic';
}
