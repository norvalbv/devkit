/**
 * devkit move never edits a nested repository; this names the references that would dangle across
 * one, so the move can refuse before it mutates anything.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { reviewPathWithin } from '../ship/review/runtime-paths.mjs';
import { mapPath, moveContext, resolveWith, respell, specifierHandles, } from './rewrite-plan.mjs';
export function lstatOrNull(path) {
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
/** The root of the nested repository (a `.git` dir or file) holding `path`, or null. */
export function nestedRepoOf(path, worktreeRoot) {
    if (!reviewPathWithin(worktreeRoot, path) || path === worktreeRoot)
        return null;
    for (let dir = dirname(path); dir !== worktreeRoot && dir !== dirname(dir); dir = dirname(dir))
        if (lstatOrNull(join(dir, '.git')))
            return dir;
    return null;
}
/** The original spec where it still reaches `expected` after the move; else the spelling that does. */
function danglingSuggestion(spec, file, expected, ctx) {
    const { options, aliases, moves } = ctx;
    const finalPath = mapPath(file, moves);
    if (resolveWith(spec, finalPath, options, ctx.after) === expected)
        return null;
    const suggestion = respell(spec, finalPath, expected, aliases);
    return resolveWith(suggestion, finalPath, options, ctx.after) === expected
        ? suggestion
        : respell(spec, finalPath, expected, aliases, 'relative');
}
/** One nested file's specifiers that reach a target now and will miss it after the move. */
function fileDangles(file, repo, ctx) {
    const finalPath = mapPath(file, ctx.moves);
    const sf = ctx.scratch.createSourceFile(finalPath, readFileSync(file, 'utf8'), {
        overwrite: true,
    });
    const out = [];
    for (const h of specifierHandles(sf)) {
        const spec = h.get();
        const before = resolveWith(spec, file, ctx.options, ctx.before);
        if (before == null)
            continue;
        const expected = mapPath(before, ctx.moves);
        if (finalPath === file && expected === before)
            continue;
        const suggestion = danglingSuggestion(spec, file, expected, ctx);
        if (suggestion != null)
            out.push({ file, spec, repo, suggestion });
    }
    ctx.scratch.removeSourceFile(sf);
    return out;
}
/** Specifiers in nested-repository files that resolve now and will not after `moves`. */
export function findNestedDangling(files, worktreeRoot, scopeOf, moves, targets) {
    const contexts = new Map();
    const contextOf = (scope) => {
        let ctx = contexts.get(scope);
        if (!ctx) {
            ctx = moveContext(scope.options, scope.aliases, moves, files, targets, false);
            contexts.set(scope, ctx);
        }
        return ctx;
    };
    return files.flatMap((file) => {
        const repo = nestedRepoOf(file, worktreeRoot);
        return repo && existsSync(file) ? fileDangles(file, repo, contextOf(scopeOf(file))) : [];
    });
}
