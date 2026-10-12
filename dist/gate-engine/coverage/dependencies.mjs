/** Whether every declared direct dependency has a package.json under node_modules, and which install
 * fixes it when not. Shared by `devkit ship` and `devkit coverage-run`. */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, matchesGlob, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { shellWord } from '../review/valve/shell-word.mjs';
/** Only the names matter; a non-object section is still an error, as it always was. */
const manifestSchema = z.object({
    dependencies: z.record(z.string(), z.unknown()).optional(),
    devDependencies: z.record(z.string(), z.unknown()).optional(),
});
const LOCKFILES = [
    'bun.lock',
    'bun.lockb',
    'pnpm-lock.yaml',
    'yarn.lock',
    'package-lock.json',
    'npm-shrinkwrap.json',
];
const validPart = (part) => part.length > 0 && part !== '.' && part !== '..' && !part.includes('\\');
function safePackageParts(name) {
    const parts = name.split('/');
    const [scope = '', pkg] = parts;
    const valid = parts.length === 1
        ? !name.startsWith('@') && validPart(scope)
        : parts.length === 2 && scope.length > 1 && scope.startsWith('@') && parts.every(validPart);
    if (!valid)
        throw new Error(`invalid dependency name in package.json: ${JSON.stringify(name)}`);
    return pkg === undefined ? [scope] : [scope, pkg];
}
function declaredDependencies(manifestText) {
    const parsed = manifestSchema.safeParse(JSON.parse(manifestText));
    if (!parsed.success)
        throw new Error('dependencies and devDependencies must be objects');
    const { dependencies = {}, devDependencies = {} } = parsed.data;
    const names = new Set([...Object.keys(dependencies), ...Object.keys(devDependencies)]);
    for (const name of names)
        safePackageParts(name);
    return [...names].sort();
}
/** Declared root dependencies absent from `nodeModulesPath`; empty when package.json is absent. */
export function missingDeclaredDependencies(manifestPath, nodeModulesPath) {
    if (!existsSync(manifestPath))
        return [];
    return declaredDependencies(readFileSync(manifestPath, 'utf8')).filter((name) => !existsSync(join(nodeModulesPath, ...safePackageParts(name), 'package.json')));
}
/** The frozen-lockfile install command for the checkout at `dir` (mirrors gate_dependency_install_remedy). */
export function dependencyInstallRemedy(dir) {
    const has = (name) => existsSync(join(dir, name));
    if (has('bun.lock') || has('bun.lockb'))
        return 'bun install --frozen-lockfile';
    if (has('pnpm-lock.yaml'))
        return 'pnpm install --frozen-lockfile';
    if (has('yarn.lock'))
        return 'yarn install --immutable';
    if (has('package-lock.json') || has('npm-shrinkwrap.json'))
        return 'npm ci';
    return "install dependencies with this repo's package manager";
}
/** One pattern per runtime wording; each captures the specifier, then the importer to end of line. */
const MISSING_MODULE_PATTERNS = [
    /Cannot find package '([^']+)' imported from (.+)$/m, // node ESM
    /Cannot find module '([^']+)'[^]*?Require stack:\s*\n- (.+)$/m, // node CJS
    /Failed to resolve import "([^"]+)" from "([^"]+)"/, // vite import analysis
    /Failed to load url (\S+) \(resolved id: [^)]*\) in (.+?)(?:\. Does the file exist\?)?$/m, // vitest
];
export function missingModule(message) {
    for (const pattern of MISSING_MODULE_PATTERNS) {
        const [, specifier, importer] = pattern.exec(message) ?? [];
        if (!specifier || !importer)
            continue;
        return {
            specifier,
            importer: importer.startsWith('file://') ? fileURLToPath(importer) : importer,
        };
    }
    return null;
}
/** The package a bare specifier names, or null for a path, a URL scheme, or a bundler alias. */
function packageName(specifier) {
    return /^(?:@[\w.-]+\/)?[\w-][\w.-]*/.exec(specifier.includes(':') ? '' : specifier)?.[0] ?? null;
}
const globs = z.array(z.string());
const declarationSchema = manifestSchema.extend({
    peerDependencies: z.record(z.string(), z.unknown()).optional(),
    optionalDependencies: z.record(z.string(), z.unknown()).optional(),
    workspaces: z.union([globs, z.object({ packages: globs.optional() })]).optional(),
});
/** The manifest in `dir`, or null when it is absent or unreadable: it then declares nothing. */
function readDeclarations(dir) {
    try {
        return declarationSchema.parse(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')));
    }
    catch {
        return null;
    }
}
function declaresPackage(manifest, name) {
    const { dependencies, devDependencies, peerDependencies, optionalDependencies } = manifest;
    return [dependencies, devDependencies, peerDependencies, optionalDependencies].some((section) => section !== undefined && Object.hasOwn(section, name));
}
/** Whether `manifest`'s `workspaces` globs list the package at `member` (relative, posix). */
function listsWorkspace(manifest, member) {
    const { workspaces = [] } = manifest;
    const patterns = (Array.isArray(workspaces) ? workspaces : (workspaces.packages ?? [])).map((pattern) => pattern.replace(/\/+$/, ''));
    const matches = (pattern) => matchesGlob(member, pattern);
    return (patterns.some((pattern) => !pattern.startsWith('!') && matches(pattern)) &&
        !patterns.some((pattern) => pattern.startsWith('!') && matches(pattern.slice(1))));
}
/** realpath where possible: vitest reports /private/var for a file under /var on macOS. */
export const canonicalPath = (p) => {
    try {
        return realpathSync(p);
    }
    catch {
        return resolve(p);
    }
};
/** Whether node would resolve package `name` from `dir`: some node_modules at or above it holds it. */
function resolvesFrom(dir, name) {
    for (let at = dir;; at = dirname(at)) {
        if (existsSync(join(at, 'node_modules', name, 'package.json')))
            return true;
        if (at === dirname(at))
            return false;
    }
}
/** The nearest directory above the importer whose install would provide the missing package: it has
 * a lockfile, and it or a workspace member it lists declares the package. Never climbs past `root`. */
export function installDirFor(missing, root) {
    const name = packageName(missing.specifier);
    if (!name)
        return null;
    const top = canonicalPath(root);
    let dir = canonicalPath(dirname(resolve(top, missing.importer)));
    // Already installed: the error is a missing subpath or export, which no install fixes.
    if (resolvesFrom(dir, name))
        return null;
    // An installed package's own imports are its install's business, whoever declares them.
    const installed = dir.split(/[\\/]/).includes('node_modules');
    let declarer = null;
    while (!relative(top, dir).startsWith('..')) {
        const manifest = dir.split(/[\\/]/).includes('node_modules') ? null : readDeclarations(dir);
        if (manifest) {
            const declares = installed || declaresPackage(manifest, name);
            const member = declarer && relative(dir, declarer).replaceAll('\\', '/');
            const provides = declares || (member !== null && listsWorkspace(manifest, member));
            if (provides && LOCKFILES.some((lock) => existsSync(join(dir, lock))))
                return dir;
            if (declares)
                declarer ??= dir;
        }
        if (dir === top)
            return null;
        dir = dirname(dir);
    }
    return null;
}
/** The install command that fixes a module-not-found collection error, or null when none is named. */
export function collectionRemedy(message, cwd) {
    const missing = missingModule(message);
    const dir = missing && installDirFor(missing, cwd);
    if (!dir)
        return null;
    const rel = relative(canonicalPath(cwd), dir);
    const install = dependencyInstallRemedy(dir);
    return rel ? `(cd ${shellWord(rel)} && ${install})` : install;
}
/** Said before the suite: a declared dependency resolves from no node_modules at or above `cwd`.
 * Warns, never blocks. */
export function formatMissingRootDependencies(cwd) {
    let missing;
    try {
        missing = missingDeclaredDependencies(join(cwd, 'package.json'), join(cwd, 'node_modules'));
    }
    catch {
        return [];
    }
    // A workspace member's dependencies are hoisted into an ancestor's node_modules.
    missing = missing.filter((name) => !resolvesFrom(dirname(resolve(cwd)), name));
    if (missing.length === 0)
        return [];
    const shown = missing.slice(0, 10).join(', ') + (missing.length > 10 ? ', …' : '');
    return [
        `⚠️  ${missing.length} declared dependenc${missing.length === 1 ? 'y is' : 'ies are'} not installed: ${shown}`,
        LOCKFILES.some((lock) => existsSync(join(cwd, lock)))
            ? `   Test files importing them will fail to load. Run \`${dependencyInstallRemedy(cwd)}\` first.`
            : '   Test files importing them will fail to load. Install them first.',
    ];
}
