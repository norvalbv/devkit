#!/usr/bin/env node
/** Recorded ship invocation behind `devkit ship --resume`: Buffer → base64 keeps body bytes exact
 * (a UTF-8 hop substitutes U+FFFD). Commit-only writes are best-effort; body side effects require
 * an owned record, and reads fail closed. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { devkitVersion } from '../../../gate-engine/devkit-version.mjs';
import { emitShipIntentEvent } from './ship-intent-event.mjs';
import { fail, parseArgs } from './ship-intent-args.mjs';
import { advisoryBodyFile, bindSourceMembershipForWrite, cleanupDeletedSourceMembershipRefs, cleanupFailedSourceMembership, cleanupReplacedSourceMembership, emitFields, handlePathCodecCommand, NO_RECORD, originRepo, printGeneration, provenString, provenStrings, reportBodyDrift, } from './ship-intent-codec.mjs';
import { withLock } from '../atomic-write.mjs';
import { BRANCH_SCHEMA_VERSION, EXPLICIT_SCHEMA_VERSION, intentFile, readIntent, relIntentPath, } from './intent/record.mjs';
export { readIntent, relIntentPath };
/** Write this attempt's manifest; refuse non-fatally when its path is not ignored. */
export function writeIntent(opts, paths) {
    if (opts.mode !== 'ship' && opts.mode !== 'reship')
        return fail(`--mode must be ship|reship (got '${opts.mode}')`);
    const sourceMode = opts.sourceMode ?? 'explicit';
    if (sourceMode !== 'explicit' && sourceMode !== 'branch')
        return fail(`--source-mode must be explicit|branch (got '${sourceMode}')`);
    if (sourceMode === 'branch' && opts.mode !== 'ship')
        return fail('--source-mode branch is only valid for a new ship');
    if (sourceMode === 'branch' && !opts.base)
        return fail('--source-mode branch requires a non-empty --base');
    if (sourceMode === 'branch' && (opts.mergePaths || (opts.donatePaths?.length ?? 0) > 0))
        return fail('--source-mode branch has frozen path membership and cannot merge/donate paths');
    if (paths.length === 0)
        return fail('no paths given');
    const rel = relIntentPath(opts.branch);
    const probe = spawnSync('git', ['-C', opts.root, 'check-ignore', '-q', '--', rel]);
    if (probe.status !== 0) {
        // 1: not ignored; else git could not answer (beyond a linked .devkit). Never stage a secret.
        const why = probe.status === 1 ? 'is not gitignored here' : `could not be checked: ${probe.stderr}`;
        console.error(`ship-intent: ${rel} ${why.trim()} — not recording the invocation (run devkit doctor --fix; retries need the full command until then)`);
        return 0;
    }
    const generation = randomUUID();
    const requestedSourceAttempt = provenString(opts.sourceAttemptId);
    if (sourceMode === 'branch' && opts.resumed && !requestedSourceAttempt)
        return fail('resumed --source-mode branch requires a non-empty --source-attempt-id');
    const sourceAttemptId = sourceMode === 'branch' ? requestedSourceAttempt || generation : undefined;
    const intent = {
        version: sourceMode === 'branch' ? BRANCH_SCHEMA_VERSION : EXPLICIT_SCHEMA_VERSION,
        mode: opts.mode,
        branch: opts.branch,
        title: opts.title,
        base: opts.base || null,
        links: opts.links,
        paths,
        updatePrBody: opts.updatePrBody,
        draft: opts.draft,
        noStack: opts.noStack,
        bodyB64: opts.body.toString('base64'),
        repo: originRepo(opts.root),
        createdAt: new Date().toISOString(),
        // Random, not the timestamp: two same-millisecond attempts must never share the ownership
        // token the compare-and-delete matches on.
        generation,
        devkitVersion: devkitVersion(),
    };
    if (sourceMode === 'branch')
        intent.sourceMode = sourceMode;
    if (sourceAttemptId)
        intent.sourceAttemptId = sourceAttemptId;
    intent.bodyFile = advisoryBodyFile(opts.bodyFilePath && path.resolve(opts.bodyFilePath));
    const file = intentFile(opts.root, opts.branch);
    mkdirSync(path.dirname(file), { recursive: true });
    let boundNewMembership = null;
    let intentPersisted = false;
    try {
        // The shared lock prevents read-then-replace races; temp+rename preserves the prior record if
        // a process crashes mid-write, and the temporary file is private from its first byte.
        let superseded = false;
        withLock(`${file}.lock`, () => {
            // Resume writes UNION paths and CASes the generation it read, preserving a concurrent full
            // invocation's newer metadata; a record deleted since the read stays spent.
            let onDisk = null;
            try {
                // SAFETY: only generation + paths are read, each re-proven by its proven* helper.
                onDisk = JSON.parse(readFileSync(file, 'utf8'));
            }
            catch {
                onDisk = null; // absent/torn — nothing to merge or protect
            }
            const onDiskGen = (onDisk && provenString(onDisk.generation)) || NO_RECORD;
            if (opts.expectGeneration !== undefined && onDiskGen !== opts.expectGeneration) {
                superseded = true;
                // A losing resume contributes only its explicitly briefed donatePaths. Its stale recorded
                // list must not leak into a newer full invocation; a deleted record stays deleted.
                if (opts.mergePaths && onDisk !== null) {
                    const ownerPaths = provenStrings(onDisk.paths) ?? [];
                    const merged = [...ownerPaths];
                    for (const p of opts.donatePaths ?? [])
                        if (!merged.includes(p))
                            merged.push(p);
                    if (merged.length !== ownerPaths.length) {
                        const tmp = `${file}.${process.pid}.tmp`;
                        writeFileSync(tmp, `${JSON.stringify({ ...onDisk, paths: merged }, null, 2)}\n`, {
                            mode: 0o600,
                        });
                        renameSync(tmp, file);
                    }
                }
                return;
            }
            // Past the CAS, so onDisk is the record this resume read: its path is the one to carry.
            if (opts.keepBodyFile)
                intent.bodyFile ??= advisoryBodyFile(onDisk?.bodyFile);
            if (opts.mergePaths && onDisk !== null)
                for (const p of provenStrings(onDisk.paths) ?? [])
                    if (!intent.paths.includes(p))
                        intent.paths.push(p);
            if (sourceMode === 'branch')
                bindSourceMembershipForWrite(opts.root, intent, opts.resumed, onDisk);
            if (sourceMode === 'branch' && provenString(onDisk?.sourceAttemptId) !== sourceAttemptId)
                boundNewMembership = { sourceAttemptId: sourceAttemptId, paths: intent.paths };
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600 });
            renameSync(tmp, file);
            intentPersisted = true;
            if (sourceMode === 'branch')
                cleanupReplacedSourceMembership(opts.root, intent, onDisk);
        });
        if (superseded) {
            console.error('ship-intent: record superseded by a concurrent attempt — running unrecorded');
            return 0; // no stdout token: this attempt owns nothing and must not delete on success
        }
    }
    catch (e) {
        if (!intentPersisted && boundNewMembership)
            cleanupFailedSourceMembership(opts.root, opts.branch, boundNewMembership);
        return fail(e instanceof Error ? e.message : String(e)); // lock contention → record nothing
    }
    process.stdout.write(`${intent.generation}\n`);
    emitShipIntentEvent(intent, opts.resumed);
    return 0;
}
/**
 * Delete the record — unconditionally without `generation`, else only when the stored generation
 * matches (compare-and-delete, the receipt ref's own discipline): a concurrent attempt that
 * re-recorded between this attempt's write and its success keeps its newer record for `--resume`.
 * With `shippedPaths`, a matching record is kept if it names paths this push did not ship. The
 * read-compare-rm shares the writer lock, so replacement cannot slip between comparison and rm.
 */
