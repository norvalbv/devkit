#!/usr/bin/env node
/** guard-coverage: enforce guard.config.json `coverage` thresholds on coverage-final.json, fail-CLOSED.
 * Exit 0 pass/bypass, 1 fail, 2 NOT MEASURED (review only). Rulings: docs/decisions/coverage-gate.md. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { coverageBypassed, resolveGuardConfig, sourceMatchers, } from '../config.mjs';
import { emitGateEvent } from '../judge/gate-events.mjs';
import { displayPath, formatClearMarker, humanAge, readClearMarker } from './failures.mjs';
// Shared with the PRODUCER (`devkit coverage-run`) so the path this gate reads and the path that
// runner writes can never drift apart.
import { COVERAGE_DIR, COVERAGE_FILE } from './produce.mjs';
import { checkProvenance, readArtifact, } from './provenance.mjs';
// The metrics we can compute from an istanbul/V8 coverage-final.json. Only the KEYS a consumer
// configured are enforced; the rest are computed but ignored.
const METRICS = ['statements', 'functions', 'branches', 'lines'];
const pct = (covered, total) => total === 0 ? 100 : parseFloat(((covered / total) * 100).toFixed(1));
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * Aggregate statement/function/branch/line percentages across every file in a coverage-final.json.
 * Validates the shape and THROWS on parseable-but-malformed input (a non-object root, a null/array/
 * non-object entry, a non-array branch counter) so the caller's catch fails CLOSED with a clean
 * message — rather than crashing on a TypeError, or silently reading garbage as 100%.
 */
export function computePercentages(cov) {
    if (!isRecord(cov))
        throw new Error('coverage-final.json is not an object');
    let ts = 0, cs = 0, tf = 0, cf = 0, tb = 0, cb = 0, tl = 0, cl = 0;
    for (const entry of Object.values(cov)) {
        if (!isRecord(entry))
            throw new Error('coverage entry is not an object');
        const file = entry;
        const s = Object.values(file.s ?? {});
        ts += s.length;
        cs += s.filter((v) => v > 0).length;
        const fn = Object.values(file.f ?? {});
        tf += fn.length;
        cf += fn.filter((v) => v > 0).length;
        for (const arms of Object.values((file.b ?? {}))) {
            if (!Array.isArray(arms))
                throw new Error('branch counter is not an array');
            tb += arms.length;
            cb += arms.filter((v) => v > 0).length;
        }
        // Lines (istanbul's definition): a source line is covered when ANY statement starting on it ran.
        const lineHit = new Map();
        for (const [id, loc] of Object.entries(file.statementMap ?? {})) {
            const line = loc.start?.line;
            if (typeof line !== 'number')
                continue;
            const ran = (file.s?.[id] ?? 0) > 0;
            lineHit.set(line, (lineHit.get(line) ?? false) || ran);
        }
        tl += lineHit.size;
        cl += [...lineHit.values()].filter(Boolean).length;
    }
    return {
        statements: pct(cs, ts),
        functions: pct(cf, tf),
        branches: pct(cb, tb),
        lines: pct(cl, tl),
    };
}
// Printed by EVERY failure arm. A gate that blocks without naming its own escape hatch is the bug
// this fixes: agents met a hard block, found no knob (unlike decisions/review/qavis, which all print
// theirs), and either fixed out-of-scope coverage or gave up. `export` on its own line, NOT an inline
// `GUARD_COVERAGE_OK=1 devkit ship …` prefix — skills/using-devkit/SKILL.md documents that inline env
// prefixes on a ship can be silently stripped by command-rewriting shell hooks (the
// SHIP_COMMIT_TIMEOUT lesson), which would make the bypass look broken.
const BYPASS_REMEDY = [
    '   Not your debt? If the BASE branch already fails this and your diff did not cause it,',
    '   ship without coverage for this run:  export GUARD_COVERAGE_OK=1',
];
const MAX_LISTED = 10;
function listPaths(paths, cwd, top) {
    const lines = paths.slice(0, MAX_LISTED).map((p) => `     ${displayPath(resolve(top, p), cwd)}`);
    if (paths.length > MAX_LISTED)
        lines.push(`     …and ${paths.length - MAX_LISTED} more`);
    return lines;
}
const TEST_PATH = /\.(test|spec)\.|(^|\/)__tests__\//;
/** production / test / other; a MEASURED path is source whatever sourceExtensions says, and a package
 * gate owns only its subtree plus what its artifact measured. `other` is never drift. */
