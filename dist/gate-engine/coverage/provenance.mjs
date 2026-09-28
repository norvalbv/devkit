/** Coverage artifact provenance (sc-3225): which tree did coverage-final.json measure? Rationale:
 * docs/decisions/coverage-gate.md, the 2026-09-27 sc-3225 notes. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { commitIndexEnv } from '../ratchets/commit-index.mjs';
export const MANIFEST_NAME = 'coverage-manifest.json';
/** A path that existed at HEAD but not in the working tree when the run started. */
export const DELETED = 'deleted';
/** A path written while the run was in flight: what it measured is unknowable, so nothing matches. */
export const TOUCHED = 'touched-during-run';
// The manifest is JSON this module wrote, but read back from a directory any tool may touch; parse it
// at the boundary so a hand-edited or foreign file reads as "no manifest", never as a partial one.
const manifestSchema = z.object({
    runId: z.string(),
    finishedAt: z.string(),
    roots: z.array(z.string()),
    head: z.string(),
    dirty: z.record(z.string(), z.string()),
    artifactSha256: z.string(),
    artifactIdentity: z.string(),
});
// Only the keys matter here; computePercentages has already validated each entry's shape.
const artifactKeysSchema = z.record(z.string(), z.unknown());
// The commit's own index, not the default one: a pathspec or `-a` commit stages into a temp index.
const git = (cwd, args, input) => execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd,
    env: commitIndexEnv(cwd),
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
});
const nulList = (out) => out.split('\0').filter(Boolean);
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** git's top level, plus the same directory as `cwd` spells it when a symlink sits in the prefix. */
function checkoutRoots(cwd, top) {
    const logical = resolve(cwd);
    let sub = '';
    try {
        sub = relative(top, realpathSync(logical));
    }
    catch {
        return [top];
    }
    const suffix = sub ? `${sep}${sub}` : '';
    const spelled = suffix && logical.endsWith(suffix) ? logical.slice(0, -suffix.length) : logical;
    return spelled === top || sub.startsWith('..') ? [top] : [top, spelled];
}
/** HEAD plus a blob id per path that differs from it, taken at run START; null when git cannot answer.
 * `--stdin-paths` applies `git add`'s clean filters, so ids compare directly with tree entries. */
export function snapshotSource(cwd) {
    try {
        const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
        const head = git(top, ['rev-parse', 'HEAD']).trim();
        const changed = new Set([
            ...nulList(git(top, ['diff', '--name-only', '--no-renames', '-z', 'HEAD'])),
            ...nulList(git(top, ['ls-files', '-o', '--exclude-standard', '-z'])),
        ]);
        const dirty = {};
        const toHash = [];
        for (const p of changed) {
            const abs = join(top, p);
            if (!existsSync(abs)) {
                dirty[p] = DELETED;
                continue;
            }
            // A symlink's blob is its link text, which hashing the path would not produce. Leaving it out
            // falls back to HEAD's entry, so a changed link surfaces as drift rather than a false fresh.
            if (lstatSync(abs).isSymbolicLink())
                continue;
            toHash.push(p);
        }
        // --stdin-paths is newline-delimited; a path containing one is hashed on its own.
        const plain = toHash.filter((p) => !p.includes('\n'));
        const blobs = plain.length
            ? git(top, ['hash-object', '--stdin-paths'], `${plain.join('\n')}\n`)
                .trim()
                .split('\n')
            : [];
        if (blobs.length !== plain.length)
            return null;
        for (const [i, p] of plain.entries()) {
            const blob = blobs[i];
            if (blob === undefined)
                return null;
            dirty[p] = blob;
        }
        for (const p of toHash.filter((q) => q.includes('\n'))) {
            dirty[p] = git(top, ['hash-object', '--', p]).trim();
        }
        return { roots: checkoutRoots(cwd, top), head, dirty };
    }
    catch {
        return null;
    }
}
/** The snapshot with every path whose mtime reached the run's start, or that the report measured but
 * no longer exists, marked TOUCHED; null when git or the filesystem cannot answer. */
