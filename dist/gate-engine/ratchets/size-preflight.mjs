import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGuardConfig, sourceMatchers } from "../config.mjs";
import { LEGACY_LINES_BASELINE, readRatchetBaseline } from "./baseline-paths.mjs";
import { gitPrefix, stagedSet } from "./git-index.mjs";
import { LINES_BASELINE, SIZE_SKIP_DIRS } from "./size-policy.mjs";
function readLinesBaseline(contents) {
    if (contents === null)
        return { files: {} };
    // SAFETY: baseline JSON is Devkit-owned; missing/legacy fields are normalized below.
    const parsed = JSON.parse(contents);
    return { files: parsed.files ?? {} };
}
function gitShowBaseline(root, ref, path) {
    try {
        return execFileSync('git', ['show', `${ref}:${path}`], {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    }
    catch {
        return null;
    }
}
function readLinesBaselineAtRef(root, ref) {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    const prefix = gitPrefix(root);
    const text = gitShowBaseline(root, ref, `${prefix}${LINES_BASELINE}`) ??
        gitShowBaseline(root, ref, `${prefix}${LEGACY_LINES_BASELINE}`);
    if (text === null)
        return null;
    const parsed = JSON.parse(text);
    return { files: parsed.files ?? {} };
}
function sourcePaths(root, cfg, selected) {
    const match = sourceMatchers(cfg.sourceExtensions);
    return selected.filter((file) => existsSync(join(root, file)) &&
        match.isSource(file) &&
        !file.split('/').some((part) => SIZE_SKIP_DIRS.has(part)) &&
        cfg.scanRoots.some((scanRoot) => file === scanRoot || file.startsWith(`${scanRoot}/`)));
}
// Compare the caller's current bytes with the raw-line baseline from the exact ref a ship will use.
// A missing ref baseline is an overlay/untracked baseline, which ship links from the working copy.
export function preflightLines(root, ref, requested = []) {
    let cfg;
    let local;
    try {
        cfg = resolveGuardConfig(root);
        if (!cfg.maxLines && !cfg.maxTestLines)
            return 0;
        local = readLinesBaseline(readRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE)?.contents ?? null);
    }
    catch (error) {
        console.error(`guard-size preflight unavailable: ${String(error)}`);
        return 2;
    }
    let committed;
    try {
        committed = readLinesBaselineAtRef(root, ref);
    }
    catch (error) {
        console.error(`guard-size preflight unavailable at ${ref}: ${String(error)}`);
        return 2;
    }
    const match = sourceMatchers(cfg.sourceExtensions);
    const cap = (file) => (match.isTest(file) ? cfg.maxTestLines : cfg.maxLines);
    const selected = requested.length > 0 ? requested : [...(stagedSet(root) ?? [])];
    const baselineIncluded = selected.some((file) => file === LINES_BASELINE || file === LEGACY_LINES_BASELINE);
    const files = sourcePaths(root, cfg, selected).filter((file) => cap(file) > 0);
    if (files.length === 0) {
        if (requested.length === 0) {
            console.error('guard-size preflight: no staged source files (pass paths after `--`).');
            return 2;
        }
        console.log(`guard-size preflight: no source files in scope: ${requested.join(', ')}`);
        return 0;
    }
    const usesWorkingBaseline = baselineIncluded || !committed;
    const baseline = usesWorkingBaseline ? local : (committed ?? local);
    const baselineLabel = usesWorkingBaseline ? 'working tree' : ref;
    let rows;
    try {
        rows = files.map((file) => {
            const lines = readFileSync(join(root, file), 'utf8').split('\n').length;
            const ceiling = Math.max(cap(file), baseline.files[file] ?? 0);
            const localCeiling = Math.max(cap(file), local.files[file] ?? 0);
            return { file, lines, ceiling, headroom: ceiling - lines, localCeiling };
        });
    }
    catch (error) {
        console.error(`guard-size preflight unavailable while reading source files: ${String(error)}`);
        return 2;
    }
    console.log(`guard-size preflight — effective ceilings from ${baselineLabel}`);
    for (const row of rows) {
        const drift = committed && row.localCeiling !== row.ceiling
            ? `; working-tree max ${row.localCeiling} differs by ${row.localCeiling - row.ceiling}`
            : '';
        console.log(`   ${row.file}: ${row.lines} lines; max ${row.ceiling}; headroom ${row.headroom}${drift}`);
    }
    const grew = rows.filter((row) => row.headroom < 0);
    if (grew.length === 0)
        return 0;
    console.error(`🚫 ${grew.length} file(s) exceed the line limit from ${baselineLabel}:`);
    for (const row of grew) {
        const drift = committed && row.localCeiling !== row.ceiling
            ? `; working-tree baseline would allow ${row.localCeiling}`
            : '';
        console.error(`   ${row.file}: ${row.lines} lines (max ${row.ceiling}${drift})`);
    }
    return 1;
}
export function runPreflightCli(args) {
    if (args[0] !== '--base' || !args[1] || (args.length > 2 && args[2] !== '--')) {
        console.error('usage: guard-size preflight --base <ref> [-- path...]');
        process.exit(2);
    }
    process.exit(preflightLines(process.cwd(), args[1], args.slice(3)));
}
