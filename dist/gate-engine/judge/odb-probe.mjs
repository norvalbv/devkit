/**
 * Tells an object-database fault apart from a gate verdict, for every gate that reads the staged
 * diff (sc-1366 / sc-1420).
 *
 * A ship died ten minutes in when `git diff --cached` hit `fatal: unable to read <oid>`. Each gate
 * caught it, printed `<gate>-gate: could not run — Command failed: git diff --cached`, and exited
 * its fail-open code — which the generated hook renders as a reviewer FAIL or a judge/auth outage.
 * Nothing named a defect, yet the output read exactly like one, and the next agent went hunting for
 * a code problem that did not exist. That misreport is what this module removes.
 *
 * WHY NOT match git's error text: verified against git 2.50.1, the `unable to read` family has ~30
 * members and most carry no oid at all (`unable to read index file`, `unable to read symlink %s`,
 * `unable to read files to diff`), while the corrupt-object wordings are `corrupt loose object '%s'`
 * and `loose object %s (stored in %s) is corrupt`. git is gettext-localised and no gate call site
 * forces LC_ALL=C, so a prose matcher silently no-ops under a non-English LANG; and a 40-hex anchor
 * reports a truncated prefix on a SHA-256 repository. So we ASK git instead of reading its prose.
 *
 * The probe is the same shape ship already runs (cli/lib/ship/assert-staged-set.sh:68-101) and
 * inherits its two rejections: `git write-tree` short-circuits on cache_tree_fully_valid() and so
 * cannot see a missing blob under a cached tree oid, and `git rev-list --objects` either aborts on
 * the first missing object or (with --missing=allow-any) silently omits it.
 *
 * TWO PROPERTIES worth knowing before reading a result:
 *
 *   1. This probe is STRICTLY MORE SENSITIVE than the failure it explains. Measured: delete a
 *      staged blob from the object database and `git diff --cached` still exits 0, because it
 *      re-reads the content from the working-tree file when that file still hashes to the oid the
 *      index names. It fails with `fatal: unable to read <oid>` only once NEITHER the object
 *      database NOR the worktree can supply the content. So a `missing` result names a real fault
 *      whether or not it is the one that threw — which is why this only ever runs inside a catch,
 *      and why it never claims to have found "the" cause.
 *
 *   2. It reads the INDEX side only. `git diff --cached` also reads HEAD-side trees and blobs, so
 *      `intact` means "no unreadable object among the staged entries" and nothing more. The
 *      fallback message says so rather than implying a verified-clean staged set.
 */
import { execFileSync } from 'node:child_process';
import { emitGateInfraFailure } from './gate-events.mjs';
/** A submodule's commit lives in the SUBMODULE's object database; absent here by design. */
const GITLINK_MODE = '160000';
/** `cat-file --batch-check` echoes `<name> missing` for an object it cannot resolve. */
const BATCH_CHECK_MISSING = / missing$/;
/** The 1 MiB default overflows around 15k index entries; matches evidence/staged-git.mts. */
const MAX_BUFFER = 64 * 1024 * 1024;
/**
 * This runs inside a catch, in a process whose git environment may itself be the fault. A hung
 * gate inside a ship reads as a stall rather than a failure, which is worse than the misreport
 * being fixed, so every child is bounded.
 */
const PROBE_TIMEOUT_MS = 15_000;
function git(cwd, args, input) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        timeout: PROBE_TIMEOUT_MS,
        // `cat-file --batch-check` reads stdin until EOF: without an explicit input it would block
        // forever on an inherited descriptor, and the timeout would be the only thing to notice.
        input: input ?? '',
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}
/** `<mode> <oid> <stage>\t<path>` records, NUL-separated so a newline in a path cannot split one. */
function stagedEntries(cwd) {
    const entries = [];
    for (const record of git(cwd, ['ls-files', '-s', '-z']).split('\0')) {
        if (!record)
            continue;
        const tab = record.indexOf('\t');
        if (tab === -1)
            continue;
        const [mode, oid] = record.slice(0, tab).split(' ');
        if (!mode || !oid || mode === GITLINK_MODE)
            continue;
        entries.push({ oid, path: record.slice(tab + 1) });
    }
    return entries;
}
/**
 * Every object the index names that this process cannot read, with the path that names it.
 * Never throws: a probe that itself fails says so rather than reporting a clean index.
 */
