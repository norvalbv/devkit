/** What both coverage gate modes print and classify with: remedies, path listing, review notices. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { sourceMatchers } from '../config.mjs';
import { appendReviewNotice } from '../deterministic/reason.mjs';
import { emitGateEvent } from '../judge/gate-events.mjs';
import { canonicalPath } from './dependencies.mjs';
import { displayPath, formatClearMarker, readClearMarker } from './failures.mjs';
import { COVERAGE_DIR, COVERAGE_FILE } from './produce.mjs';
export { canonicalPath };
// Every failure arm names its escape hatch. `export` on its own line, never an inline env prefix,
// which command-rewriting shell hooks can silently strip from a ship.
export const BYPASS_REMEDY = [
    '   Not your debt? If the BASE branch already fails this and your diff did not cause it,',
    '   ship without coverage for this run:  export GUARD_COVERAGE_OK=1',
];
// States its condition: ship reads guard.config.json from the committed base, so a local-only
// `coverage: false` silently no-ops there, and an agent once burned an approved bypass on that.
export const OPT_OUT_REMEDY = [
    '   Repo-wide opt-out: "coverage": false in guard.config.json — but `devkit ship`',
    '   reads that file from the COMMITTED tree, so a local-only edit changes nothing.',
];
const MAX_LISTED = 10;
export function listPaths(paths, cwd, top) {
    const lines = paths.slice(0, MAX_LISTED).map((p) => `     ${displayPath(resolve(top, p), cwd)}`);
    if (paths.length > MAX_LISTED)
        lines.push(`     …and ${paths.length - MAX_LISTED} more`);
    return lines;
}
export const TEST_PATH = /\.(test|spec)\.|(^|\/)__tests__\//;
/** production / test / other; a MEASURED path is source whatever sourceExtensions says, and a package
 * gate owns only its subtree plus what its artifact measured. `other` is never drift. */
export function classifier(extensions, pkgPrefix) {
    const { isSource } = sourceMatchers(extensions);
    return (path, measured) => {
        if (!measured && pkgPrefix && !path.startsWith(`${pkgPrefix}/`))
            return 'other';
        if (!measured && !isSource(path))
            return 'other';
        return TEST_PATH.test(path) ? 'test' : 'production';
    };
}
/** The repo root the provenance paths are relative to; cwd itself when git cannot say. */
export function repoTop(cwd) {
    try {
        return execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    }
    catch {
        return cwd;
    }
}
export function emitProvenance(p) {
    emitGateEvent({
        type: 'coverage_provenance',
        gate: 'coverage',
        state: p.state,
        production_count: p.state === 'drift' ? p.production.length : 0,
        test_count: p.state === 'drift' ? p.tests.length : 0,
        detail: p.state === 'unknown' ? p.reason : p.manifest.runId,
    });
}
// Names the PHYSICAL artifact so a verdict borrowed from another checkout is visible.
export function artifactLine(file) {
    return `   read ${canonicalPath(file)}`;
}
/** Tell review-target.sh's verdict line that coverage went unmeasured. */
export function recordReviewNotice(reason) {
    appendReviewNotice(`coverage=not-measured reason=${reason}`);
}
export function reviewNotMeasuredAbsent(cwd) {
    console.log(`⚠️  Coverage NOT MEASURED in this review — no ${COVERAGE_FILE} in the target checkout.`);
    const marker = readClearMarker(resolve(cwd, COVERAGE_DIR));
    if (marker)
        for (const line of formatClearMarker(marker, cwd))
            console.log(line);
    console.log("   `devkit review` copies the target's artifact when one exists; it never makes one.");
    console.log('   Measure it: run `devkit coverage-run` in the target, then review again.');
    console.log('   `devkit ship` and commits still BLOCK without it.');
    recordReviewNotice('absent');
    return 2;
}
export function reviewNotMeasuredEmpty(empty) {
    console.log(`⚠️  Coverage NOT MEASURED in this review — the target's ${COVERAGE_FILE} ${empty}.`);
    console.log('   Measure it: run `devkit coverage-run` in the target, then review again.');
    console.log('   `devkit ship` and commits still BLOCK on an empty artifact.');
    recordReviewNotice('empty');
    return 2;
}
