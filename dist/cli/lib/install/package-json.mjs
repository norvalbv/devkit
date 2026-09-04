/**
 * Patch a consumer's package.json with devkit's devDeps + scripts for the recorded selection.
 * Never overwrites an existing key — a customized script/dep stays the consumer's own.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../fs-helpers.mjs';
// Re-stages the husky runner past its own gitignore on every install, so a fresh `git worktree add`
// always finds it (sync-hook-runner). Guarded: a partial/production install must not fail just
// because the gate tool isn't resolvable.
const PREPARE_SCRIPT = 'husky && (command -v devkit >/dev/null 2>&1 && devkit sync-hook-runner || true)';
// The repo-wide structure sweep. The `.bin` shim cannot carry node flags, and the structure plugin
// derives its project root from its OWN resolved module path — which realpaths out of a checkout
// whose node_modules is a symlink (every ship/agent worktree), silently disabling both walls there.
// Same invocation shape as gate-engine/structure/run.mts, which owns the staged path.
const ELECTRON_STRUCTURE_SCRIPT = 'node --preserve-symlinks node_modules/eslint/bin/eslint.js src';
/** Leading major of a dependency range, tolerating `npm:` aliases (`npm:typescript@7.0.2` -> 7). */
function declaredMajor(range) {
    const version = range.slice(range.lastIndexOf('@') + 1);
    return Number(/^\D*(\d+)/.exec(version)?.[1] ?? 0);
}
/**
 * The structure lane parses SYNTAX only — imports, names, file/function size — never types, so
 * either parser serves it. Which one a consumer CAN run is decided by its compiler:
 * @typescript-eslint/parser reads the TypeScript JavaScript compiler API, and TypeScript 7 ships
 * none, so a TS7 consumer gets the Babel parser instead.
 *
 * Keyed on the DECLARED range because init runs before the consumer installs. A repo holding TS7
 * beside a TS6 library (the documented side-by-side arrangement) declares TS6 here and keeps the
 * TypeScript parser, which is correct — that repo's parser still resolves a compiler API.
 */
export function structureParserDeps(pkg) {
    const declared = pkg.devDependencies?.typescript ?? pkg.dependencies?.typescript ?? '';
    if (declaredMajor(declared) < 7)
        return { '@typescript-eslint/parser': '^8.0.0' };
    return {
        '@babel/core': '^8.0.0',
        '@babel/eslint-parser': '^8.0.0',
        '@babel/plugin-syntax-jsx': '^8.0.0',
        '@babel/preset-typescript': '^8.0.0',
    };
}
// Reason: the branches ARE the per-component devDep/script manifest: each `...(sel.x ? {...} : {})` spread names exactly which deps+scripts a component owns; flattening scatters this single source-of-truth table that remove() mirrors
// fallow-ignore-next-line complexity
export function patchPackageJson(cwd, devkitRef, repoUrl, sel, isStructure, dryRun, stack) {
    const pkgPath = join(cwd, 'package.json');
    const pkg = readJson(pkgPath);
    if (!pkg) {
        console.log('  ! no package.json — skipping devDeps/scripts wiring');
        return;
    }
    // Zero-consumer-dependency model: devkit bundles the gate tools. jscpd is no longer a consumer dep
    // (the clone gate resolves devkit's OWN bundled jscpd), and the config-driven structure gate runs via
    // the `guard-structure` bin (devkit's own eslint + plugin). Only ELECTRON keeps consumer-side
    // eslint/parser/plugin — its preset imports them directly in a consumer eslint.config.mjs + domains.
    const electronPreset = isStructure && stack === 'electron';
    const devDeps = {
        '@norvalbv/devkit': `${repoUrl}#${devkitRef}`,
        ...(sel.biome ? { '@biomejs/biome': '^2.5.0' } : {}),
        ...(sel.husky ? { husky: '^9.1.7' } : {}),
        ...(electronPreset
            ? {
                ...structureParserDeps(pkg),
                eslint: '^10.0.0',
                'eslint-plugin-project-structure': '^3.14.3',
            }
            : {}),
    };
    const scripts = {
        ...(sel.biome ? { lint: 'biome check .', format: 'biome check --write .' } : {}),
        ...(sel.husky ? { prepare: PREPARE_SCRIPT } : {}),
        ...(sel.guards?.includes('fanout') || sel.guards?.includes('size')
            ? { 'guard:freeze': 'guard-fanout freeze && guard-size freeze' }
            : {}),
        ...(electronPreset ? { 'lint:structure': ELECTRON_STRUCTURE_SCRIPT } : {}),
    };
    pkg.devDependencies = pkg.devDependencies ?? {};
    pkg.scripts = pkg.scripts ?? {};
    const added = [];
    for (const [k, v] of Object.entries(devDeps)) {
        if (!pkg.devDependencies[k]) {
            pkg.devDependencies[k] = v;
            added.push(`devDep ${k}`);
        }
    }
    for (const [k, v] of Object.entries(scripts)) {
        if (!pkg.scripts[k]) {
            pkg.scripts[k] = v;
            added.push(`script ${k}`);
        }
    }
    if (added.length === 0) {
        console.log('  • package.json already wired (devDeps + scripts)');
        return;
    }
    if (dryRun) {
        console.log(`  [dry-run] patch package.json: ${added.join(', ')}`);
        return;
    }
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`  ✓ package.json: ${added.join(', ')}`);
}
