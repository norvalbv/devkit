#!/usr/bin/env node
/**
 * devkit move <src...> <dest> — relocate or rename source files and rewrite every reference.
 * Usage: `devkit move --help`; design: docs/decisions/move-rewrites-via-ts-file-rename.md.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { STRUCTURE_BASELINE_DIR } from '../../gate-engine/ratchets/baseline-paths.mjs';
import { resolveBaselineRoots } from '../lib/generate/generate-structure-baseline.mjs';
import { assertMovedSource, moveTrackedWithGit, moveUntrackedWithGit, trackedPathState, } from '../lib/git-tracked.mjs';
import { readProjectConfig } from '../lib/move/config.mjs';
import { rewriteFile } from '../lib/move/write.mjs';
import { findDangling, mapPath as mapPathTo, unmapPath, moveContext, rewriteSource, SOURCE_EXT_RE, } from '../lib/move/rewrite-plan.mjs';
import { reviewPathWithin } from '../lib/ship/review/runtime-paths.mjs';
const TEST_SUFFIXES = ['test', 'spec'].flatMap((kind) => ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].map((ext) => `.${kind}.${ext}`));
const RE_META_RE = /[.*+?^${}()|[\]\\]/g;
const NODE_MODULES_SEGMENT = '/node_modules/';
const stripExt = (p) => p.replace(SOURCE_EXT_RE, '');
const toPosix = (p) => p.replaceAll('\\', '/');
function testSiblings(fileAbs) {
    const base = stripExt(fileAbs);
    return TEST_SUFFIXES.map((suffix) => ({ path: base + suffix, suffix })).filter((s) => existsSync(s.path));
}
function lstatOrNull(path) {
    try {
        return lstatSync(path);
    }
    catch (error) {
        if (error instanceof Error &&
            'code' in error &&
            (error.code === 'ENOENT' || error.code === 'ENOTDIR'))
            return null;
        throw error;
    }
}
function nearestExistingAncestor(path) {
    let cursor = path;
    while (!lstatOrNull(cursor)) {
        const parent = dirname(cursor);
        if (parent === cursor)
            break;
        cursor = parent;
    }
    return { canonical: realpathSync(cursor), lexical: cursor };
}
/** Logical leaf mappings for AST/baseline work; nested repositories are deliberately opaque. */
function mapDirectoryLeaves(oldDir, newDir, addMove) {
    if (lstatOrNull(join(oldDir, '.git')))
        return;
    const entries = readdirSync(oldDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const oldAbs = join(oldDir, entry.name);
        const newAbs = join(newDir, entry.name);
        const stat = lstatSync(oldAbs);
        if (stat.isDirectory() && !stat.isSymbolicLink())
            mapDirectoryLeaves(oldAbs, newAbs, addMove);
        else
            addMove(oldAbs, newAbs);
    }
}
function shouldRewriteSourceFile(fileAbs, worktreeRoot, gitDir) {
    let parent = dirname(fileAbs);
    while (parent !== worktreeRoot) {
        if (lstatOrNull(join(parent, '.git')))
            return false;
        const next = dirname(parent);
        if (next === parent)
            return false;
        parent = next;
    }
    const stat = lstatOrNull(fileAbs);
    if (!stat || stat.isSymbolicLink())
        return false;
    const canonicalParent = realpathSync(dirname(fileAbs));
    return (reviewPathWithin(worktreeRoot, canonicalParent) && !reviewPathWithin(gitDir, canonicalParent));
}
/** Drop moved files' OLD paths from the structure baselines (surgical — no regen). */
function pruneBaselines(cwd, oldRelPaths, dryRun) {
    const canonicalDir = join(cwd, STRUCTURE_BASELINE_DIR);
    if (!existsSync(canonicalDir))
        return 0;
    // structureRoot prefixes → baseline file, resolved from guard.config.json so the prune
    // follows whatever roots the baseline writer used (config trees or the electron default).
    const ROOTS = resolveBaselineRoots(cwd);
    let removed = 0;
    for (const [prefix, file] of ROOTS) {
        const abs = join(canonicalDir, file);
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
const USAGE = 'usage: devkit move <src...> <dest> [--rename] [--dry-run] [--no-baseline] [--alias=@/=src/renderer]';
export const meta = {
    name: 'move',
    agentFacing: true,
    summary: 'Relocate or rename source files + rewrite every reference.',
    help: `devkit move — relocate or rename source files + rewrite EVERY reference to the new path.

Usage:
  devkit move <src...> <dest-dir> [--dry-run] [--no-baseline] [--alias=@/=src/renderer]
  devkit move <file> <new-file.ts>         Rename a file: the destination has a source extension.
  devkit move <dir> <new-dir> --rename     Rename a directory instead of moving it into <new-dir>.

Without --rename (and for a destination without an extension), sources move INTO <dest-dir>,
which is created if needed. Rewrites import / export-from / dynamic import() / vi.mock|jest.mock|
require across the project in each specifier's own style (relative stays relative, @/ stays @/),
except that an alias is never written from outside its root, so it never emits @/../.
Colocated *.test / *.spec siblings follow their file. Every rewritten specifier is re-resolved
after the move, exiting 1 naming any that dangle. Prunes moved entries from .devkit/baselines/
structure (no regen). Tracked sources keep history via git mv; untracked need no first commit.
  --rename         Rename a single directory source to <dest>.
  --dry-run        Preview the moves and the rewrite count only.
  --no-baseline    Skip the baseline prune.
  --alias=@/=DIR   Add a path alias mapping tsconfig does not declare.`,
};
export default async function move(args, cwd) {
    const flags = new Set(args.filter((a) => a.startsWith('--') && !a.startsWith('--alias=')));
    const positionals = args.filter((a) => !a.startsWith('--'));
    const dryRun = flags.has('--dry-run');
    const noBaseline = flags.has('--no-baseline');
    const renameDir = flags.has('--rename');
    // --alias=@/=src/renderer (split on the FIRST '=' only → prefix '@/', dir 'src/renderer')
    const aliasArg = args.find((a) => a.startsWith('--alias='))?.slice('--alias='.length);
    if (positionals.length < 2) {
        console.error(USAGE);
        return 1;
    }
    const fail = (message) => {
        console.error(`✗ ${message}`);
        return 1;
    };
    cwd = realpathSync(cwd);
    const destArg = positionals[positionals.length - 1];
    const destDir = resolve(cwd, destArg);
    const srcRels = positionals.slice(0, -1);
    const destStat = lstatOrNull(destDir);
    const destIsDir = destStat?.isDirectory() === true && !destStat.isSymbolicLink();
    // Only a single file source can be renamed by naming the new file; several sources move into dest.
    const destNamesFile = srcRels.length === 1 && SOURCE_EXT_RE.test(basename(destDir)) && !destIsDir;
    if (srcRels.length > 1 && renameDir)
        return fail(`a rename takes exactly one source; ${USAGE.slice('usage: '.length)}`);
    const worktreeRoot = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim());
    const gitDir = realpathSync(execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' }).trim());
    const trackedPaths = trackedPathState(worktreeRoot, { realIndex: true });
    const gitMarker = join(worktreeRoot, '.git');
    // Expand sources into physical operations and concrete logical file mappings. Directories move
    // once; their descendants exist only in `moves`, where the baseline pass needs them.
    const physicalMoves = [];
    const moves = [];
    const seenPhysical = new Set();
    const seenLogical = new Set();
    const addMove = (oldAbs, newAbs) => {
        if (seenLogical.has(oldAbs))
            return;
        seenLogical.add(oldAbs);
        moves.push({ oldAbs, newAbs });
    };
    const addPhysicalMove = (oldAbs, newAbs) => {
        if (seenPhysical.has(oldAbs))
            return;
        seenPhysical.add(oldAbs);
        const stat = lstatOrNull(oldAbs);
        if (!stat)
            throw new Error(`not found: ${relative(cwd, oldAbs)}`);
        const canonicalParent = realpathSync(dirname(oldAbs));
        const canonicalSource = stat.isSymbolicLink() ? null : realpathSync(oldAbs);
        if (!reviewPathWithin(worktreeRoot, canonicalParent))
            throw new Error(`source resolves outside the Git worktree: ${relative(cwd, oldAbs)}`);
        if (canonicalParent !== dirname(oldAbs))
            throw new Error(`source traverses a symlinked directory: ${relative(cwd, oldAbs)}`);
        if (oldAbs === worktreeRoot ||
            reviewPathWithin(gitMarker, oldAbs) ||
            reviewPathWithin(gitDir, canonicalParent) ||
            (canonicalSource != null && reviewPathWithin(gitDir, canonicalSource)))
            throw new Error(`source is Git worktree metadata: ${relative(cwd, oldAbs)}`);
        const oldGitRel = toPosix(relative(worktreeRoot, oldAbs));
        const trackedAtPreflight = trackedPaths.contains(oldGitRel);
        const sourceIdentity = {
            dev: stat.dev,
            ino: stat.ino,
            isDirectory: stat.isDirectory(),
            isSymbolicLink: stat.isSymbolicLink(),
        };
        physicalMoves.push({ oldAbs, newAbs, trackedAtPreflight, sourceIdentity });
        if (!stat.isDirectory() || stat.isSymbolicLink())
            addMove(oldAbs, newAbs);
    };
    for (const r of srcRels) {
        const oldAbs = resolve(cwd, r);
        const stat = lstatOrNull(oldAbs);
        if (!stat) {
            console.error(`✗ not found: ${r}`);
            return 1;
        }
        const isFile = !stat.isDirectory() || stat.isSymbolicLink();
        if (renameDir && isFile)
            return fail(`--rename renames a directory; name the new file instead: ${destArg}`);
        // git mv's rename form, made explicit: a file onto a named file, a directory under --rename.
        const renaming = isFile ? destNamesFile : renameDir;
        const newAbs = renaming ? destDir : join(destDir, basename(oldAbs));
        addPhysicalMove(oldAbs, newAbs);
        if (isFile)
            for (const t of testSiblings(oldAbs))
                addPhysicalMove(t.path, renaming ? stripExt(newAbs) + t.suffix : join(destDir, basename(t.path)));
    }
    const physicalTargets = new Set();
    for (const m of physicalMoves) {
        if (m.oldAbs === m.newAbs)
            return fail(`destination matches source: ${relative(cwd, m.oldAbs)}`);
        if (physicalTargets.has(m.newAbs))
            return fail(`duplicate destination: ${relative(cwd, m.newAbs)}`);
        physicalTargets.add(m.newAbs);
        if (lstatOrNull(m.newAbs))
            return fail(`destination already exists: ${relative(cwd, m.newAbs)}`);
        if (trackedPaths.conflictsTarget(toPosix(relative(worktreeRoot, m.newAbs))))
            return fail(`destination exists in the Git index: ${relative(cwd, m.newAbs)}`);
        const targetAncestor = nearestExistingAncestor(m.newAbs);
        if (!reviewPathWithin(worktreeRoot, targetAncestor.canonical) ||
            reviewPathWithin(gitMarker, m.newAbs) ||
            reviewPathWithin(gitDir, targetAncestor.canonical))
            return fail(`destination resolves outside the Git worktree: ${relative(cwd, m.newAbs)}`);
        if (targetAncestor.canonical !== targetAncestor.lexical)
            return fail(`destination traverses a symlinked directory: ${relative(cwd, m.newAbs)}`);
        if (reviewPathWithin(m.oldAbs, m.newAbs))
            return fail(`destination cannot be inside source: ${relative(cwd, m.newAbs)} is inside ${relative(cwd, m.oldAbs)}`);
    }
    for (let i = 0; i < physicalMoves.length; i++) {
        for (let j = i + 1; j < physicalMoves.length; j++) {
            const left = physicalMoves[i];
            const right = physicalMoves[j];
            if (reviewPathWithin(left.oldAbs, right.oldAbs) ||
                reviewPathWithin(right.oldAbs, left.oldAbs))
                return fail(`sources overlap: ${relative(cwd, left.oldAbs)} and ${relative(cwd, right.oldAbs)}`);
        }
    }
    for (const source of physicalMoves) {
        for (const target of physicalMoves) {
            if (source !== target && reviewPathWithin(source.oldAbs, target.newAbs))
                return fail(`destination cannot be inside source: ${relative(cwd, target.newAbs)} is inside ${relative(cwd, source.oldAbs)}`);
        }
    }
    // Read config before anything moves: a bad config leaves the tree intact.
    const config = readProjectConfig(cwd, aliasArg);
    const movedSources = [];
    for (const m of physicalMoves) {
        if (m.sourceIdentity.isDirectory && !m.sourceIdentity.isSymbolicLink)
            mapDirectoryLeaves(m.oldAbs, m.newAbs, (leaf) => movedSources.push(leaf));
        else
            movedSources.push(m.oldAbs);
    }
    const isRewritable = (p) => shouldRewriteSourceFile(p, worktreeRoot, gitDir);
    // One scope for the dry run, the real run and the post-move rescan, so they plan the same files.
    const inPlanScope = (p) => reviewPathWithin(worktreeRoot, p) && !toPosix(p).includes(NODE_MODULES_SEGMENT);
    const planFiles = [...config.files, ...movedSources.filter((p) => SOURCE_EXT_RE.test(p))].filter(inPlanScope);
    const pathMoves = physicalMoves.map(({ oldAbs, newAbs }) => ({ oldAbs, newAbs }));
    // Every file is named by where it sat before the move; `diskOf` says where it is now.
    let scopeFor = (virtual) => config.scopeOf(virtual);
    const rewriteAll = (files, diskOf) => {
        // Each file resolves with its own project's options, so a references build needs no agreement.
        const contexts = new Map();
        const contextOf = (scope) => {
            let ctx = contexts.get(scope);
            if (!ctx) {
                ctx = moveContext(scope.options, scope.aliases, pathMoves, files, movedSources, !dryRun);
                contexts.set(scope, ctx);
            }
            return ctx;
        };
        const optionsByDisk = new Map();
        const checks = new Map();
        let rewrites = 0;
        let unresolved = 0;
        for (const virtual of files) {
            const disk = diskOf(virtual);
            if (!existsSync(disk) || !isRewritable(disk))
                continue;
            const scope = scopeFor(virtual);
            const ctx = contextOf(scope);
            const r = dryRun
                ? rewriteSource(readFileSync(disk, 'utf8'), virtual, ctx)
                : rewriteFile(disk, virtual, ctx);
            optionsByDisk.set(disk, scope.options);
            rewrites += r.rewrites;
            unresolved += r.unresolved;
            if (r.checks.length)
                checks.set(disk, r.checks);
        }
        if (unresolved)
            console.error(`⚠ ${unresolved} relative specifier(s) in moved files did not resolve before the move and were left unchanged`);
        return { checks, rewrites, optionsByDisk };
    };
    const prefix = dryRun ? '[dry] ' : '';
    for (const m of physicalMoves)
        console.log(`${prefix}mv ${relative(cwd, m.oldAbs)} → ${relative(cwd, m.newAbs)}`);
    if (dryRun) {
        const { rewrites } = rewriteAll([...new Set(planFiles)], (p) => p);
        console.log(`[dry] would rewrite ${rewrites} specifier(s) + prune baselines (run without --dry-run to apply)`);
        return 0;
    }
    for (const m of physicalMoves) {
        if (m.trackedAtPreflight) {
            mkdirSync(dirname(m.newAbs), { recursive: true });
            moveTrackedWithGit(worktreeRoot, m.oldAbs, m.newAbs);
        }
        else
            moveUntrackedWithGit(worktreeRoot, gitDir, m.oldAbs, m.newAbs, m.sourceIdentity);
        assertMovedSource(m.newAbs, m.oldAbs, m.sourceIdentity);
        const movedParent = realpathSync(dirname(m.newAbs));
        if (movedParent !== dirname(m.newAbs) ||
            !reviewPathWithin(worktreeRoot, movedParent) ||
            reviewPathWithin(gitDir, movedParent))
            throw new Error(`destination changed during move; source is at ${realpathSync(m.newAbs)}; imports were not rewritten`);
        if (m.sourceIdentity.isDirectory && !m.sourceIdentity.isSymbolicLink)
            mapDirectoryLeaves(m.newAbs, m.oldAbs, (current, previous) => addMove(previous, current));
    }
    // Best effort: the move itself may have broken a config reference, and nothing can be undone now.
    const rescan = () => {
        try {
            return readProjectConfig(cwd, aliasArg);
        }
        catch (error) {
            console.error(`⚠ could not re-read tsconfig after the move (${error instanceof Error ? error.message : String(error)}); files created outside the moved paths meanwhile were not rewritten`);
            return null;
        }
    };
    const fresh = rescan();
    // Files added while the move ran, inside a moved directory or anywhere tsconfig includes, join
    // the run under the path they would have had before it.
    const plannedFinals = new Set(planFiles.map((p) => mapPathTo(p, pathMoves)));
    const late = [...moves.map((m) => m.newAbs), ...(fresh?.files ?? [])].filter((p) => !plannedFinals.has(p) && SOURCE_EXT_RE.test(p) && inPlanScope(p));
    movedSources.push(...moves.map((m) => m.oldAbs));
    const virtualFiles = [...planFiles, ...late.map((p) => unmapPath(p, pathMoves))];
    // A late file belongs to whichever project claims it now; the pre-move config never saw it.
    const lateVirtual = new Set(late.map((p) => unmapPath(p, pathMoves)));
    scopeFor = (virtual) => fresh && lateVirtual.has(virtual)
        ? fresh.scopeOf(mapPathTo(virtual, pathMoves))
        : config.scopeOf(virtual);
    const { checks, rewrites, optionsByDisk } = rewriteAll([...new Set(virtualFiles)], (p) => mapPathTo(p, pathMoves));
    const dangling = findDangling(checks, (file) => optionsByDisk.get(file) ?? {});
    const removed = noBaseline
        ? 0
        : pruneBaselines(cwd, moves.map((m) => toPosix(relative(cwd, m.oldAbs))), false);
    if (dangling.length) {
        console.error(`✗ ${dangling.length} specifier(s) no longer resolve after the move:`);
        for (const d of dangling)
            console.error(`  ${relative(cwd, d.file)}: '${d.spec}'`);
        return 1;
    }
    console.log(`✓ moved ${moves.length} file(s), rewrote ${rewrites} specifier(s)${noBaseline ? '' : `, pruned ${removed} baseline entr${removed === 1 ? 'y' : 'ies'}`}`);
    console.log('  next: bunx tsc --noEmit && bun run lint:structure && bun run test:run');
    return 0;
}
