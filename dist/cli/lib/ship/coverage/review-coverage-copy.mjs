/** Private copy of a review target's coverage artifact, so the coverage gate can judge it (never a link). */
import { closeSync, copyFileSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync, } from 'node:fs';
import { join, resolve } from 'node:path';
import { CLEAR_MARKER_NAME } from '../../../../gate-engine/coverage/failures.mjs';
import { COVERAGE_DIR } from '../../../../gate-engine/coverage/produce.mjs';
import { MANIFEST_NAME, parseManifest, readArtifact, sha256, } from '../../../../gate-engine/coverage/provenance.mjs';
import { runDirectReviewCli } from '../review/run-direct.mjs';
const REPORT_NAME = 'coverage-final.json';
const isLink = (path) => existsSync(path) && lstatSync(path).isSymbolicLink();
const lexists = (path) => {
    try {
        lstatSync(path);
        return true;
    }
    catch {
        return false;
    }
};
/** Write `bytes` to a NEW file and return its identity from the written descriptor itself. */
function writeExclusive(path, bytes) {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    try {
        const buffer = Buffer.from(bytes, 'utf8');
        let offset = 0;
        while (offset < buffer.length)
            offset += writeSync(fd, buffer, offset);
        fsyncSync(fd);
        const st = fstatSync(fd, { bigint: true });
        return `${st.dev}:${st.ino}:${st.mtimeNs}`;
    }
    finally {
        closeSync(fd);
    }
}
/** Copy `<target>/coverage` into `<worktree>/coverage`: the exact verified bytes, with the manifest
 * re-bound to the copy only when it bound the source (else unchanged, so provenance reads unknown). */
export function materializeReviewCoverage(targetRoot, worktreeTarget) {
    const source = resolve(targetRoot, COVERAGE_DIR);
    const destination = resolve(worktreeTarget, COVERAGE_DIR);
    if (lexists(destination))
        return 'destination-present';
    if (!existsSync(source))
        return 'absent';
    const report = join(source, REPORT_NAME);
    if (isLink(source) || isLink(report))
        return 'refused-symlink';
    const marker = join(source, CLEAR_MARKER_NAME);
    const hasMarker = existsSync(marker) && lstatSync(marker).isFile();
    if (!existsSync(report)) {
        if (!hasMarker)
            return 'absent';
        mkdirSync(destination);
        copyFileSync(marker, join(destination, CLEAR_MARKER_NAME), constants.COPYFILE_EXCL);
        return 'marker-only';
    }
    const artifact = readArtifact(report);
    // One read: the bytes validated are the bytes re-bound, so a sibling publish cannot slip between.
    const manifestPath = join(source, MANIFEST_NAME);
    const manifestText = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null;
    const manifest = manifestText === null ? null : parseManifest(manifestText);
    const bound = manifest !== null &&
        manifest.artifactSha256 === sha256(artifact.bytes) &&
        manifest.artifactIdentity === artifact.identity;
    mkdirSync(destination);
    const identity = writeExclusive(join(destination, REPORT_NAME), artifact.bytes);
    if (manifestText !== null) {
        const copied = bound && manifest !== null
            ? JSON.stringify({ ...manifest, artifactIdentity: identity })
            : manifestText;
        writeExclusive(join(destination, MANIFEST_NAME), copied);
    }
    if (hasMarker) {
        copyFileSync(marker, join(destination, CLEAR_MARKER_NAME), constants.COPYFILE_EXCL);
    }
    return bound ? 'copied-rebound' : 'copied-unbound';
}
const NARRATION = {
    absent: null,
    'destination-present': 'kept the snapshot’s own coverage/ (the target does not gitignore it)',
    'refused-symlink': 'NOT copying coverage/ — it is a symlink, so its numbers may describe another checkout',
    'copied-rebound': 'copied coverage ← target (provenance re-bound to the private copy)',
    'copied-unbound': 'copied coverage ← target (its manifest does not bind the artifact)',
    'marker-only': 'copied only the last-clear marker (the target has no coverage artifact)',
};
function runCli(args) {
    const [verb, target, worktree] = args;
    if (verb !== 'materialize' || !target || !worktree || args.length !== 3) {
        throw new Error('usage: review-coverage-copy materialize <target-root> <worktree-target>');
    }
    const line = NARRATION[materializeReviewCoverage(target, worktree)];
    if (line)
        console.error(`  ↳ review: ${line}`);
}
runDirectReviewCli(import.meta.url, runCli);