export function probeStagedObjects(cwd) {
    let entries;
    try {
        entries = stagedEntries(cwd);
    }
    catch (e) {
        return { status: 'probe-failed', reason: `git ls-files -s: ${message(e)}` };
    }
    if (!entries.length)
        return { status: 'intact' };
    const unique = [...new Set(entries.map((e) => e.oid))];
    let report;
    try {
        report = git(cwd, ['cat-file', '--batch-check'], `${unique.join('\n')}\n`);
    }
    catch (e) {
        return { status: 'probe-failed', reason: `git cat-file --batch-check: ${message(e)}` };
    }
    // `--batch-check` echoes the requested name then the verdict: `<oid> missing` for an absent one.
    const missing = new Set(report
        .split('\n')
        .filter((l) => BATCH_CHECK_MISSING.test(l))
        .map((l) => l.split(' ')[0] ?? '')
        .filter(Boolean));
    if (!missing.size)
        return { status: 'intact' };
    return { status: 'missing', objects: entries.filter((e) => missing.has(e.oid)) };
}
function message(e) {
    return e instanceof Error ? e.message : String(e);
}
/**
 * The evidence that tells sc-1420's two live candidate causes apart, captured at the moment of
 * failure: a genuine DELETION from the shared object database, or ship and the gate chain simply
 * reading DIFFERENT ones (ship inherits the caller's environment; gates are spawned through
 * __dk_no_git_env, which strips GIT_OBJECT_DIRECTORY and GIT_ALTERNATE_OBJECT_DIRECTORIES). Under
 * the second candidate NOTHING is missing, which is why the banner below never claims a deletion.
 */
function odbEnvironment(cwd) {
    const probe = (args) => {
        try {
            return git(cwd, args).trim();
        }
        catch (e) {
            return `<unavailable: ${message(e)}>`;
        }
    };
    return {
        git_common_dir: probe(['rev-parse', '--git-common-dir']),
        objects_dir: probe(['rev-parse', '--git-path', 'objects']),
        GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY ?? '<unset>',
        GIT_ALTERNATE_OBJECT_DIRECTORIES: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES ?? '<unset>',
        GIT_INDEX_FILE: process.env.GIT_INDEX_FILE ?? '<unset>',
    };
}
/**
 * gate-events.mts rests its concurrent-writer safety on one property: each event is a single
 * sub-4KB append, atomic on APFS/ext4, so two judges sharing the DEFAULT machine-wide sink
 * (~/.devkit/telemetry/gate-events.jsonl) cannot tear each other's lines. Every event before this
 * one was fixed-size or bounded by a reviewer list; `gate_infra_failure` is the first whose payload
 * scales with repo content, so it is the first that could break that assumption — producing a line
 * the collector cannot reassemble (it tolerates a partial TRAILING line, not a splice of two
 * writers).
 *
 * Bounding only the oid/path arrays is NOT enough, and that half-measure was the first review
 * finding here: `detail` carries a raw caught-error message and `odb_env` carries
 * GIT_ALTERNATE_OBJECT_DIRECTORIES, an arbitrarily long colon-separated list. So the WHOLE event is
 * measured after serialization and shrunk until it fits — a field cap is not a byte bound.
 * `total`/`omitted`/`truncated` keep a shrunk event from reading as a smaller fault than it was.
 */
/**
 * 2KB, not 3KB: `emitGateEvent` merges `runEnvelope()` (repo, branch, ship_id) and `ts` AFTER this
 * returns, and those are not capped here — a long CI branch name is a real input. The remaining
 * ~2KB is the margin that keeps the final line inside the 4KB append.
 */
export const EVENT_BUDGET = 2048;
const FIELD_CAP = 512;
/** UTF-8 bytes, never `.length`: the sink's limit is a byte limit (see the budget note above). */
function bytes(v) {
    return Buffer.byteLength(v, 'utf8');
}
/**
 * Clip to a BYTE cap. `.length` would count UTF-16 code units, and JSON.stringify does not escape
 * non-ASCII — so a path of 3-byte characters measures 512 "long" and serializes to ~1.5KB.
 */
function clip(v, cap = FIELD_CAP) {
    if (bytes(v) <= cap)
        return v;
    let end = Math.min(v.length, cap);
    while (end > 0 && bytes(v.slice(0, end)) > cap)
        end--;
    return `${v.slice(0, end)}…[+${v.length - end}]`;
}
/**
 * The event payload, shrunk until the serialized line fits the atomic-append budget.
 *
 * Shrinks in three stages, because dropping oid/path pairs alone has no floor: at zero pairs the
 * capped `odb_env` (five vars) plus `detail` can still exceed the budget on their own, which was
 * the review finding against the first version of this. So it drops pairs, then tightens the field
 * cap, and finally falls back to a counts-only event that cannot exceed a few hundred bytes for
 * any input at all. Whole pairs only — never a partial one, so every entry that survives is
 * readable — and `total`/`omitted`/`truncated` keep a shrunk event from reading as a smaller fault
 * than it was.
 */
