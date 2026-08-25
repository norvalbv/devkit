/**
 * Content-addressed archive of a reviewer's FAIL diff bytes — the exact same bytes hashed into
 * `diff_sha256` (evidence/scope.mts's `emitReviewScope`), captured verbatim so a block can be
 * reproduced/inspected later without re-materializing a staged tree that has long since moved on.
 *
 * Layout: <telemetry-dir>/diffs/<sha256(diffText)>.diff.gz — content-addressed, so a hash that
 * already has an archived file is a silent no-op (same hash ⇒ same bytes, nothing to rewrite).
 * Sibling to transcripts/ (judge/transcript-store.mts), same directory convention, same
 * env-keyed/fs-only/never-throws contract — but unlike transcripts/ (one file per run) this store
 * dedups on content, not on run id, so it needs no run-id gate and no per-run pruning.
 *
 * Fires ONLY from runReviewGate's FAIL path (run-review.mts, inside the mapLimit `.then` callback)
 * — never from runCascade/cascadeVerdict, which bench (eval/reviewers/bench.mts,
 * eval/conventions/bench.mts) calls directly. Keeping the write in runReviewGate only, not in the
 * cascade both call, is what keeps bench runs from ever archiving anything.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { telemetrySink } from '../../judge/run-context.mjs';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
// Independent of, and deliberately larger than, the judge-facing EVIDENCE_TOTAL_CAP
// (diff-evidence.mts, 60000 chars) — that cap sizes what a JUDGE reads on stdin; this sizes
// worst-case disk use for an ARCHIVAL copy. gitCached's 64 MiB maxBuffer (run-review.mts) is the
// hard upstream ceiling — a diff past that already throws before any reviewer runs — but a smaller,
// explicit cap here keeps one pathological FAIL from burning tens of MB of disk per reviewer.
const ARCHIVE_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB raw, pre-gzip
/**
 * Archive a FAIL's exact diff bytes to `<telemetry-dir>/diffs/<sha256(diffText)>.diff.gz`. Returns
 * the ref (relative to the telemetry dir), or `null` when telemetry is off, the diff exceeds
 * ARCHIVE_MAX_BYTES, or any IO step fails. Never throws — archiving is best-effort telemetry, never
 * a gate; a write failure must never affect a reviewer's verdict or the gate's exit code.
 *
 * Deliberately NOT stamped into the `review_result` event as a new field: the filename is a
 * deterministic function of `diff_sha256`, which the `review_scope` event (evidence/scope.mts)
 * already carries for every selected reviewer — that hash IS the join key, so a reader derives
 * `diffs/<diff_sha256>.diff.gz` itself rather than needing a second pointer field. The call site
 * (run-review.mts) therefore invokes this purely for its side effect and discards the return value;
 * it stays a return (not void) so the archive's fs behaviour is directly unit-testable here.
 *
 * Content-addressed dedup: the file is created with the exclusive flag (`wx`); an EEXIST is treated
 * as an already-archived success (same hash ⇒ identical bytes) rather than bumped to a new name —
 * unlike `saveTranscriptUnique`'s collision handling, which is for DIFFERENT content sharing a label.
 */
export function archiveFailedDiff(diffText) {
    const sink = telemetrySink();
    if (!sink)
        return null;
    if (Buffer.byteLength(diffText, 'utf8') > ARCHIVE_MAX_BYTES)
        return null;
    try {
        const rel = path.join('diffs', `${sha256(diffText)}.diff.gz`);
        const abs = path.join(path.dirname(sink), rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        try {
            writeFileSync(abs, gzipSync(Buffer.from(diffText, 'utf8')), { flag: 'wx' });
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
            // Already archived under this hash — same bytes, nothing to rewrite.
        }
        return rel;
    }
    catch {
        return null; // best-effort — never fail a gate over archiving
    }
}
