#!/usr/bin/env node
/**
 * Import-wall baseline generator — the shrink-only grandfather list for the
 * renderer import walls (project-structure/independent-modules).
 *
 * WHY SCAN MODE IS CORRECT HERE (the opposite of the structure generator): the
 * independent-modules rule, run with debugMode on, emits ONE message PER FILE
 * carrying its offending `Import path = "…"`. There is no enforceExistence dedup
 * to defeat, so re-running eslint and parsing its JSON captures every violator
 * faithfully. (folder-structure DOES dedup, which is why that generator is a
 * manual walker — see generate-structure-baseline.mjs.)
 *
 * HOW: re-runs the consumer's eslint with DEVKIT_IMPORTS_BASELINE_SCAN=1 (the
 * template eslint.config.mjs drops the generated grandfather entries + flips the
 * plugin's debugMode so error text carries the import path), then emits one
 * module entry per offending file with the MINIMAL widenings it needs. First
 * match wins in the plugin, so the config spreads these before the generic walls.
 *
 * Loud-failure guards (never silently widen):
 *   - a violating message without a parseable import path  -> throw
 *   - an import path that fits no known wall class          -> throw
 *   - any 'Cannot find module' resolution error             -> throw
 *
 * PARAMETERIZED (W-3): the wall pattern classes (frozen dirs, feature folders,
 * cross-process prefixes) and the renderer base reference name are config-derived;
 * eslint runs against the CONSUMER cwd with the CONSUMER's eslint binary.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGuardConfig } from '../../../gate-engine/config.mjs';
const OUT = 'eslint/baselines/imports.mjs';
const RULE = 'project-structure/independent-modules';
const IMPORT_PATH_RE = /Import path\s*=\s*"([^"]+)"/;
// Default wall pattern classes — the electron-stack shape (mirrors frink). A
// consumer with different walls passes its own via opts.walls.
export const DEFAULT_WALLS = Object.freeze({
    // Cross-process prefixes: a renderer import of any of these widens to the prefix glob.
    crossProcess: [
        { prefix: 'src/main/', widening: 'src/main/**' },
        { prefix: 'src/preload', widening: 'src/preload/**' },
    ],
    // Frozen legacy dirs (consumption banned until migrated) — capture group 1 = dir name.
    frozenDirRe: '^src/renderer/(utils|types|constants|contexts)/',
    // Feature-internal deep imports (barrel-only from outside) — group 1 = feature name.
    featureRe: '^src/renderer/features/([^/]+)/',
    // The reusable-import-pattern name every grandfather entry keeps as its base.
    baseRef: '{renderer_base}',
    // eslint globs to scan.
    lintGlobs: ['src/renderer/**/*.{ts,tsx}', 'src/shared/**/*.ts'],
    // Export name in the emitted .mjs.
    exportName: 'rendererImportWallBaseline',
});
export function parseImportPath(message) {
    return message.match(IMPORT_PATH_RE)?.[1] ?? null;
}
/**
 * Map a violating (root-relative, resolved) import path to the minimal
 * allowImportsFrom widening that legalizes it. Returns null for an unknown wall
 * class (caller must fail loudly).
 */
export function classifyWidening(importPath, walls = DEFAULT_WALLS) {
    for (const { prefix, widening } of walls.crossProcess) {
        if (importPath.startsWith(prefix))
            return widening;
    }
    const frozen = importPath.match(new RegExp(walls.frozenDirRe));
    if (frozen)
        return `src/renderer/${frozen[1]}/**`;
    const feature = importPath.match(new RegExp(walls.featureRe));
    if (feature)
        return `src/renderer/features/${feature[1]}/**`;
    return null;
}
// Resolve the consumer's eslint entrypoint (its node_modules). Returns null if absent.
function resolveEslintBin(cwd) {
    const bin = join(cwd, 'node_modules', 'eslint', 'bin', 'eslint.js');
    return existsSync(bin) ? bin : null;
}
function runScan(cwd, eslintBin, globs) {
    const r = spawnSync(process.execPath, [eslintBin, '--format', 'json', ...globs], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        // Both flags set: the devkit template honours DEVKIT_*; frink's config honours
        // FRINK_* — setting both lets this one generator drive either config (the
        // dogfood-reproduce gate runs it against frink unchanged).
        env: { ...process.env, DEVKIT_IMPORTS_BASELINE_SCAN: '1', FRINK_IMPORTS_BASELINE_SCAN: '1' },
    });
    if (!r.stdout) {
        throw new Error(`import-wall scan produced no output (status ${r.status}):\n${(r.stderr ?? '').slice(0, 800)}`);
    }
    return JSON.parse(r.stdout);
}
/**
 * Compute the import-wall grandfather entries for a consumer. Returns
 * { entries, classCounts } or throws on any loud-failure guard.
 *
 * @param cwd consumer repo root
 */
