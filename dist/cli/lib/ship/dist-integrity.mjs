#!/usr/bin/env node
/**
 * Self-host ship preflight for devkit's force-tracked, gitignored dist/ tree.
 *
 * The ephemeral ship worktree cannot see ignored files the caller forgot to brief. Inspect the
 * caller checkout before that worktree exists, while its physical build output and real Git index
 * are both available. Consumer repos no-op: this is devkit's own release topology, not a portable
 * guard.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { filesUnder, isDevkitShipRepo, repoPath } from "./integrity-files.mjs";
const CLEAN_REPORT = {
    active: false,
    unresolved: [],
    unbriefed: [],
    untracked: [],
};
function git(root, args) {
    const raw = execFileSync('git', ['-C', root, ...args]);
    return raw.toString('utf8').split('\0').filter(Boolean);
}
function importTarget(root, importer, specifier) {
    const importerUrl = pathToFileURL(path.join(root, importer));
    return repoPath(root, fileURLToPath(new URL(specifier, importerUrl)));
}
function generatedPath(briefedPath) {
    const normalized = briefedPath.split(path.sep).join('/');
    if (normalized.startsWith('dist/'))
        return normalized;
    if (!normalized.startsWith('cli/') && !normalized.startsWith('gate-engine/'))
        return undefined;
    return normalized.endsWith('.mts')
        ? `dist/${normalized.slice(0, -'.mts'.length)}.mjs`
        : `dist/${normalized}`;
}
/**
 * Inspect the caller's physical dist tree, Git index, and ship briefing.
 * `base` is the commit the ship worktree would be cut from.
 */
export async function inspectDistIntegrity(root, base, briefedPaths) {
    if (!isDevkitShipRepo(root))
        return { ...CLEAN_REPORT };
    const physical = filesUnder(root, 'dist');
    const tracked = new Set(git(root, ['ls-files', '--cached', '-z', '--', 'dist']));
    const briefed = new Set(briefedPaths.map((file) => file.split(path.sep).join('/')));
    // Shared checkouts can contain another agent's generated output. Seed the scan from this ship's
    // explicit source/dist paths, then follow only their tracked relative-import graph.
    const required = new Set([...briefed].map(generatedPath).filter((file) => file !== undefined));
    // This dependency is dev-only and intentionally loaded only for devkit self-hosting. Installed
    // consumer copies execute the no-op return above and never need es-module-lexer at runtime.
    const { init, parse } = await import('es-module-lexer');
    await init;
    const unresolved = [];
    const queue = [...required].filter((file) => file.endsWith('.mjs')).sort();
    const parsed = new Set();
    while (queue.length > 0) {
        const importer = queue.shift();
        if (!importer || parsed.has(importer))
            continue;
        parsed.add(importer);
        const absolute = path.join(root, importer);
        if (!tracked.has(importer) || !existsSync(absolute))
            continue;
        const [imports] = parse(readFileSync(absolute, 'utf8'), importer);
        for (const item of imports) {
            // `n` is populated for static and string-literal dynamic imports. It is undefined for
            // expressions/templates such as import(`./${name}.mjs`), which cannot be resolved here.
            const specifier = item.n;
            if (!specifier?.startsWith('.'))
                continue;
            const target = importTarget(root, importer, specifier);
            required.add(target);
            if (!tracked.has(target) || !existsSync(path.join(root, target))) {
                unresolved.push({ importer, specifier, target });
            }
            else if (target.endsWith('.mjs') && !parsed.has(target)) {
                queue.push(target);
            }
        }
    }
    const untracked = physical.filter((file) => required.has(file) && !tracked.has(file));
    const added = git(root, ['diff', '--name-only', '-z', '--diff-filter=A', base, '--', 'dist']);
    const unbriefed = added.filter((file) => required.has(file) && !briefed.has(file)).sort();
    unresolved.sort((a, b) => `${a.importer}\0${a.specifier}`.localeCompare(`${b.importer}\0${b.specifier}`));
    return { active: true, unresolved, unbriefed, untracked };
}
function shellQuote(value) {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
export function printDistIntegrityFailure(report) {
    if (!report.active)
        return 0;
    const failed = report.untracked.length > 0 || report.unbriefed.length > 0 || report.unresolved.length > 0;
    if (!failed)
        return 0;
    console.error('✗ devkit ship: dist integrity preflight failed.');
    if (report.untracked.length > 0) {
        console.error('  Generated dist artifacts are absent from the Git index:');
        for (const file of report.untracked)
            console.error(`    ${file}`);
        console.error(`  Fix: git add -f -- ${report.untracked.map(shellQuote).join(' ')}`);
    }
    if (report.unbriefed.length > 0) {
        console.error('  Newly tracked dist artifacts are omitted from this ship:');
        for (const file of report.unbriefed)
            console.error(`    ${file}`);
    }
    if (report.unresolved.length > 0) {
        console.error('  Relative imports do not resolve to tracked dist files:');
        for (const item of report.unresolved) {
            console.error(`    ${item.importer}: ${item.specifier} -> ${item.target}`);
        }
    }
    if (report.untracked.length > 0 || report.unbriefed.length > 0) {
        const paths = [...new Set([...report.untracked, ...report.unbriefed])];
        console.error(`  Include after -- in the next devkit ship: ${paths.map(shellQuote).join(' ')}`);
    }
    return 1;
}
function parseArgs(argv) {
    let root = '';
    let base = '';
    let i = 0;
    for (; i < argv.length; i++) {
        if (argv[i] === '--') {
            i++;
            break;
        }
        if (argv[i] === '--root' && argv[i + 1])
            root = argv[++i];
        else if (argv[i] === '--base' && argv[i + 1])
            base = argv[++i];
        else
            throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    }
    if (!root || !base)
        throw new Error('usage: dist-integrity --root <root> --base <sha> -- <paths>');
    return { base, paths: argv.slice(i), root };
}
async function main() {
    try {
        const { base, paths, root } = parseArgs(process.argv.slice(2));
        process.exitCode = printDistIntegrityFailure(await inspectDistIntegrity(root, base, paths));
    }
    catch (error) {
        console.error(`✗ devkit ship: dist integrity preflight could not run — ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    void main();
}
