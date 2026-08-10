#!/usr/bin/env node
// Folder fan-out ratchet: no directory may hold more than `fanoutCap` non-test
// implementation files — at ANY depth (the recursive complement to a lib/ domain
// registry, which only governs level 1). A folder that hits the cap must be split
// into cohesive kebab subfolders; flat piles can grow no further, and new folders
// must be born organized.
//
// Threshold precedent (research, 2026-06): Angular's LIFT guide splits at 7 files;
// steiger (the FSD linter — the only count-based structure linter found) uses 15/20.
// No off-the-shelf tool enforces this recursively with a brownfield baseline, hence
// this script. The default cap (12) sits mid-range; tune via guard.config.json.
//
//   bunx guard-fanout freeze   # re-count + write the consumer's baseline
//   bunx guard-fanout gate     # fail on growth (pre-commit)
//
// PARAMETERIZED (W-3): scanRoots / fanoutCap / fanoutExempt come from
// resolveGuardConfig(cwd) — the CONSUMER's guard.config.json + GUARD_* env, never
// hardcoded. The baseline (eslint/baselines/fanout.json) is per-repo STATE: it is
// read/written under the CONSUMER cwd, never the package dir.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILENAME, resolveGuardConfig, sourceMatchers } from "../config.mjs";
import { hasStagedFiles, indexFiles, stageBaseline, treeFilesAtRef } from "./git-index.mjs";
// Per-repo STATE, resolved against the consumer cwd (never __dirname).
const BASELINE = 'eslint/baselines/fanout.json';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '__snapshots__', '__tests__', '_shared']);
// The ONE fan-out tally. Every producer of candidate paths — the filesystem walk below, and the two
// git tree readers the gate uses — funnels through here, so "what counts as an impl file" is decided
// in exactly one place. Two counters that could disagree on that question would re-introduce the very
// misattribution this gate exists to avoid, from the other side: a folder judged over-cap by one
// counter and under-cap by the other blocks or passes on which reader happened to run.
//
// `paths` are CWD-relative file paths. Filters, in order: inside a scanRoot; no SKIP_DIRS segment
// BELOW that root (an explicitly configured `dist` root still counts); an impl file (barrels don't
// add to a pile's cognitive load, tests aren't impl); parent dir not exempt.
function tallyDirs(paths, rootsToScan, exemptSet, match) {
    const counts = {};
    for (const file of paths) {
        const segments = file.split('/');
        const name = segments.pop();
        if (!name || !match.isSource(name) || match.isTest(name) || match.isBarrel(name))
            continue;
        const dir = segments.join('/');
        const isScanned = rootsToScan.some((scanRoot) => {
            if (dir === scanRoot)
                return true;
            if (!dir.startsWith(`${scanRoot}/`))
                return false;
            const belowScanRoot = dir.slice(scanRoot.length + 1).split('/');
            return !belowScanRoot.some((segment) => SKIP_DIRS.has(segment));
        });
        if (!isScanned)
            continue;
        if (exemptSet.has(dir))
            continue;
        counts[dir] = (counts[dir] ?? 0) + 1;
    }
    return counts;
}
// Returns { '<dir>': <impl-file count> } for every scanned directory under `root`,
// honouring the consumer's scanRoots + fanoutExempt. `scanRoots`/`exempt` are passed
// explicitly so callers (tests, gate) share one code path; both default off cfg(root). Impl-file
// extensions come from cfg.sourceExtensions (TS by default; a JS/MJS repo sets ["mjs","js"]).
export function countFanout(root = process.cwd(), scanRoots, exempt) {
    const cfg = resolveGuardConfig(root);
    const rootsToScan = scanRoots ?? cfg.scanRoots;
    const exemptSet = new Set(exempt ?? cfg.fanoutExempt);
    const match = sourceMatchers(cfg.sourceExtensions);
    const files = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = readdirSync(join(root, dir), { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name))
                    walk(`${dir}/${e.name}`);
            }
            else {
                files.push(`${dir}/${e.name}`);
            }
        }
    };
    for (const r of rootsToScan)
        walk(r);
    return tallyDirs(files, rootsToScan, exemptSet, match);
}
// The same tally over a git-reported file list (index or a ref's tree) instead of the filesystem.
// `git ls-files` / `git ls-tree` already emit CWD-relative paths, so both land in countFanout's key
// space with no re-addressing. Returns null when git could not answer, so the caller can fall back.
function countFanoutFrom(root, paths) {
    if (paths === null)
        return null;
    const cfg = resolveGuardConfig(root);
    return tallyDirs(paths, cfg.scanRoots, new Set(cfg.fanoutExempt), sourceMatchers(cfg.sourceExtensions));
}
export function overCap(counts, cap) {
    return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > cap));
}
function runCli(cmd) {
    const root = process.cwd();
    const cfg = resolveGuardConfig(root);
    const cap = cfg.fanoutCap;
    const baselineFile = join(root, BASELINE);
    const offenders = overCap(countFanout(root), cap);
    if (cmd === 'freeze') {
        if (Object.keys(offenders).length > 0) {
            // Read the OUTGOING baseline before clobbering it, so the refresh can name what it is newly
            // grandfathering. Deliberately NOT shrink-only (unlike size-disable's freezeLines min()):
            // recording legitimate drift is the operation a stale baseline actually needs. Loud, not
            // forbidden — a blind `freeze` must not quietly absorb a folder that just went over-cap.
            const prior = existsSync(baselineFile)
                ? (JSON.parse(readFileSync(baselineFile, 'utf8')).dirs ?? {})
                : {};
            const out = { cap, dirs: offenders };
            mkdirSync(dirname(baselineFile), { recursive: true });
            writeFileSync(baselineFile, `${JSON.stringify(out, null, 2)}\n`);
            console.log(`✓ ${BASELINE}: cap ${cap}, ${Object.keys(offenders).length} over-cap folder(s) grandfathered`);
            const rose = Object.entries(offenders).filter(([dir, n]) => n > (prior[dir] ?? cap));
            if (rose.length > 0) {
                console.log(`  ⚠ ${rose.length} folder(s) grew since the last freeze:`);
                for (const [dir, n] of rose)
                    console.log(`     ${dir}: ${prior[dir] ?? cap} → ${n}`);
            }
        }
        else {
            // No folder over cap → no debt to grandfather. Don't write an empty baseline; delete a stale one.
            // The cap is enforced from guard.config.json, so an absent baseline still gates new fan-out.
            rmSync(baselineFile, { force: true });
            console.log(`✓ ${BASELINE}: no folder over cap ${cap} — no baseline written`);
        }
        process.exit(0);
    }
    // Reason: the two ratchets (folder-fanout / size-disable) are parallel-by-design independent guard bins (+ tests); each self-contained with the same freeze/gate CLI shell
    // fallow-ignore-next-line code-duplication
    if (cmd === 'gate') {
        const hasBaseline = existsSync(baselineFile);
        // Missing baseline = no grandfathered over-cap folders. Enforce the config cap whenever the repo
        // is governed (guard.config.json present — devkit's own repo, CI, any adopted consumer); only an
        // UNgoverned + un-frozen repo fails open, so an unadopted repo is never wedged. Never key this on
        // .devkit/config.json — absent in devkit's sync-dogfooded repo and in CI (would disable the gate).
        if (!hasBaseline && !existsSync(join(root, CONFIG_FILENAME))) {
            process.exit(2); // ungoverned + un-frozen → fail open
        }
        const frozen = hasBaseline
            ? JSON.parse(readFileSync(baselineFile, 'utf8'))
            : { cap, dirs: {} };
        const allowed = (dir) => Math.max(frozen.cap, frozen.dirs[dir] ?? 0);
        // A ratchet must fail the CHANGE that broke it, not whoever commits next. During a commit judge
        // tracked state and require growth: the pending index against HEAD. Reading the index rather
        // than the filesystem drops untracked noise; reading it directly rather than through stagedSet
        // keeps aggregate directory counts honest during merges.
        const indexCounts = countFanoutFrom(root, indexFiles(root));
        const inCommit = indexCounts !== null && hasStagedFiles(root);
        // With a clean index (CI or a manual audit) there is no change to attribute, so the whole tree is
        // the subject and drift still blocks. An unborn HEAD has no prior state, which correctly makes
        // every over-cap folder part of the initial commit.
        const headCounts = inCommit ? (countFanoutFrom(root, treeFilesAtRef(root, 'HEAD')) ?? {}) : {};
        const over = inCommit ? overCap(indexCounts, cap) : offenders;
        const grew = Object.entries(over).filter(([dir, n]) => n > allowed(dir) && (!inCommit || n > (headCounts[dir] ?? 0)));
        if (grew.length > 0) {
            console.error(`🚫 Folder fan-out exceeded (cap ${frozen.cap} impl files/folder, any depth):`);
            for (const [dir, n] of grew)
                console.error(`   ${dir}: ${n} files (allowed ${allowed(dir)})`);
            console.error('   Split into cohesive kebab subfolders (group by concern — graphify/co-occurrence can suggest clusters).');
            process.exit(1);
        }
        // Drift was already over its allowance at HEAD and was not grown here. Report it separately so
        // the remedy is an honest baseline refresh, not an unrelated directory split in this change.
        const drifted = Object.entries(over).filter(([dir, n]) => n > allowed(dir));
        if (drifted.length > 0) {
            console.log(`ℹ ${drifted.length} folder(s) drifted above their baseline (not this change):`);
            for (const [dir, n] of drifted)
                console.log(`   ${dir}: ${n} files (baseline ${allowed(dir)})`);
            console.log(`   Refresh with \`guard-fanout freeze\` — this commit is not blocked by ${drifted.length > 1 ? 'them' : 'it'}.`);
        }
        // Every grandfathered folder healed (baseline had over-cap dirs, none remain) → self-delete the
        // stale baseline in a real commit so it doesn't linger.
        if (hasBaseline &&
            Object.keys(frozen.dirs).length > 0 &&
            Object.keys(over).length === 0 &&
            hasStagedFiles(root)) {
            rmSync(baselineFile, { force: true });
            stageBaseline(root, BASELINE);
            console.log(`✓ fan-out debt cleared — ${BASELINE} removed & staged.`);
            process.exit(0);
        }
        const shrank = Object.entries(frozen.dirs).filter(([dir, n]) => (over[dir] ?? 0) < n);
        if (shrank.length > 0) {
            console.log(`✓ fan-out debt shrank in ${shrank.length} folder(s) — run \`guard-fanout freeze\` to lock it in.`);
        }
        process.exit(0);
    }
    console.error('usage: guard-fanout <freeze|gate>');
    process.exit(2);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    runCli(process.argv[2]);
}