export function boundedPayload(objects, env, detail) {
    const build = (n, cap) => {
        const kept = objects.slice(0, n);
        const omitted = objects.length - kept.length;
        return {
            oids: kept.map((o) => o.oid),
            paths: kept.map((o) => clip(o.path, Math.min(cap, 200))),
            total: objects.length,
            odb_env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, clip(v, cap)])),
            detail: clip(detail, cap),
            ...(omitted > 0 ? { omitted } : {}),
        };
    };
    // Never start the descent above what the budget could possibly hold. An oid+path pair costs at
    // least ~50 serialized bytes, so on a corrupt index of the size this module cites (~15k entries)
    // the old `n = objects.length` start burned thousands of multi-hundred-kilobyte serializations —
    // inside a commit-time catch, where the header says a stall is worse than the misreport.
    const maxPairs = Math.min(objects.length, Math.ceil(EVENT_BUDGET / 50));
    for (const cap of [FIELD_CAP, 128, 32]) {
        for (let n = maxPairs; n >= 0; n--) {
            const payload = build(n, cap);
            if (bytes(JSON.stringify(payload)) <= EVENT_BUDGET)
                return payload;
        }
    }
    // Guaranteed floor: fixed-size regardless of input. A count is still evidence; a torn line is not.
    return { total: objects.length, omitted: objects.length, truncated: true };
}
/**
 * Exit code reserved for a verified object-database fault.
 *
 * It needs NO branch in the generated hook, which is the point: husky-block.mts renders exit 1 as
 * "A reviewer FAILED (opus-confirmed)" and exit 3 as "judge unavailable — check `claude` CLI
 * auth/quota"; anything else falls through to a neutral "unexpected exit N — blocking the commit".
 * So simply not BEING 1 or 3 removes the false verdict, while the banner above that line carries
 * the oid, the path and the remedy — on every already-installed consumer hook, with no
 * regeneration and no stale-hook window.
 */
export const ODB_FAULT_EXIT = 4;
const STRICT_SUFFIX = ' (strict ship mode: failing closed)';
/**
 * Print the honest thing for a gate that could not run, emit its telemetry, and return the exit
 * code to use. ODB_FAULT_EXIT when the fault is verified; the caller's own code otherwise.
 */
export function reportGateInfraFailure(gate, label, err, cwd, fallbackExit, fallback = {}) {
    const result = probeStagedObjects(cwd);
    const detail = message(err);
    const fallbackMessage = fallback.message ??
        `${label}: could not run — ${detail}${fallback.strict ? STRICT_SUFFIX : ''}`;
    if (result.status === 'missing') {
        // `_by_gate`, never ship's `staged_objects_missing`: ship inherits the caller's git environment
        // and gates are spawned through __dk_no_git_env, so "ship says readable + gate says unreadable"
        // is the evidence that separates a deletion from a split object database. sc-1420 left that
        // question open on purpose; one shared token would erase the only thing that answers it.
        const fault = 'staged_object_unreadable_by_gate';
        const env = odbEnvironment(cwd);
        console.error(`${label}: STAGED OBJECT DATABASE FAULT — not a review finding.`);
        console.error('   No defect was named. This gate could not READ the staged content below.');
        for (const { oid, path } of result.objects)
            console.error(`     ${oid}  ${path}`);
        console.error(`   Underlying error: ${detail}`);
        console.error('   Re-stage those paths (git add -- <path>) and re-run.');
        console.error('   --- object-database evidence (sc-1420) ---');
        for (const [k, v] of Object.entries(env))
            console.error(`   ${k}: ${v}`);
        emitGateInfraFailure({ gate, fault, ...boundedPayload(result.objects, env, detail) });
        return ODB_FAULT_EXIT;
    }
    if (result.status === 'probe-failed') {
        // Keeps the CALLER's exit code, unlike the confirmed-fault branch above. Failing to look is
        // not evidence of a fault, and ODB_FAULT_EXIT blocks — turning "could not check" into a hard
        // block would harden a documented fail-open on no evidence at all. Say what happened and let
        // the gate's own contract stand.
        const fault = 'staged_index_unenumerable_by_gate';
        console.error(`${label}: could not run, and could not check why — not a review finding.`);
        console.error('   No defect was named. This gate could not enumerate the index to verify its');
        console.error(`   objects: ${result.reason}`);
        console.error(`   Underlying error: ${detail}`);
        emitGateInfraFailure({ gate, fault, reason: clip(result.reason), detail: clip(detail) });
        return fallbackExit;
    }
    // Deliberately does NOT say the staged set is clean. `git diff --cached` also reads HEAD-side
    // trees and blobs, which an index-only probe never enumerates, so "intact" means "no unreadable
    // object among the STAGED entries" and nothing more.
    console.error(fallbackMessage);
    console.error('   (no unreadable object among the staged entries — note this check does not cover the');
    console.error('    HEAD-side objects `git diff --cached` also reads)');
    emitGateInfraFailure({ gate, fault: 'unclassified', detail: clip(detail) });
    return fallbackExit;
}