// Reason: the branches ARE the loud-failure-guard algorithm: each per-message arm (unresolvable / no-parseable-path / no-known-wall-class -> push failure, else widen) is a distinct refuse-vs-widen decision that must NOT silently collapse; extracting them scatters the never-silently-widen contract across helpers
// fallow-ignore-next-line complexity
export function computeImportWallBaseline(cwd, opts = {}) {
    const walls = { ...DEFAULT_WALLS, ...(opts.walls ?? {}) };
    const exemptPatterns = opts.exemptPatterns ?? new Set();
    const eslintBin = resolveEslintBin(cwd);
    if (!eslintBin) {
        throw new Error('import-wall generator: eslint not found in consumer node_modules — install deps first (bun install).');
    }
    const widenings = new Map(); // file -> Set<widening>
    const failures = [];
    for (const file of runScan(cwd, eslintBin, walls.lintGlobs)) {
        const rel = file.filePath.startsWith(`${cwd}/`)
            ? file.filePath.slice(cwd.length + 1)
            : file.filePath;
        for (const msg of file.messages ?? []) {
            if (msg.ruleId !== RULE)
                continue;
            if (exemptPatterns.has(rel))
                continue;
            if (msg.message.includes('Cannot find module')) {
                failures.push(`${rel}: unresolvable import — ${msg.message.split('\n')[0]}`);
                continue;
            }
            const importPath = parseImportPath(msg.message);
            if (!importPath) {
                failures.push(`${rel}: violation without parseable import path (plugin format changed?)`);
                continue;
            }
            const widening = classifyWidening(importPath, walls);
            if (!widening) {
                failures.push(`${rel}: import "${importPath}" fits no known wall class`);
                continue;
            }
            if (!widenings.has(rel))
                widenings.set(rel, new Set());
            widenings.get(rel)?.add(widening);
        }
    }
    if (failures.length > 0) {
        throw new Error(`import-wall baseline generation refused:\n   ${failures.join('\n   ')}`);
    }
    const entries = [...widenings.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, set]) => ({
        name: `grandfather:${file}`,
        pattern: file,
        allowImportsFrom: [walls.baseRef, ...[...set].sort()],
    }));
    const classCounts = {};
    for (const set of widenings.values())
        for (const w of set)
            classCounts[w] = (classCounts[w] ?? 0) + 1;
    return { entries, classCounts };
}
export function renderImportWallFile(entries, exportName = DEFAULT_WALLS.exportName) {
    const header = `// AUTO-GENERATED grandfather list for the renderer import walls
// (project-structure/independent-modules). One module entry per file that
// predates the walls, widened with the MINIMAL extra allowances it needs.
//
// Shrink-only: fix a file's imports (types -> src/shared/types, deep feature
// paths -> barrels, frozen dirs -> lib/) and remove its entry. Do NOT add
// entries by hand. Regenerate (only after a deliberate audit):
//   bunx devkit init --stack electron   (re-runs the baseline generators)

export const ${exportName} = `;
    return `${header}${JSON.stringify(entries, null, 2)};\n`;
}
/**
 * Generate <cwd>/eslint/baselines/imports.mjs. Returns the entries; no-ops the
 * write under dryRun. Throws on any loud-failure guard (never silently widens).
 *
 * @param cwd consumer repo root
 */
export function generateImportWallBaseline(cwd = process.cwd(), opts = {}) {
    const log = opts.log ?? (() => { });
    // Empty-walls early-return: a config-driven repo (declares structure.trees) with NO import walls —
    // devkit's own cli/gate-engine, a flat component lib — needs no eslint scan at all. Skip cleanly
    // instead of running the electron-shaped scan and failing on "eslint not found".
    // ponytail: when a config-driven repo declares NON-empty structure.walls, classifyWidening still
    // uses the electron DEFAULT_WALLS shape — generalize to declared wallClasses when frink migrates.
    const cfg = opts.cfg ?? resolveGuardConfig(cwd);
    if ((cfg.structure?.trees?.length ?? 0) > 0 && (cfg.structure?.walls?.length ?? 0) === 0) {
        log(`  ✓ ${OUT}: no import walls declared — skipped`);
        return [];
    }
    const { entries, classCounts } = computeImportWallBaseline(cwd, opts);
    const exportName = opts.walls?.exportName ?? DEFAULT_WALLS.exportName;
    const out = join(cwd, OUT);
    if (!opts.dryRun) {
        if (entries.length > 0) {
            mkdirSync(dirname(out), { recursive: true });
            writeFileSync(out, renderImportWallFile(entries, exportName));
        }
        else {
            // No violators → no debt to grandfather. Don't write an empty baseline; delete a stale one
            // (the eslint loader returns [] on absence, so enforcement is unchanged).
            rmSync(out, { force: true });
        }
    }
    log(`  ${opts.dryRun ? '[dry-run] ' : '✓ '}${OUT}: ${entries.length} grandfathered file(s)`);
    for (const [w, n] of Object.entries(classCounts).sort())
        log(`     ${w}: ${n} file(s)`);
    return entries;
}
// CLI entry: `node generate-import-wall-baseline.mjs [cwd]`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const cwd = process.argv[2] ? join(process.cwd(), process.argv[2]) : process.cwd();
    try {
        generateImportWallBaseline(cwd, { log: (m) => console.log(m) });
    }
    catch (e) {
        console.error(`🚫 ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    }
}
