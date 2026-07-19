#!/usr/bin/env node
/**
 * guard-coverage — the coverage gate. A deterministic guard (runs inside guard-deterministic when
 * `coverage` is in .devkit/config.json components.guards). Unlike the other gates it reads a runtime
 * artifact — coverage/coverage-final.json (istanbul/V8 shape, produced by `test:run:coverage`) — and
 * enforces the thresholds configured in guard.config.json `coverage`.
 *
 * The whole point is to be FAIL-CLOSED: a selected coverage gate must never silently pass unverified.
 *   - `coverage: false`      → explicit opt-out, exit 0.
 *   - artifact ABSENT        → exit 1 (run test:run:coverage first). NOT a fail-open (2).
 *   - artifact malformed     → exit 1 (corrupt data isn't verification).
 *   - artifact present       → enforce the threshold KEYS present in the config; a shortfall exits 1.
 * Exit contract for the orchestrator: 0 = pass/bypass, 1 = real failure. There is no `2` path.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGuardConfig } from "../config.mjs";
const COVERAGE_FILE = 'coverage/coverage-final.json';
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
/** Run the coverage gate against `cwd`. Returns the exit code (0 pass/bypass, 1 fail). */
export function runCoverage(cwd = process.cwd()) {
    const coverage = resolveGuardConfig(cwd).coverage;
    if (coverage === false) {
        console.log('⏭️  Coverage gate bypassed (coverage: false in guard.config.json).');
        return 0;
    }
    const file = resolve(cwd, COVERAGE_FILE);
    if (!existsSync(file)) {
        console.error(`🚫 Coverage gate FAILED — no coverage data (${COVERAGE_FILE} absent).`);
        console.error('   Coverage was NOT verified for this commit. Run `bun run test:run:coverage`');
        console.error('   first, then commit. To opt out entirely, set "coverage": false in');
        console.error('   guard.config.json.');
        return 1;
    }
    // One catch for BOTH failure modes: unparseable JSON and parseable-but-malformed shape
    // (computePercentages throws on the latter). Either way, corrupt data is not verification →
    // fail CLOSED with a clean message instead of crashing or reading garbage as coverage.
    let computed;
    try {
        computed = computePercentages(JSON.parse(readFileSync(file, 'utf8')));
    }
    catch {
        console.error(`🚫 Coverage gate FAILED — ${COVERAGE_FILE} is present but not valid coverage data.`);
        console.error('   Unparseable or malformed coverage data is not verification. Re-run `bun run test:run:coverage`.');
        return 1;
    }
    const shortfalls = METRICS.filter((m) => typeof coverage[m] === 'number' && computed[m] < coverage[m]);
    if (shortfalls.length > 0) {
        console.error('🚫 Coverage below threshold:');
        for (const m of shortfalls) {
            console.error(`   ${m}: ${computed[m]}% (min ${coverage[m]}%)`);
        }
        console.error('   Add tests to raise coverage, then run `bun run test:run:coverage`.');
        return 1;
    }
    const enforced = METRICS.filter((m) => typeof coverage[m] === 'number');
    const summary = enforced.length
        ? enforced.map((m) => `${m} ${computed[m]}%`).join(', ')
        : `statements ${computed.statements}%, functions ${computed.functions}%`;
    console.log(`✓ Coverage gate passed (${summary}).`);
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
