#!/usr/bin/env node
/**
 * devkit move <src...> <dest-dir> — relocate source files and rewrite EVERY reference.
 *
 *   devkit move src/renderer/features/agents/utils/pr-message.ts src/renderer/lib/utils
 *   devkit move <a.ts> <b.ts> <dest-dir> [--dry-run] [--no-baseline] [--alias=PREFIX=DIR]
 *
 * What it does (deterministically, no AI):
 *   1. `git mv` each file (+ its colocated *.test/*.spec sibling) to the destination,
 *      preserving history.
 *   2. Rewrite every importer's specifier across the project — import / export-from /
 *      dynamic import() / vi.mock|vi.doMock|jest.mock|require — to the moved file's new
 *      path, in the project's `@/` ALIAS style (the codebase convention).
 *   3. Re-anchor the MOVED file's own relative imports to alias form (they break on move).
 *   4. Surgically drop the moved files' OLD entries from the structure baseline
 *      (.devkit/baselines/structure/*.mjs) — NO whole-tree regen (never absorbs parallel work).
 *
 * Why not ts-morph's SourceFile.move(): it leaves `@/` alias importers stale (dangling)
 * and emits wrong relative paths. We use ts-morph only for AST-accurate editing and
 * compute specifiers ourselves so alias style is preserved and resolution is exact.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Node, Project, SyntaxKind, ts } from 'ts-morph';
import { LEGACY_STRUCTURE_BASELINE_DIR, STRUCTURE_BASELINE_DIR, } from '../../gate-engine/ratchets/baseline-paths.mjs';
import { resolveBaselineRoots } from '../lib/generate/generate-structure-baseline.mjs';
const TEST_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];
const MOCK_CALLEES = new Set(['vi.mock', 'vi.doMock', 'jest.mock', 'require', 'import']);
const NO_ALIAS_HINT = 'no "@/*"-style path alias found in tsconfig — pass --alias @/=src/renderer';
// 18003 always fires because readDirectory is stubbed below, and 5023 fires on valid configs using
// an option this TypeScript predates. Every other diagnostic left `paths` genuinely unresolved.
const BENIGN_CONFIG_CODES = new Set([18003, 5023]);
const EXT_RE = /\.(ts|tsx|js|jsx)$/;
const STAR_END_RE = /\*$/;
const SLASH_END_RE = /\/$/;
const INDEX_SUFFIX_RE = /\/index$/;
const RE_META_RE = /[.*+?^${}()|[\]\\]/g;
const stripExt = (p) => p.replace(EXT_RE, '');
const toPosix = (p) => p.replaceAll('\\', '/');
/** Reads the `@/*` alias the way tsc does: whole `extends` chain, real tsconfig JSONC. */
function readAlias(cwd, override) {
    const tsPath = join(cwd, 'tsconfig.json');
    // Checked even under --alias: the rewrite pass below builds a ts-morph Project from this file
    // AFTER git mv, so an absent one would abort mid-run and strand a half-moved tree.
    if (!existsSync(tsPath))
        throw new Error(`could not read ${relative(cwd, tsPath)}: file not found`);
    if (override) {
        const [prefix, dir] = override.split('=');
        if (!dir)
            throw new Error(`--alias needs PREFIX=DIR, got --alias=${override}`);
        return { prefix: prefix.replace(STAR_END_RE, ''), root: resolve(cwd, dir) };
    }
    const read = ts.readConfigFile(tsPath, (p) => ts.sys.readFile(p));
    if (read.error)
        throw new Error(`could not read ${relative(cwd, tsPath)}: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`);
    // readDirectory is stubbed: only compilerOptions is wanted, and the include glob would walk the repo.
    const host = {
        useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
        readDirectory: () => [],
        fileExists: (p) => ts.sys.fileExists(p),
        readFile: (p) => ts.sys.readFile(p),
    };
    const parsed = ts.parseJsonConfigFileContent(read.config, host, cwd, undefined, tsPath);
    const opts = parsed.options;
    const entry = Object.entries(opts.paths ?? {}).find(([k, v]) => k.endsWith('/*') && v[0]);
    if (!entry) {
        // Only consulted once nothing resolved: these same diagnostics fire harmlessly when the root
        // config's own paths win, so they are the diagnosis only when there is nothing else to report.
        const fault = parsed.errors.find((d) => !BENIGN_CONFIG_CODES.has(d.code));
        if (fault) {
            const where = fault.file ? relative(cwd, fault.file.fileName) : relative(cwd, tsPath);
            throw new Error(`could not read ${where}: ${ts.flattenDiagnosticMessageText(fault.messageText, ' ')}`);
        }
        return null;
    }
    const prefix = entry[0].replace(STAR_END_RE, ''); // '@/*' -> '@/'
    const target = entry[1][0].replace(STAR_END_RE, '').replace(SLASH_END_RE, ''); // './src/renderer/*' -> './src/renderer'
    // tsc resolves `paths` against baseUrl when declared, else against the declaring config's dir.
    return { prefix, root: resolve(opts.baseUrl ?? opts.pathsBasePath ?? cwd, target) };
}
/** A specifier → absolute extensionless module path, or null if external/bare. */
function resolveSpec(spec, resolveDir, alias) {
    if (spec.startsWith(alias.prefix))
        return stripExt(join(alias.root, spec.slice(alias.prefix.length)));
    if (spec.startsWith('./') || spec.startsWith('../'))
        return stripExt(resolve(resolveDir, spec));
    return null;
}
/** Absolute extensionless module path → alias specifier ('@/lib/utils/x', drops trailing /index). */
function aliasFor(absMod, alias) {
    return alias.prefix + toPosix(relative(alias.root, absMod)).replace(INDEX_SUFFIX_RE, '');
}
function testSiblings(fileAbs) {
    const base = stripExt(fileAbs);
    return TEST_SUFFIXES.map((s) => base + s).filter(existsSync);
}
/** Every editable module specifier in a file: import/export-from + import()/vi.mock/require string args. */
function specifierHandles(sf) {
    const out = [];
    for (const d of [...sf.getImportDeclarations(), ...sf.getExportDeclarations()]) {
        const lit = d.getModuleSpecifier();
        if (lit)
            out.push({ get: () => lit.getLiteralValue(), set: (v) => lit.setLiteralValue(v) });
    }
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (!MOCK_CALLEES.has(call.getExpression().getText()))
            continue;
        const arg = call.getArguments()[0];
        if (arg && Node.isStringLiteral(arg))
            out.push({ get: () => arg.getLiteralValue(), set: (v) => arg.setLiteralValue(v) });
    }
    return out;
}
function gitMv(cwd, from, to) {
    execFileSync('git', ['mv', relative(cwd, from), relative(cwd, to)], { cwd });
}
/** Drop moved files' OLD paths from the structure baselines (surgical — no regen). */
function pruneBaselines(cwd, oldRelPaths, dryRun) {
    const canonicalDir = join(cwd, STRUCTURE_BASELINE_DIR);
    const legacyDir = join(cwd, LEGACY_STRUCTURE_BASELINE_DIR);
    if (!existsSync(canonicalDir) && !existsSync(legacyDir))
        return 0;
    // structureRoot prefixes → baseline file, resolved from guard.config.json so the prune
    // follows whatever roots the baseline writer used (config trees or the electron default).
    const ROOTS = resolveBaselineRoots(cwd);
    let removed = 0;
    for (const [prefix, file] of ROOTS) {
        const canonical = join(canonicalDir, file);
        const legacy = join(legacyDir, file);
        const abs = existsSync(canonical) ? canonical : legacy;
        if (!existsSync(abs))
            continue;
        const keys = oldRelPaths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
        if (!keys.length)
            continue;
        const text = readFileSync(abs, 'utf8');
        let next = text;
        for (const k of keys) {
            const line = new RegExp(`^\\s*"${k.replace(RE_META_RE, '\\$&')}",?\\n`, 'm');
            if (line.test(next)) {
                next = next.replace(line, '');
                removed++;
            }
        }
        if (next !== text && !dryRun)
            writeFileSync(abs, next);
    }
    return removed;
}
export const meta = {
    name: 'move',
    summary: 'Relocate source files + rewrite every reference.',
    help: `devkit move — relocate source files + rewrite EVERY reference to the new path.

Usage:
  devkit move <src...> <dest-dir> [--dry-run] [--no-baseline] [--alias=@/=src/renderer]

Rewrites import / export-from / dynamic import() / vi.mock|jest.mock|require in the repo's @/ alias
style, moves colocated *.test siblings, re-anchors the moved file's own relative imports, and
surgically prunes the moved entries from .devkit/baselines/structure (no whole-tree regen).
  --dry-run        Preview only.
  --no-baseline    Skip the baseline prune.
  --alias=@/=DIR   Override tsconfig alias auto-detect.`,
};
export default async function move(args, cwd) {
    const flags = new Set(args.filter((a) => a.startsWith('--') && !a.startsWith('--alias=')));
    const positionals = args.filter((a) => !a.startsWith('--'));
    const dryRun = flags.has('--dry-run');
    const noBaseline = flags.has('--no-baseline');
    // --alias=@/=src/renderer (split on the FIRST '=' only → prefix '@/', dir 'src/renderer')
    const aliasArg = args.find((a) => a.startsWith('--alias='))?.slice('--alias='.length);
    if (positionals.length < 2) {
        console.error('usage: devkit move <src...> <dest-dir> [--dry-run] [--no-baseline] [--alias=@/=src/renderer]');
        return 1;
    }
    const destDir = resolve(cwd, positionals[positionals.length - 1]);
    const srcRels = positionals.slice(0, -1);
    // Expand sources + colocated tests into concrete moves.
    const moves = [];
    const seen = new Set();
    const addMove = (oldAbs) => {
        if (seen.has(oldAbs))
            return;
        seen.add(oldAbs);
        moves.push({ oldAbs, newAbs: join(destDir, basename(oldAbs)), oldMod: stripExt(oldAbs) });
    };
    for (const r of srcRels) {
        const oldAbs = resolve(cwd, r);
        if (!existsSync(oldAbs)) {
            console.error(`✗ not found: ${r}`);
            return 1;
        }
        addMove(oldAbs);
        for (const t of testSiblings(oldAbs))
            addMove(t);
    }
    moves.forEach((m) => {
        m.newMod = stripExt(m.newAbs);
    });
    const preview = () => {
        for (const m of moves)
            console.log(`${dryRun ? '[dry] ' : ''}mv ${relative(cwd, m.oldAbs)} → ${relative(cwd, m.newAbs)}`);
    };
    if (dryRun) {
        const shown = readAlias(cwd, aliasArg);
        preview();
        console.log('[dry] would rewrite importers + prune baselines (run without --dry-run to apply)');
        if (shown)
            return 0;
        console.error(NO_ALIAS_HINT);
        return 1;
    }
    const alias = readAlias(cwd, aliasArg);
    if (!alias) {
        console.error(NO_ALIAS_HINT);
        return 1;
    }
    preview();
    mkdirSync(destDir, { recursive: true });
    for (const m of moves)
        gitMv(cwd, m.oldAbs, m.newAbs);
    const project = new Project({ tsConfigFilePath: join(cwd, 'tsconfig.json') });
    const movedByNew = new Map(moves.map((m) => [m.newAbs, m]));
    let rewrites = 0;
    for (const sf of project.getSourceFiles()) {
        const fileAbs = sf.getFilePath();
        const moved = movedByNew.get(fileAbs);
        const resolveDir = moved ? dirname(moved.oldAbs) : dirname(fileAbs); // moved file's relatives anchored to OLD dir
        let touched = false;
        for (const h of specifierHandles(sf)) {
            const spec = h.get();
            const absMod = resolveSpec(spec, resolveDir, alias);
            if (absMod == null)
                continue;
            const hit = moves.find((m) => m.oldMod === absMod);
            if (hit) {
                h.set(aliasFor(hit.newMod ?? stripExt(hit.newAbs), alias)); // → a moved file's new home
                touched = true;
                rewrites++;
            }
            else if (moved && !spec.startsWith(alias.prefix)) {
                h.set(aliasFor(absMod, alias)); // moved file's own relative → re-anchor to alias
                touched = true;
                rewrites++;
            }
        }
        if (touched)
            sf.saveSync();
    }
    const removed = noBaseline
        ? 0
        : pruneBaselines(cwd, moves.map((m) => toPosix(relative(cwd, m.oldAbs))), false);
    console.log(`✓ moved ${moves.length} file(s), rewrote ${rewrites} specifier(s)${noBaseline ? '' : `, pruned ${removed} baseline entr${removed === 1 ? 'y' : 'ies'}`}`);
    console.log('  next: bunx tsc --noEmit && bun run lint:structure && bun run test:run');
    return 0;
}