export function markTouchedDuringRun(cwd, snapshot, startedAt, reportFile) {
    try {
        const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
        const files = nulList(git(top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
        const dirty = { ...snapshot.dirty };
        // Whole-second mtime filesystems round down; the start of that second errs toward a re-run.
        const since = Math.floor(startedAt / 1000) * 1000;
        for (const p of files) {
            const abs = join(top, p);
            if (existsSync(abs) && lstatSync(abs).mtimeMs >= since)
                dirty[p] = TOUCHED;
        }
        // Measured yet gone now: created and removed mid-run, so no mtime is left to see.
        if (existsSync(reportFile)) {
            for (const p of measuredPaths(readFileSync(reportFile, 'utf8'), snapshot.roots)) {
                if (!existsSync(join(top, p)))
                    dirty[p] = TOUCHED;
            }
        }
        return { ...snapshot, dirty };
    }
    catch {
        return null;
    }
}
const fileIdentity = (st) => `${st.dev}:${st.ino}:${st.mtimeNs}`;
/** Read the report through one descriptor, so its bytes and identity describe the same file. */
export function readArtifact(file) {
    const fd = openSync(file, 'r');
    try {
        return {
            identity: fileIdentity(fstatSync(fd, { bigint: true })),
            bytes: readFileSync(fd, 'utf8'),
        };
    }
    finally {
        closeSync(fd);
    }
}
/** Stage a manifest for this run's own report inside runDir, so a sibling publishing in between
 * leaves a hash mismatch the gate rejects. Returns its path. */
export function stageManifest(runDir, artifact, snapshot, runId) {
    const manifest = {
        runId,
        finishedAt: new Date().toISOString(),
        roots: snapshot.roots,
        head: snapshot.head,
        dirty: snapshot.dirty,
        artifactSha256: sha256(readFileSync(artifact)),
        artifactIdentity: fileIdentity(statSync(artifact, { bigint: true })),
    };
    const staged = join(runDir, MANIFEST_NAME);
    writeFileSync(staged, `${JSON.stringify(manifest)}\n`);
    return staged;
}
/** Move a staged manifest into coverage/. Best-effort, and it never deletes one: whatever stays is
 * bound to its own artifact by hash, so the gate reads a stale manifest as unknown, never fresh. */
export function publishManifest(staged, coverageDir) {
    try {
        renameSync(staged, join(coverageDir, MANIFEST_NAME));
    }
    catch {
        /* no manifest for this run: the gate reports provenance unknown */
    }
}
/** The manifest, or null when absent or not the shape we wrote. Never throws. */
export function readManifest(coverageDir) {
    try {
        const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(join(coverageDir, MANIFEST_NAME), 'utf8')));
        return parsed.success ? parsed.data : null;
    }
    catch {
        return null;
    }
}
/** path → blob id for `paths` in `treeish`. A path absent from the tree is absent from the map. */
function blobsIn(top, treeish, paths) {
    const out = new Map();
    if (paths.length === 0)
        return out;
    for (const entry of nulList(git(top, ['ls-tree', '-r', '-z', treeish, '--', ...paths]))) {
        const tab = entry.indexOf('\t');
        const oid = entry.slice(0, tab).split(' ')[2];
        if (oid)
            out.set(entry.slice(tab + 1), oid);
    }
    return out;
}
/** The artifact's measured files as repo-relative paths: istanbul keys by the absolute path in the
 * run's checkout, which `roots` records; keys outside every root are dropped. */
function measuredPaths(artifact, roots) {
    const prefixes = roots.map((r) => `${r.replaceAll('\\', '/').replace(/\/$/, '')}/`);
    const out = new Set();
    const parsed = artifactKeysSchema.safeParse(JSON.parse(artifact));
    if (!parsed.success)
        return out;
    for (const key of Object.keys(parsed.data)) {
        const k = key.replaceAll('\\', '/');
        const prefix = prefixes.find((p) => k.startsWith(p));
        if (prefix)
            out.add(k.slice(prefix.length));
    }
    return out;
}
/** Compare each briefed blob with the one the manifest says was measured. `artifact` is the exact
 * bytes the verdict came from; `classify` routes a path to production / test / other (never drift). */
export function checkProvenance(cwd, coverageDir, artifact, classify) {
    const manifest = readManifest(coverageDir);
    if (!manifest) {
        return { state: 'unknown', reason: 'no manifest — not produced by `devkit coverage-run`' };
    }
    // Hash AND file identity: byte-identical output from another run is a different measurement.
    if (sha256(artifact.bytes) !== manifest.artifactSha256 ||
        artifact.identity !== manifest.artifactIdentity) {
        return { state: 'unknown', reason: 'the artifact was replaced after its manifest was written' };
    }
    try {
        const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
        // The index as it stands when the gate runs, formatter output included: no exemption, no race.
        const now = git(top, ['write-tree']).trim();
        const briefed = nulList(git(top, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', 'HEAD', now]));
        const committed = blobsIn(top, now, briefed);
        const atHead = blobsIn(top, manifest.head, briefed.filter((p) => !Object.hasOwn(manifest.dirty, p)));
        const inArtifact = measuredPaths(artifact.bytes, manifest.roots);
        const production = [];
        const tests = [];
        for (const p of briefed) {
            const measured = Object.hasOwn(manifest.dirty, p)
                ? manifest.dirty[p]
                : (atHead.get(p) ?? DELETED);
            if (measured === (committed.get(p) ?? DELETED))
                continue;
            const kind = classify(p, inArtifact.has(p));
            if (kind === 'production')
                production.push(p);
            else if (kind === 'test')
                tests.push(p);
        }
        return production.length || tests.length
            ? { state: 'drift', manifest, production, tests }
            : { state: 'fresh', manifest };
    }
    catch {
        return { state: 'unknown', reason: 'git could not compare the briefed files' };
    }
}
