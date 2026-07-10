// Per-completion progress for the review gate — the structured contract that replaced the old
// heartbeat-PROSE parsing. On a ship the banner (cli/lib/ship/commit-with-gate-capture.sh) used to
// `awk` the stderr log for `guard-review: <name> — <STATUS>` lines to name the reviewers a timeout
// killed mid-flight; a wording tweak on either side silently broke it. Now run-review writes
// {running, completed} reviewer names to the JSON file the ship exports as DEVKIT_REVIEW_PROGRESS,
// and the banner reads it through the ONE shared reader below (`guard-review unfinished <file>`), so
// the writer and reader can't drift — an integration test exercises engine → file → reader together.
//
// Best-effort: writing progress must never fail the gate (it's telemetry for a kill that may not
// come); a missing/unparsable file simply means "nothing to report".
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
/** Persist the current {running:[name], completed:[name]} snapshot. Swallows IO errors. */
export function writeProgress(file, progress) {
    try {
        writeFileSync(file, JSON.stringify(progress));
    }
    catch {
        /* progress is best-effort telemetry — never fail the gate over it */
    }
}
/** Parse the snapshot, or null when the file is absent/unparsable. */
export function readProgress(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}
/** The `running` reviewers with no `completed` entry — what a mid-flight kill left unfinished. */
export function unfinishedReviewers(file) {
    const p = readProgress(file);
    if (!p)
        return [];
    const done = new Set(p.completed ?? []);
    return (p.running ?? []).filter((n) => !done.has(n));
}
/** Remove the file — the gate ran to completion, so nothing is unfinished for the banner to report. */
export function clearProgress(file) {
    rmSync(file, { force: true });
}
// CLI: `node progress.mjs unfinished <file>` prints the unfinished reviewer names (space-joined).
// The ship banner (commit-with-gate-capture.sh) shells here via a path RELATIVE to itself, so it
// resolves in every install mode without a `bunx`/registry lookup — and this module imports only
// `fs`, so the read stays cheap. Guarded so importing progress.mjs never triggers the CLI.
if (/[/\\]progress\.m[jt]s$/.test(process.argv[1] ?? '') && process.argv[2] === 'unfinished') {
    process.stdout.write(unfinishedReviewers(process.argv[3] ?? '').join(' '));
}
