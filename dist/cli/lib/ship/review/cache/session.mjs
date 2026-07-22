/** Generation-fenced transfer between stable and per-run `devkit review` verdict stores. */
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEntries, replaceEntries, saveEntriesIfGeneration, verdictStoreGeneration, } from "../../../../../gate-engine/judge/verdict-store.mjs";
import { runDirectReviewCli } from "../run-direct.mjs";
import { reviewPathWithin } from "../runtime-paths.mjs";
const PREPARE_PROTOCOL = 'devkit-review-cache-session-v1';
const PROMOTION_PROTOCOL = 'devkit-review-cache-promotion-v1';
const STABLE_READ_ATTEMPTS = 8;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const REVIEW_CACHE_STORE_NAMES = [
    'review-cache.json',
    'decisions-verdict-cache.json',
    'prefix-cache.json',
];
function fail(message) {
    throw new Error(`devkit review: ${message}`);
}
function physicalRoot(requestedPath, label) {
    if (!requestedPath || requestedPath.includes('\0'))
        fail(`${label} must be a physical directory.`);
    const requested = resolve(requestedPath);
    try {
        const stat = lstatSync(requested);
        if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(requested) !== requested) {
            return fail(`${label} must be a physical directory: ${requested}`);
        }
    }
    catch (cause) {
        if (cause instanceof Error && cause.message.startsWith('devkit review:'))
            throw cause;
        return fail(`${label} must be an available physical directory: ${requested}`);
    }
    return requested;
}
function cacheRoots(persistentRoot, privateRoot) {
    const persistent = physicalRoot(persistentRoot, 'persistent review cache root');
    const privateData = physicalRoot(privateRoot, 'private review data root');
    if (reviewPathWithin(persistent, privateData) || reviewPathWithin(privateData, persistent)) {
        return fail('persistent and private review cache roots must be separate, non-nested directories');
    }
    return [persistent, privateData];
}
function cacheStoreName(name) {
    if (!REVIEW_CACHE_STORE_NAMES.includes(name)) {
        return fail(`unsupported review cache store: ${JSON.stringify(name)}`);
    }
    return name;
}
function stableEntries(file) {
    for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
        const before = verdictStoreGeneration(file);
        const entries = loadEntries(file);
        const after = verdictStoreGeneration(file);
        if (before === after)
            return { entries, generation: before };
    }
    return fail(`cache store changed repeatedly during capture: ${file}`);
}
/** Copy the three approved persistent stores into a private run root and capture reset fences. */
export function prepareReviewCacheSession(persistentRoot, privateRoot) {
    const [persistent, privateData] = cacheRoots(persistentRoot, privateRoot);
    return REVIEW_CACHE_STORE_NAMES.map((name) => {
        const captured = stableEntries(join(persistent, name));
        if (!replaceEntries(join(privateData, name), captured.entries)) {
            return fail(`could not hydrate private review cache store: ${name}`);
        }
        return { name, generation: captured.generation };
    });
}
/** Merge one private store only when its persistent reset fence still matches the captured value. */
export function promoteReviewCacheStore(persistentRoot, privateRoot, requestedName, expectedGeneration) {
    const [persistent, privateData] = cacheRoots(persistentRoot, privateRoot);
    const name = cacheStoreName(requestedName);
    if (expectedGeneration !== null && !GENERATION.test(expectedGeneration)) {
        return fail(`invalid review cache generation for ${name}.`);
    }
    const captured = stableEntries(join(privateData, name));
    return saveEntriesIfGeneration(join(persistent, name), expectedGeneration, captured.entries);
}
function writeFields(fields) {
    process.stdout.write(`${fields.join('\0')}\0`);
}
function runCli(args) {
    if (args[0] === 'prepare' && args.length === 3) {
        const checkpoints = prepareReviewCacheSession(args[1], args[2]);
        writeFields([
            PREPARE_PROTOCOL,
            String(checkpoints.length),
            ...checkpoints.flatMap(({ name, generation }) => [name, generation ?? '']),
        ]);
        return;
    }
    if (args[0] === 'promote' && args.length === 5) {
        const name = cacheStoreName(args[3]);
        const encodedGeneration = args[4];
        const generation = encodedGeneration === '' ? null : encodedGeneration;
        const result = promoteReviewCacheStore(args[1], args[2], name, generation);
        writeFields([PROMOTION_PROTOCOL, name, result]);
        process.exitCode = result === 'saved' ? 0 : result === 'generation-changed' ? 2 : 1;
        return;
    }
    throw new Error('usage: review/cache/session prepare <persistent-root> <private-root> | promote <persistent-root> <private-root> <store-name> <expected-generation>');
}
runDirectReviewCli(import.meta.url, runCli);
