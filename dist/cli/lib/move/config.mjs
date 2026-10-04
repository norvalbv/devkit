import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { ts } from 'ts-morph';
// 18003: include matched nothing. An unknown option (5023) is fatal: a typo cannot be told apart.
const BENIGN_CONFIG_CODES = new Set([18003]);
const STAR_END_RE = /\*$/;
const SLASH_END_RE = /\/$/;
function parseConfig(tsPath, cwd) {
    const read = ts.readConfigFile(tsPath, (p) => ts.sys.readFile(p));
    if (read.error)
        throw new Error(`could not read ${relative(cwd, tsPath)}: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`);
    return ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsPath), undefined, tsPath);
}
function aliasesOf(options, cwd) {
    const base = options.baseUrl ?? options.pathsBasePath ?? cwd;
    // Exact-match keys and empty target lists name no directory a moved file could land under.
    // Every target counts: tsc falls back through them in order, so any may be the one resolved.
    return (Object.entries(options.paths ?? {})
        // `@/*`, `@*` and a bare `*` (prefix '') all name a prefix; a bare specifier that the alias
        // does not reach still resolves to a package, which the rewrite never touches.
        .filter(([k]) => k.endsWith('*'))
        .flatMap(([k, targets]) => 
    // Only a trailing `*` names a directory; `src/*/index.ts` maps to no single root.
    targets
        .filter((t) => t.indexOf('*') === t.length - 1)
        .map((t) => ({
        prefix: k.replace(STAR_END_RE, ''),
        root: resolve(base, t.replace(STAR_END_RE, '').replace(SLASH_END_RE, '')),
    }))));
}
function parseProject(cfgPath, cwd) {
    // A project tsc would type-check but this cannot read leaves its importers unplanned.
    if (!existsSync(cfgPath))
        throw new Error(`could not read referenced project ${relative(cwd, cfgPath)}: file not found`);
    const sub = parseConfig(cfgPath, cwd);
    const fault = sub.errors.find((d) => !BENIGN_CONFIG_CODES.has(d.code));
    if (fault)
        throw new Error(`could not read ${relative(cwd, cfgPath)}: ${ts.flattenDiagnosticMessageText(fault.messageText, ' ')}`);
    return sub;
}
/** The root and every project it references, transitively, each kept with its own options. */
function referencedScopes(root, cwd) {
    const scopes = [];
    const seen = new Set();
    const queue = [...(root.projectReferences ?? [])];
    for (let i = 0; i < queue.length; i++) {
        const cfgPath = ts.resolveProjectReferencePath(queue[i]);
        if (seen.has(cfgPath))
            continue;
        seen.add(cfgPath);
        const sub = parseProject(cfgPath, cwd);
        const options = { ...sub.options };
        delete options.configFilePath;
        scopes.push({ options, aliases: aliasesOf(options, dirname(cfgPath)), files: sub.fileNames });
        queue.push(...(sub.projectReferences ?? []));
    }
    return scopes;
}
/** Adds the `--alias=PREFIX=DIR` mapping to a project, as an absolute target that needs no base. */
function applyOverride(scope, alias, cwd) {
    scope.options.paths = { ...scope.options.paths, [`${alias.prefix}*`]: [`${alias.root}/*`] };
    scope.options.pathsBasePath ??= cwd;
    scope.aliases.unshift(alias);
}
/** Reads tsconfig the way tsc does: `extends` chain, JSONC, include globs and project references. */
export function readProjectConfig(cwd, override) {
    const tsPath = join(cwd, 'tsconfig.json');
    if (!existsSync(tsPath))
        throw new Error(`could not read ${relative(cwd, tsPath)}: file not found`);
    const parsed = parseConfig(tsPath, cwd);
    const options = { ...parsed.options };
    delete options.configFilePath;
    const aliases = aliasesOf(options, cwd);
    // Any real diagnostic is fatal: the file list and paths it corrupts are what the plan runs on.
    const fault = parsed.errors.find((d) => !BENIGN_CONFIG_CODES.has(d.code));
    if (fault) {
        const where = fault.file ? relative(cwd, fault.file.fileName) : relative(cwd, tsPath);
        throw new Error(`could not read ${where}: ${ts.flattenDiagnosticMessageText(fault.messageText, ' ')}`);
    }
    const scopes = [{ options, aliases, files: parsed.fileNames }, ...referencedScopes(parsed, cwd)];
    if (override !== undefined) {
        const eq = override.indexOf('=');
        const [prefix, dir] = eq < 0 ? [override, ''] : [override.slice(0, eq), override.slice(eq + 1)];
        // An empty PREFIX would be a bare `*` mapping that claims every package import.
        const bare = prefix.replace(STAR_END_RE, '');
        if (!dir || !bare || bare.includes('*'))
            throw new Error(`--alias needs PREFIX=DIR, got --alias=${override}`);
        for (const scope of scopes)
            applyOverride(scope, { prefix: bare, root: resolve(cwd, dir) }, cwd);
    }
    const owner = new Map();
    for (const scope of scopes)
        for (const f of scope.files)
            if (!owner.has(f))
                owner.set(f, scope);
    // A solution-style root type-checks nothing, so a file no project claims falls to a real one.
    const fallback = scopes.find((sc) => sc.files.length) ?? scopes[0];
    return {
        scopes,
        files: [...owner.keys()],
        scopeOf: (file) => owner.get(file) ?? fallback,
    };
}
