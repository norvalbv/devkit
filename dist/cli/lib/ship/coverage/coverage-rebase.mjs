#!/usr/bin/env node
/**
 * sc-1292: rewrite a ship worktree's linked coverage keys onto its own paths, so fallow's auto-detected
 * CRAP joins measured coverage. Prints the foreign root, or nothing; always exits 0 (never a gate).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { COVERAGE_DIR, REPORT_NAME } from '../../../../gate-engine/coverage/produce.mjs';
/**
 * One istanbul file entry. Only `path` is read here; every other field (statementMap, s, f, b, …)
 * passes through untouched, so the coverage gate's totals are computed from exactly the same data.
 */
const coverageEntrySchema = z.looseObject({ path: z.string().optional() });
/** coverage-final.json: file key → istanbul entry. A map that does not parse is never rebased. */
export const coverageMapSchema = z.record(z.string(), coverageEntrySchema);
/** `/a/b` → `/a/b/`, and `/` stays `/` — the boundary a key must start with to sit under `root`. */
const boundary = (root) => `${root.replace(/\/+$/, '')}/`;
/** The SHORTEST prefix of `key` whose remainder is tracked — a root `index.ts` cannot claim
 * `/prod/src/index.ts` as `/prod/src`. */
function producingPrefix(key, tracked) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
        if (tracked.has(parts.slice(i).join('/')))
            return parts.slice(0, i).join('/') || '/';
    }
    return null;
}
/**
 * The root the map's absolute keys were produced under, or null when there is nothing to rebase: no
 * key joins a tracked path, the keys are relative, or the majority already sits at `wtRoot`.
 */
export function deriveForeignRoot(keys, tracked, wtRoot) {
    const votes = new Map();
    for (const key of keys) {
        if (!key.startsWith('/'))
            continue;
        const prefix = producingPrefix(key, tracked);
        if (prefix !== null)
            votes.set(prefix, (votes.get(prefix) ?? 0) + 1);
    }
    let best = null;
    let bestVotes = 0;
    for (const [prefix, count] of votes) {
        if (count > bestVotes)
            [best, bestVotes] = [prefix, count];
    }
    return best === null || boundary(best) === boundary(wtRoot) ? null : best;
}
/** Move every key and istanbul `path` under `fromRoot` to `toRoot`; others stay. On a collision the
 * key already at `toRoot` wins — it was produced from this tree. */
export function rebaseCoverageMap(map, fromRoot, toRoot) {
    const from = boundary(fromRoot);
    const to = boundary(toRoot);
    const move = (path) => path.startsWith(from) ? to + path.slice(from.length) : path;
    const out = {};
    const moved = [];
    for (const [key, original] of Object.entries(map)) {
        const path = original.path === undefined ? undefined : move(original.path);
        const entry = path === original.path ? original : { ...original, path };
        if (key.startsWith(from))
            moved.push([move(key), entry]);
        else
            out[key] = entry;
    }
    for (const [key, entry] of moved)
        if (!(key in out))
            out[key] = entry;
    return out;
}
function trackedPaths(wt) {
    const listed = execFileSync('git', ['-C', wt, 'ls-files', '-z'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 256 * 1024 * 1024,
    });
    return new Set(listed.split('\0').filter(Boolean));
}
/** Swap the `<wt>/coverage` link for a real dir: the rebased report plus links to every other source
 * entry. Built beside it, so any failure leaves or restores the original link. */
function materialize(wt, source, rebased) {
    const dest = join(wt, COVERAGE_DIR);
    if (!lstatSync(dest).isSymbolicLink())
        throw new Error(`${dest} is not the link ship created`);
    const staging = join(wt, `.${COVERAGE_DIR}-rebase-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging);
    try {
        for (const entry of readdirSync(source)) {
            if (entry !== REPORT_NAME)
                symlinkSync(join(source, entry), join(staging, entry));
        }
        writeFileSync(join(staging, REPORT_NAME), JSON.stringify(rebased));
        unlinkSync(dest);
        try {
            renameSync(staging, dest);
        }
        catch (error) {
            symlinkSync(source, dest);
            throw error;
        }
    }
    catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
    }
}
/** Rebase `<wt>/coverage` when its map was produced elsewhere. Returns the foreign root, or null. */
export function rebaseWorktreeCoverage(wt, source) {
    const report = join(source, REPORT_NAME);
    if (!existsSync(report))
        return null;
    const parsed = coverageMapSchema.safeParse(JSON.parse(readFileSync(report, 'utf8')));
    if (!parsed.success)
        return null;
    const map = parsed.data;
    const wtRoot = realpathSync(wt);
    const root = deriveForeignRoot(Object.keys(map), trackedPaths(wt), wtRoot);
    if (root === null)
        return null;
    materialize(wt, source, rebaseCoverageMap(map, root, wtRoot));
    return root;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    const [wt, source] = process.argv.slice(2);
    try {
        if (!wt || !source)
            throw new Error('usage: coverage-rebase <worktree> <linked-coverage-dir>');
        const root = rebaseWorktreeCoverage(wt, source);
        if (root !== null)
            process.stdout.write(`${root}\n`);
    }
    catch (error) {
        process.stderr.write(`devkit ship: coverage paths not rebased (${error instanceof Error ? error.message : String(error)}) — fallow may score CRAP without measured coverage\n`);
    }
}
