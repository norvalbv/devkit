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
export function detectStack(cwd = process.cwd()) {
    // readJson is a JSON.parse boundary — assert the parsed manifest's shape here.
    const pkg = readJson(join(cwd, 'package.json'));
    if (!pkg)
        return 'generic';
    // Electron first — an electron app may also pull react, so it must win over 'next'/'react-app'.
    if (hasDep(pkg, 'electron') || hasDep(pkg, 'electron-vite'))
        return 'electron';
    if (hasDep(pkg, 'next'))
        return 'next';
    // A component/primitives LIBRARY (not an app): React as a PEER dependency (the lib is consumed,
    // not run) + a package surface (`exports`/`main`/`module`). Flat PascalCase src/ → component-lib
    // preset. Must precede the plain-react check (a lib has react in BOTH peer and dev).
    const isPublishedLib = Boolean(pkg.exports || pkg.main || pkg.module);
    if (pkg.peerDependencies?.react && isPublishedLib)
        return 'component-lib';
    // React (not next/electron/lib) → the react-app structure preset. NOTE: this reads the manifest
    // at `cwd`, so a monorepo-style repo whose React lives in a SUBDIR (e.g. services/webapp,
    // with the root manifest framework-less) still detects 'generic' at the root — install in
    // that subdir, or pass `--stack react-app` + `--scan-root <subdir>/src` at the root.
    if (hasDep(pkg, 'react'))
        return 'react-app';
    // A non-React front-end framework still rules OUT a headless node service (no preset → generic).
    const hasOtherFrontend = hasDep(pkg, 'vue') || hasDep(pkg, 'svelte') || hasDep(pkg, 'solid-js');
    if (!hasOtherFrontend && pkg.type === 'module')
        return 'node-service';
    return 'generic';
}
