#!/usr/bin/env node
/**
 * co-occurrence matcher — automatic cross-file duplication detector.
 *
 * Reads a search-code embedding index (the only store holding code + description
 * embeddings) and emits duplication-candidate pairs via the tiered rule in
 * classify.mjs. Name-agnostic: compares code semantics, not symbol names.
 *
 * ── Portability (W-3) ────────────────────────────────────────────────────────
 * Every consumer path — the index, the allowlist, the labels for bench — resolves
 * relative to the CONSUMER cwd (process.cwd()) via resolveGuardConfig, never the
 * package dir. The ONLY package-relative file is labels.json (engine-shipped bench
 * data, not consumer data). Run from another repo's node_modules, this scans THAT
 * repo's index + allowlist.
 *
 * The index path comes from config.indexPath (guard.config.json `indexPath` /
 * GUARD_INDEX_PATH). When it is null — the common case, since most repos have no
 * search-code index — the matcher OPTS OUT: scan/gate fail open (exit 2), bench
 * errors. It never crashes for lack of an index. The SEARCH_CODE_DB env still
 * overrides the resolved path (fixtures/tests).
 *
 * Modes:
 *   scan                 Report tier counts + top samples (read-only).
 *   scan --new           Same, but only candidates NOT covered by a live
 *                        allowlist pair (drift since the last baseline).
 *   scan --changed       Restrict to pairs touching a staged file (the dups THIS
 *                        commit introduces). Staged set from git, or
 *                        MATCHER_CHANGED_FILES (comma/newline list, for tests).
 *   scan --gate          Exit 1 if dups found (block), 0 if clean, 2 if it could
 *                        not run (fail-open — incl. no index configured). The
 *                        pre-commit gate runs `scan --new --changed --gate`.
 *   bench                Score the rule against labels.json (precision/recall/F1).
 *   baseline             Freeze every current candidate into the allowlist and
 *                        mark DB chunks allowlisted. Idempotent.
 *   reconcile            Burn-down: drop allowlist pairs detect() no longer
 *                        produces. REMOVE-only. Dry-run by default; --apply writes.
 *
 * Knob flags (all modes): --near-code --drift-code --drift-desc --min-loc (default
 * from config.thresholds). Other flags: --include-tests, --new/--changed/--gate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolveFromCwd, resolveGuardConfig } from "../config.mjs";
import { ALLOWLIST_CLI, loadAllowlist as loadAllowlistFile, saveAllowlist, symFileKey, } from "./allowlist-io.mjs";
import { loadChangedSet } from "./changed-files.mjs";
import { classifyPair } from "./classify.mjs";
import { isExpired } from "./decay.mjs";
// Hoisted per useTopLevelRegex — this runs once per index row in the normalize loop.
const BACKSLASH_RE = /\\/g;
// Package-relative ONLY for labels.json (engine-shipped bench fixtures). Every
// CONSUMER path is resolved from cfg.cwd below, never from here.
const here = dirname(fileURLToPath(import.meta.url));
const labelsPath = resolve(here, 'labels.json');
// Resolve config against the consumer cwd (W-3). All thresholds + paths flow from here.
const cfg = resolveGuardConfig(process.cwd());
// Index path: SEARCH_CODE_DB env (fixtures/tests) wins; else config.indexPath
// resolved to the consumer cwd. null => no index configured => matcher opt-out.
const dbPath = process.env.SEARCH_CODE_DB ?? resolveFromCwd(cfg, 'indexPath');
// Allowlist: CO_OCCURRENCE_ALLOWLIST env (fixtures/tests) wins; else config.allowlistPath.
const allowlistPathRaw = process.env.CO_OCCURRENCE_ALLOWLIST ?? resolveFromCwd(cfg, 'allowlistPath');
// Approval-hint CLI shown on a gate block (a human/agent pastes it to allowlist a dup).
// Default = the engine's own guard-dup-allowlist bin, bare (no `bunx`): on a global devkit
// install it's a PATH sibling of this gate; `bunx <name>` would 404 against the registry.
// A consumer can point it at their own wrapper via GUARD_ALLOWLIST_CLI. The printed command
// double-quotes args; assumes paths/symbols are shell-safe (git-tracked paths + JS identifiers).
const CO_SCRIPT = process.env.GUARD_ALLOWLIST_CLI || ALLOWLIST_CLI;
const argv = process.argv.slice(2);
const mode = argv[0] ?? 'scan';
const flag = (name, def) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : def;
};
// Knob defaults come from the resolved config thresholds (consumer-tunable), with
// per-run --flag overrides on top.
const KNOBS = {
    nearCode: Number(flag('--near-code', cfg.thresholds.nearCode)),
    driftCode: Number(flag('--drift-code', cfg.thresholds.driftCode)),
    driftDesc: Number(flag('--drift-desc', cfg.thresholds.driftDesc)),
    minLoc: Number(flag('--min-loc', cfg.thresholds.minLoc)),
};
const INCLUDE_TESTS = argv.includes('--include-tests');
const BASELINE_DECAY = Number(flag('--decay-days', 3650));
// scan --new: report only candidates not already covered by a live allowlist pair.
const ONLY_NEW = argv.includes('--new');
// scan --gate: exit 1 = dups found (block the commit), 0 = clean (allow),
// 2 = could-not-run (no index / read error). The pre-commit hook blocks ONLY on
// 1 and fails OPEN on 2, so an infra failure (or no index) never bricks a commit.
const GATE = argv.includes('--gate');
// scan --changed: restrict to pairs touching a staged file — the dups THIS commit
// introduces, not pre-existing drift.
const CHANGED = argv.includes('--changed');
// reconcile --apply: actually write the pruned allowlist. Default is dry-run.
const APPLY = argv.includes('--apply');
// "Couldn't run" is exit 2 in every mode; the gate treats it as fail-open.
// Declared as a function (not a const arrow) so its `never` return participates in
// control-flow narrowing — a guard `if (x == null) cannotRun(...)` then treats x as
// non-null, and a try/catch whose catch calls it is definitely-assigned afterwards.
function cannotRun(msg) {
    console.error(msg);
    process.exit(2);
}
// No index configured (config.indexPath null AND no SEARCH_CODE_DB) => matcher
// opt-out: most repos have no search-code index, so this is the common path. Fail
// open gracefully — the clone-detector + ratchets still run. NEVER crash.
if (dbPath == null) {
    cannotRun('co-occurrence matcher: no search-code index configured (guard.config.json `indexPath` / GUARD_INDEX_PATH / SEARCH_CODE_DB). Matcher opted out (fail-open).');
}
if (!existsSync(dbPath)) {
    cannotRun(`No index at ${dbPath}. Run the search-code indexer first.`);
}
// allowlistPath resolves from DEFAULTS (a non-null string) so this never fires at
// runtime, but resolveFromCwd's contract is string|null — guard it (fail-open, like
// the index) so every downstream read/write sees a definite string.
if (allowlistPathRaw == null) {
    cannotRun('co-occurrence matcher: no allowlist path configured (fail-open).');
}
// Module-scope narrowing from the guard above does NOT cross into the nested mode
// functions (loadAllowlist/runBaseline/…); alias to a string-typed const so they see a
// definite path. cannotRun's `never` return makes allowlistPathRaw non-null here.
const allowlistPath = allowlistPathRaw;
// The shared loader takes (path, label); every mode below reads no-arg. This wrapper binds
// the module-scope path + this gate's label so the refusal message reads "co-occurrence
// matcher: …" exactly as before.
const loadAllowlist = () => loadAllowlistFile(allowlistPath, 'co-occurrence matcher');
const changedSet = CHANGED ? loadChangedSet(cfg.cwd) : null;
// ── Load + normalize ────────────────────────────────────────────────────────
let db;
let rows;
try {
    db = new DatabaseSync(dbPath);
    // No internal busy_timeout on the index — wait out a watcher's writer rather than
    // erroring immediately under contention (cf. WAL: reads still see a snapshot).
    db.exec('PRAGMA busy_timeout = 5000;');
    rows = db
        .prepare('SELECT file_path, symbol_name, start_line, end_line, code_hash, embedding, code_embedding FROM chunks WHERE code_embedding IS NOT NULL AND embedding IS NOT NULL AND symbol_name IS NOT NULL')
        .all();
}
catch (e) {
    cannotRun(`co-occurrence matcher: index read failed (${e instanceof Error ? e.message : String(e)}).`);
}
// Normalize separators to '/' once, at the index-read boundary, so every downstream key
// (detect/orderKey/symFileKey + the --changed `changed.has()` compare) is OS-agnostic. The
// allowlist, git diff output, and MATCHER_CHANGED_FILES are all '/'; a Windows index that
// stored '\' would otherwise never match → reconcile over-drops, the gate fails open.
for (const r of rows)
    r.file_path = r.file_path.replace(BACKSLASH_RE, '/');
const n = rows.length;
if (n === 0) {
    // Empty index = nothing to compare = clean. Gate allows (exit 0).
    console.error('No embedded chunks with a symbol_name. Nothing to match.');
    process.exit(0);
}
const dim = decode(rows[0].code_embedding).length;
const codeV = new Float32Array(n * dim);
const descV = new Float32Array(n * dim);
for (let i = 0; i < n; i++) {
    normInto(decode(rows[i].code_embedding), codeV, i * dim);
    normInto(decode(rows[i].embedding), descV, i * dim);
}
const isTest = (i) => rows[i].file_path.includes('.test.');
const loc = (i) => rows[i].end_line - rows[i].start_line + 1;
// ── Detect all candidate pairs ──────────────────────────────────────────────
// Reason: the branches ARE the dup-detection algorithm: the O(n²) cross-file pair sweep, the cheap code-gate pre-filter, and the exact/near/drifted tier classification fused inline; extracting the tier checks hides the matcher's core logic
// fallow-ignore-next-line complexity
function detect(knobs, changed = null) {
    const out = new Map(); // tuple-key -> pair
    for (let i = 0; i < n; i++) {
        const bi = i * dim;
        for (let j = i + 1; j < n; j++) {
            if (rows[i].file_path === rows[j].file_path)
                continue;
            // --changed: only pairs where at least one side is a staged file (this
            // commit's own dups). Skips the dot for everything else → cheap at commit.
            if (changed && !changed.has(rows[i].file_path) && !changed.has(rows[j].file_path))
                continue;
            const bj = j * dim;
            const code = dot(codeV, bi, codeV, bj);
            // Cheap pre-filter: nothing below the loosest code gate can qualify.
            if (code < knobs.driftCode && rows[i].code_hash !== rows[j].code_hash)
                continue;
            const desc = dot(descV, bi, descV, bj);
            const tier = classifyPair({
                hashEqual: rows[i].code_hash === rows[j].code_hash,
                code,
                desc,
                minLoc: Math.min(loc(i), loc(j)),
                bothTest: !INCLUDE_TESTS && isTest(i) && isTest(j),
            }, knobs);
            if (!tier)
                continue;
            const [x, y] = orderKey(i, j);
            const key = `${rows[x].symbol_name} ${rows[x].file_path} ${rows[y].symbol_name} ${rows[y].file_path}`;
            const prev = out.get(key);
            if (!prev || code > prev.code) {
                out.set(key, {
                    symbolA: rows[x].symbol_name,
                    fileA: rows[x].file_path,
                    rangeA: `${rows[x].start_line}-${rows[x].end_line}`,
                    symbolB: rows[y].symbol_name,
                    fileB: rows[y].file_path,
                    rangeB: `${rows[y].start_line}-${rows[y].end_line}`,
                    code: Number(code.toFixed(4)),
                    desc: Number(desc.toFixed(4)),
                    tier,
                });
            }
        }
    }
    return [...out.values()];
}
// ── Modes ───────────────────────────────────────────────────────────────────
if (mode === 'scan')
    runScan();
else if (mode === 'bench')
    runBench();
else if (mode === 'baseline')
    runBaseline();
else if (mode === 'reconcile')
    runReconcile();
else if (mode === 'backfill-ranges')
    runBackfillRanges();
else {
    console.error(`Unknown mode "${mode}". Use: scan | bench | baseline | reconcile | backfill-ranges`);
    process.exit(1);
}
// Reason: flat scan orchestration: detect → optional --new allowlist filter → per-tier count → top-6/tier sample print → gate approval-hint print → exit-code select, sequential near-zero-nesting steps; high branch COUNT, each trivial
// fallow-ignore-next-line complexity
function runScan() {
    let pairs = detect(KNOBS, changedSet);
    if (ONLY_NEW) {
        // Hide anything already covered by a LIVE allowlist pair; expired entries
        // (decay lapsed) are treated as uncovered and re-surface. Read-only — never
        // mutates the allowlist (cf. prune), so it's safe in a pre-push/commit hook.
        const known = new Set(loadAllowlist()
            .pairs.filter((p) => !isExpired(p))
            .map(symFileKey));
        pairs = pairs.filter((p) => !known.has(symFileKey(p)));
    }
    const byTier = { exact: 0, near: 0, drifted: 0 };
    for (const p of pairs)
        byTier[p.tier]++;
    console.log(`Knobs: ${JSON.stringify(KNOBS)} (tests ${INCLUDE_TESTS ? 'included' : 'excluded'})`);
    console.log(`${ONLY_NEW ? 'New candidates' : 'Candidates'}: ${pairs.length}  (exact ${byTier.exact} | near ${byTier.near} | drifted ${byTier.drifted})\n`);
    if (ONLY_NEW && pairs.length === 0) {
        console.log('No new duplication since the last baseline. ✓');
        if (GATE)
            process.exit(0);
        return;
    }
    const displayed = [];
    for (const tier of ['exact', 'near', 'drifted']) {
        const sample = pairs
            .filter((p) => p.tier === tier)
            .sort((a, b) => b.code - a.code)
            .slice(0, 6);
        if (sample.length === 0)
            continue;
        console.log(`── ${tier} ──`);
        for (const p of sample) {
            console.log(`  c=${p.code} d=${p.desc}  ${p.symbolA} <> ${p.symbolB}`);
            console.log(`        ${p.fileA}  /  ${p.fileB}`);
            displayed.push(p);
        }
        console.log('');
    }
    if (GATE && pairs.length > 0) {
        // Print a ready-to-paste approval for each DISPLAYED pair (mirrors the top-6/tier cap
        // above), pre-filled with similarity + ranges — so an approved entry keeps its
        // findability metadata instead of the empty fields you get hand-building the command.
        console.log('To approve an intentional dup (fill in the reason):');
        for (const p of displayed) {
            console.log(`  ${CO_SCRIPT} add "${p.symbolA}" "${p.fileA}" "${p.symbolB}" "${p.fileB}" --similarity ${p.code} --range-a ${p.rangeA} --range-b ${p.rangeB} --description "<why>"`);
        }
        if (pairs.length > displayed.length) {
            console.log(`  (+${pairs.length - displayed.length} more — re-run after addressing these)`);
        }
        console.log('');
    }
    if (GATE)
        process.exit(pairs.length > 0 ? 1 : 0);
}
// Reason: the branches ARE the confusion-matrix algorithm: the TP/FP/FN/TN four-way classification plus precision/recall/F1 derivation over labels.json; CRAP-flagged because this is dev-only bench tooling exercised end-to-end against fixtures, not unit-tested
// fallow-ignore-next-line complexity
function runBench() {
    const { pairs: labels } = JSON.parse(readFileSync(labelsPath, 'utf8'));
    const pairs = detect(KNOBS);
    const flagged = new Set(pairs.map((p) => symKey(p.symbolA, p.symbolB)));
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    const misses = [];
    const falseAlarms = [];
    for (const l of labels) {
        const predicted = flagged.has(symKey(l.a, l.b));
        const actual = l.label === 'dup';
        if (predicted && actual)
            tp++;
        else if (predicted && !actual) {
            fp++;
            falseAlarms.push(`${l.a} <> ${l.b}  (${l.note})`);
        }
        else if (!predicted && actual) {
            fn++;
            misses.push(`${l.a} <> ${l.b}  (${l.note})`);
        }
        else
            tn++;
    }
    const prec = tp + fp ? tp / (tp + fp) : 1;
    const rec = tp + fn ? tp / (tp + fn) : 1;
    const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
    console.log(`Knobs: ${JSON.stringify(KNOBS)}`);
    console.log(`Labeled pairs: ${labels.length}  (dup ${labels.filter((l) => l.label === 'dup').length} | noise ${labels.filter((l) => l.label === 'noise').length})`);
    console.log(`Confusion: TP ${tp}  FP ${fp}  FN ${fn}  TN ${tn}`);
    console.log(`Precision ${(prec * 100).toFixed(1)}%  Recall ${(rec * 100).toFixed(1)}%  F1 ${(f1 * 100).toFixed(1)}%`);
    if (misses.length)
        console.log(`\nMissed dups (FN):\n  ${misses.join('\n  ')}`);
    if (falseAlarms.length)
        console.log(`\nFalse alarms (FP):\n  ${falseAlarms.join('\n  ')}`);
}
// Reason: flat baseline orchestration: detect → idempotent drop-prior-baseline/keep-human → append-new pairs → atomic allowlist write → DB allowlisted-flag reset+re-mark → tier-count report, sequential steps; high branch COUNT, each trivial, CRAP-flagged as a dev-only freeze command run end-to-end not unit-tested
// fallow-ignore-next-line complexity
function runBaseline() {
    const pairs = detect(KNOBS);
    const date = new Date().toISOString().slice(0, 10);
    // Idempotent: drop prior baseline entries, keep human-added ones.
    const existing = loadAllowlist();
    const kept = existing.pairs.filter((p) => !String(p.description ?? '').startsWith('baseline '));
    const keptKeys = new Set(kept.map((p) => symFileKey(p)));
    let added = 0;
    for (const p of pairs) {
        if (keptKeys.has(symFileKey(p)))
            continue;
        kept.push({
            symbolA: p.symbolA,
            fileA: p.fileA,
            rangeA: p.rangeA,
            symbolB: p.symbolB,
            fileB: p.fileB,
            rangeB: p.rangeB,
            similarity: p.code,
            description: `baseline ${date} — ${p.tier} duplicate, frozen by co-occurrence matcher`,
            date,
            decayDays: BASELINE_DECAY,
        });
        added++;
    }
    // Preserve the clones[] array (token-clone entries) — must not be wiped by a pair re-baseline.
    saveAllowlist(allowlistPath, { pairs: kept, clones: existing.clones });
    // Reset + re-mark DB allowlisted flags from the frozen set only.
    db.prepare('UPDATE chunks SET allowlisted = 0 WHERE allowlisted = 1').run();
    const mark = db.prepare('UPDATE chunks SET allowlisted = 1 WHERE symbol_name = ?');
    const symbols = new Set();
    for (const p of kept) {
        symbols.add(p.symbolA);
        symbols.add(p.symbolB);
    }
    let marked = 0;
    // .changes is number|bigint by the sqlite typings; these row counts are small, so
    // Number() keeps the numeric accumulator (bigint mode is not enabled on this stmt).
    for (const s of symbols)
        marked += Number(mark.run(s).changes);
    const byTier = { exact: 0, near: 0, drifted: 0 };
    for (const p of pairs)
        byTier[p.tier]++;
    console.log(`Detected ${pairs.length} candidates (exact ${byTier.exact} | near ${byTier.near} | drifted ${byTier.drifted}).`);
    console.log(`Allowlist: +${added} baseline pair(s) (${kept.length} total, ${kept.length - added} non-baseline kept) → ${allowlistPath}`);
    console.log(`DB: re-marked ${marked} chunk row(s) allowlisted across ${symbols.size} symbols.`);
    db.close();
}
// Burn-down primitive: drop allowlist pairs detect() no longer produces (resolved /
// renamed / deleted). Inverse of baseline — REMOVE-only, no date reset, and keyed on
// detection-miss not description (so it drops dead human-added entries too, unlike
// baseline). Dropping a dead entry has zero gate effect: the gate only blocks on pairs
// detect() emits, and a dropped one isn't emitted. Dry-run by default; --apply writes.
// Run the indexer first so a stale index doesn't over-drop a still-live pair.
// Reason: flat reconcile orchestration: detect → keep/drop partition by detection-miss → drop report → dry-run-vs-apply gate → nothing-dead short-circuit → atomic write, sequential steps; high branch COUNT, each trivial, CRAP-flagged as a dev-only burn-down command run end-to-end not unit-tested
// fallow-ignore-next-line complexity
function runReconcile() {
    // loadAllowlist() refuses (exit 2) on a corrupt-but-present file, so reconcile can't wipe it.
    const detected = new Set(detect(KNOBS).map(symFileKey));
    const { pairs, clones } = loadAllowlist();
    const kept = pairs.filter((p) => detected.has(symFileKey(p)));
    const dropped = pairs.filter((p) => !detected.has(symFileKey(p)));
    console.log(`Reconcile: ${pairs.length} pair(s) → keep ${kept.length}, drop ${dropped.length} (no longer a current candidate).`);
    for (const p of dropped)
        console.log(`  drop  ${p.symbolA} <> ${p.symbolB}   (${p.fileA} / ${p.fileB})`);
    if (!APPLY) {
        console.log('\nDry run — no write. Re-run with --apply to prune.');
        db.close();
        return;
    }
    if (dropped.length === 0) {
        // Nothing dead → don't rewrite (avoids churning mtime / a no-op diff). JSON-only by
        // design: reconcile never touches the DB `allowlisted` flag baseline sets (the gate
        // reads the JSON allowlist, not the flag).
        console.log('Nothing to reconcile — allowlist unchanged.');
        db.close();
        return;
    }
    saveAllowlist(allowlistPath, { pairs: kept, clones });
    console.log(`Wrote ${kept.length} pair(s) → ${allowlistPath}`);
    db.close();
}
// ── helpers ──────────────────────────────────────────────────────────────────
function decode(blob) {
    return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}
function normInto(v, target, base) {
    let s = 0;
    for (let k = 0; k < v.length; k++)
        s += v[k] * v[k];
    s = Math.sqrt(s) || 1;
    for (let k = 0; k < v.length; k++)
        target[base + k] = v[k] / s;
}
function dot(a, ba, b, bb) {
    let s = 0;
    for (let k = 0; k < dim; k++)
        s += a[ba + k] * b[bb + k];
    return s;
}
function orderKey(i, j) {
    const ai = `${rows[i].symbol_name} ${rows[i].file_path}`;
    const aj = `${rows[j].symbol_name} ${rows[j].file_path}`;
    return ai < aj ? [i, j] : [j, i];
}
function symKey(a, b) {
    return a < b ? `${a} ${b}` : `${b} ${a}`;
}
// Retrofit rangeA/rangeB onto existing symbol pairs by looking up each symbol's
// chunk line range in the index. Rough (one chunk per symbol); findability metadata.
// Reason: thin one-off maintenance script: build a symbol→range lookup, then per-allowlist-pair fill rangeA/rangeB and tally filled/missed; CRAP-flagged as a dev-only retrofit run end-to-end not unit-tested
// fallow-ignore-next-line complexity
function runBackfillRanges() {
    const rangeOf = new Map();
    for (const r of rows)
        rangeOf.set(`${r.symbol_name} ${r.file_path}`, `${r.start_line}-${r.end_line}`);
    const allowlist = loadAllowlist();
    let filled = 0;
    let missed = 0;
    for (const p of allowlist.pairs) {
        const ra = rangeOf.get(`${p.symbolA} ${p.fileA}`);
        const rb = rangeOf.get(`${p.symbolB} ${p.fileB}`);
        if (ra)
            p.rangeA = ra;
        if (rb)
            p.rangeB = rb;
        if (ra && rb)
            filled++;
        else
            missed++;
    }
    saveAllowlist(allowlistPath, { pairs: allowlist.pairs, clones: allowlist.clones });
    console.log(`Backfilled ranges on ${filled}/${allowlist.pairs.length} pairs (${missed} unresolved — symbol moved/renamed).`);
    db.close();
}