function classifier(extensions, pkgPrefix) {
    const { isSource } = sourceMatchers(extensions);
    return (path, measured) => {
        if (!measured && pkgPrefix && !path.startsWith(`${pkgPrefix}/`))
            return 'other';
        if (!measured && !isSource(path))
            return 'other';
        return TEST_PATH.test(path) ? 'test' : 'production';
    };
}
const canonicalPath = (p) => {
    try {
        return realpathSync(p);
    }
    catch {
        return resolve(p);
    }
};
/** The repo root the provenance paths are relative to; cwd itself when git cannot say. */
function repoTop(cwd) {
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
function emitProvenance(p) {
    emitGateEvent({
        type: 'coverage_provenance',
        gate: 'coverage',
        state: p.state,
        production_count: p.state === 'drift' ? p.production.length : 0,
        test_count: p.state === 'drift' ? p.tests.length : 0,
        detail: p.state === 'unknown' ? p.reason : p.manifest.runId,
    });
}
// Names the PHYSICAL artifact so a borrowed verdict is visible (sc-3491).
function artifactLine(file) {
    return `   read ${canonicalPath(file)}`;
}
/** Tell review-target.sh's verdict line that coverage went unmeasured. Written only into this review's
 * own temp root, so a nested run cannot reach an outer review's file. Advisory: never throws. */
function recordReviewNotice(reason) {
    const file = process.env.DEVKIT_REVIEW_NOTICES;
    const root = process.env.DEVKIT_REVIEW_TEMP_ROOT;
    if (!file || !root || !isAbsolute(file) || !isAbsolute(root))
        return;
    if (!resolve(file).startsWith(`${resolve(root)}/`))
        return;
    try {
        appendFileSync(file, `coverage=not-measured reason=${reason}\n`);
    }
    catch {
        // The deterministic runner's skip banner still names the gate.
    }
}
function reviewNotMeasuredAbsent(cwd) {
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
/** Run the coverage gate against `cwd`. Returns the exit code (0 pass/bypass, 1 fail, 2 review-only
 * NOT MEASURED). */
export function runCoverage(cwd = process.cwd()) {
    // BEFORE resolveGuardConfig — it THROWS on a malformed guard.config.json, and an explicit operator
    // bypass must not be defeated by an unrelated config typo it isn't being asked to care about.
    if (coverageBypassed()) {
        // Deliberately worded apart from the `coverage: false` line below (⚠️/BYPASSED vs ⏭️/bypassed):
        // a ship log or a human skimming must be able to tell a one-off run bypass from a repo-wide opt-out.
        console.log('⚠️  Coverage gate BYPASSED for this run (GUARD_COVERAGE_OK=1).');
        console.log('   Coverage was NOT verified for this commit.');
        emitGateEvent({
            type: 'gate_result',
            gate: 'coverage',
            status: 'bypassed',
            bypass: 'GUARD_COVERAGE_OK',
            detail: 'GUARD_COVERAGE_OK',
        });
        return 0;
    }
    const coverage = resolveGuardConfig(cwd).coverage;
    if (coverage === false) {
        console.log('⏭️  Coverage gate bypassed (coverage: false in guard.config.json).');
        return 0;
    }
    const reviewMode = process.env.DEVKIT_RUN_MODE === 'review';
    const file = resolve(cwd, COVERAGE_FILE);
    if (!existsSync(file)) {
        if (reviewMode)
            return reviewNotMeasuredAbsent(cwd);
        console.error(`🚫 Coverage gate FAILED — no coverage data (${COVERAGE_FILE} absent).`);
        const marker = readClearMarker(resolve(cwd, COVERAGE_DIR));
        if (marker)
            for (const line of formatClearMarker(marker, cwd))
                console.error(line);
        console.error('   Coverage was NOT verified for this commit. Generate it with');
        console.error('   `bun run test:run:coverage`, then re-run. Under `devkit ship` the artifact is');
        console.error('   SYMLINKED IN from THIS worktree (never the main checkout) — so it must exist THERE; the ship');
        console.error('   worktree cannot produce one.');
        console.error('   Sharing this checkout with another agent? Point that script at `devkit');
        console.error('   coverage-run` — concurrent plain `vitest --coverage` runs delete each other.');
        for (const line of BYPASS_REMEDY)
            console.error(line);
        // The old text said only "set coverage: false in guard.config.json" — which SILENTLY NO-OPS under
        // ship, because the ship worktree reads that file from the committed base, not your working tree.
        // Field transcripts show an agent burning a user-APPROVED bypass on exactly this, then having to
        // go back and re-ask. Advice that cannot work must not be offered without its condition.
        console.error('   Repo-wide opt-out: "coverage": false in guard.config.json — but `devkit ship`');
        console.error('   reads that file from the COMMITTED tree, so a local-only edit changes nothing.');
        return 1;
    }
    // One catch for BOTH failure modes: unparseable JSON and parseable-but-malformed shape
    // (computePercentages throws on the latter). Either way, corrupt data is not verification →
    // fail CLOSED with a clean message instead of crashing or reading garbage as coverage.
    let computed;
    let artifact;
    try {
        artifact = readArtifact(file);
        computed = computePercentages(JSON.parse(artifact.bytes));
    }
    catch {
        console.error(`🚫 Coverage gate FAILED — ${COVERAGE_FILE} is present but not valid coverage data.`);
        console.error(artifactLine(file));
        console.error('   Unparseable or malformed coverage data is not verification. Re-run `bun run test:run:coverage`.');
        for (const line of BYPASS_REMEDY)
            console.error(line);
        return 1;
    }
    const top = repoTop(cwd);
    const pkgPrefix = relative(canonicalPath(top), canonicalPath(cwd)).replaceAll('\\', '/');
    const readProvenance = () => {
        const p = checkProvenance(cwd, resolve(cwd, COVERAGE_DIR), artifact, classifier(resolveGuardConfig(cwd).sourceExtensions, pkgPrefix));
        emitProvenance(p);
        return p;
    };
    // Review judges freshness BEFORE thresholds: a stale artifact's percentages describe other code,
    // so they can neither pass nor fail this tree.
    let provenance = reviewMode ? readProvenance() : undefined;
    if (provenance?.state === 'drift' && provenance.production.length > 0) {
        const age = humanAge(Date.now() - Date.parse(provenance.manifest.finishedAt));
        console.log(`⚠️  Coverage NOT MEASURED in this review — the artifact predates ${provenance.production.length} briefed file(s):`);
        for (const line of listPaths(provenance.production, cwd, top))
            console.log(line);
        console.log(`   The artifact (run ${provenance.manifest.runId}, measured ${age} ago) never saw`);
        console.log('   these versions. Re-run `devkit coverage-run` in the target after your last');
        console.log('   source edit, then review again. `devkit ship` BLOCKS on a stale artifact.');
        recordReviewNotice('stale');
        return 2;
    }
    const shortfalls = METRICS.filter((m) => typeof coverage[m] === 'number' && computed[m] < coverage[m]);
    if (shortfalls.length > 0) {
        console.error('🚫 Coverage below threshold:');
        for (const m of shortfalls) {
            console.error(`   ${m}: ${computed[m]}% (min ${coverage[m]}%)`);
        }
        console.error(artifactLine(file));
        console.error('   Add tests to raise coverage, then run `bun run test:run:coverage`.');
        for (const line of BYPASS_REMEDY)
            console.error(line);
        return 1;
    }
    // Thresholds met — but met BY WHAT? The artifact is linked in from the developer's checkout, so a
    // source edit after the coverage run leaves a verdict about code it never measured (sc-3225).
    provenance ??= readProvenance();
    const age = provenance.state === 'unknown'
        ? ''
        : humanAge(Date.now() - Date.parse(provenance.manifest.finishedAt));
    if (provenance.state === 'drift') {
        if (provenance.production.length > 0) {
            console.error(`🚫 Coverage gate FAILED — coverage artifact predates ${provenance.production.length} briefed file(s):`);
            for (const line of listPaths(provenance.production, cwd, top))
                console.error(line);
            console.error(`   The artifact (run ${provenance.manifest.runId}, measured ${age} ago) never saw these`);
            console.error(artifactLine(file));
            console.error('   versions, so its percentages describe different code. Re-run `bun run test:run:coverage`');
            console.error('   (a full run) after your last source edit, then re-run. Rewritten only by the');
            console.error('   commit formatter? Run the formatter before coverage so it measures those bytes.');
            for (const line of BYPASS_REMEDY)
                console.error(line);
            return 1;
        }
        console.log(`⚠️  Coverage artifact predates ${provenance.tests.length} briefed test file(s) — passing, but re-run coverage if they matter:`);
        for (const line of listPaths(provenance.tests, cwd, top))
            console.log(line);
    }
    else if (provenance.state === 'unknown') {
        console.log(`⚠️  Coverage artifact provenance unknown (${provenance.reason}).`);
        console.log('   Its percentages may describe a tree other than the one being committed.');
    }
    const enforced = METRICS.filter((m) => typeof coverage[m] === 'number');
    const summary = enforced.length
        ? enforced.map((m) => `${m} ${computed[m]}%`).join(', ')
        : `statements ${computed.statements}%, functions ${computed.functions}%`;
    const measured = provenance.state === 'unknown'
        ? ''
        : ` — artifact run ${provenance.manifest.runId}, measured ${age} ago`;
    console.log(`✓ Coverage gate passed (${summary})${measured}.`);
    console.log(artifactLine(file));
    return 0;
}
function runCli(cmd) {
    if (cmd !== undefined && cmd !== 'gate') {
        console.error('usage: guard-coverage [gate]');
        process.exit(2);
    }
    process.exit(runCoverage(process.cwd()));
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    runCli(process.argv[2]);
}