export function deleteIntent(root, branch, generation, shippedPaths) {
    const file = intentFile(root, branch);
    let kept = false; // exit 2: the caller must not describe this outcome as a release
    try {
        withLock(`${file}.lock`, () => {
            let stored = null;
            try {
                // SAFETY: only generation, source identity, and paths are read; proven* rechecks each.
                stored = JSON.parse(readFileSync(file, 'utf8'));
            }
            catch {
                if (generation)
                    return; // absent/torn — nothing this attempt owns
            }
            if (generation && stored) {
                if (provenString(stored.generation) !== generation)
                    return;
                if (shippedPaths) {
                    const extras = (provenStrings(stored.paths) ?? []).filter((p) => !shippedPaths.includes(p));
                    if (extras.length > 0) {
                        kept = true;
                        process.stderr.write(`ship: kept the recorded invocation for '${branch}' — a concurrent attempt contributed path(s) this push did not ship (${extras.join(', ')}); devkit ship --resume '${branch}' replays them\n`);
                        return;
                    }
                }
            }
            rmSync(file, { force: true });
            if (stored?.version === BRANCH_SCHEMA_VERSION)
                cleanupDeletedSourceMembershipRefs(root, branch);
        });
        if (kept)
            return 2;
    }
    catch {
        // Lock contention keeps the record, and the caller must hear that: a silently "successful"
        // delete leaves a spent record a later --resume replays as if the push never happened.
        process.stderr.write(`ship: recorded invocation for '${branch}' is locked by another attempt — not deleted; a later --resume would replay it until it expires (rm '${file}' to clear it now)\n`);
        return 1;
    }
    return 0;
}
/** Lock-shared proof that this process still owns the on-disk intent generation. */
export function ownsIntentGeneration(root, branch, generation) {
    const file = intentFile(root, branch);
    try {
        return withLock(`${file}.lock`, () => {
            try {
                // SAFETY: only generation is read, then proven as a string before comparison.
                const stored = JSON.parse(readFileSync(file, 'utf8'));
                return provenString(stored.generation) === generation;
            }
            catch {
                return false;
            }
        });
    }
    catch {
        return false;
    }
}
function main() {
    const [sub, ...rest] = process.argv.slice(2);
    const codecStatus = handlePathCodecCommand(sub, rest);
    if (codecStatus !== null)
        return codecStatus;
    const { values, booleans, links, donates, paths } = parseArgs(rest);
    const root = values.get('root');
    const branch = values.get('branch');
    if (!root || !branch)
        return fail('missing --root/--branch');
    if (sub === 'write') {
        const title = values.get('title');
        const mode = values.get('mode');
        if (title === undefined || !mode)
            return fail('write: missing --title/--mode');
        return writeIntent({
            root,
            branch,
            mode,
            sourceMode: values.get('source-mode'),
            title,
            base: values.get('base'),
            links,
            updatePrBody: booleans.has('update-pr-body'),
            draft: booleans.has('draft'),
            noStack: booleans.has('no-stack'),
            resumed: booleans.has('resumed'),
            mergePaths: booleans.has('merge-paths'),
            expectGeneration: values.get('expect-generation'),
            sourceAttemptId: values.get('source-attempt-id'),
            donatePaths: donates,
            bodyFilePath: values.get('body-file-path'),
            keepBodyFile: booleans.has('keep-body-file'),
            body: readFileSync(0), // Buffer, never utf8 — see the header
        }, paths);
    }
    if (sub === 'read') {
        const result = readIntent(root, branch);
        if ('reason' in result)
            return fail(result.reason);
        emitFields(result.intent);
        return 0;
    }
    if (sub === 'body-drift')
        return reportBodyDrift(readIntent(root, branch), values.get('generation'));
    if (sub === 'generation')
        return printGeneration(intentFile(root, branch));
    if (sub === 'owns') {
        const generation = values.get('generation');
        if (!generation)
            return fail('owns: missing --generation');
        return ownsIntentGeneration(root, branch, generation) ? 0 : 1;
    }
    if (sub === 'delete')
        return deleteIntent(root, branch, values.get('generation'), paths.length > 0 ? paths : undefined);
    return fail(`unknown subcommand '${String(sub)}' (write|read|body-drift|generation|owns|delete|validate-paths|validate-membership|filter-membership|frozen-drift)`);
}
// CLI entrypoint only; realpath keeps the guard correct through a symlinked module directory.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
    process.exitCode = main(); // let queued stdout (notably a large validated NUL path stream) drain
