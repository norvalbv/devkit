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
// hardcoded. The baseline (.devkit/baselines/fanout.json) is per-repo STATE: it is
// read/written under the CONSUMER cwd, never the package dir.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILENAME, resolveGuardConfig, resolveTreeExtensions, sourceMatchers, } from '../config.mjs';
import { exitGate } from '../deterministic/reason.mjs';
import { childGrammarNode } from '../structure/walk.mjs';
import { FANOUT_BASELINE, readRatchetBaseline, removeRatchetBaseline, writeRatchetBaseline, } from './baseline-paths.mjs';
import { hasStagedFiles, indexFiles, treeFilesAtRef } from './git-index.mjs';
// Per-repo STATE, resolved against the consumer cwd (never __dirname).
const BASELINE = FANOUT_BASELINE;
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
export function judgeFanout(root, cap = resolveGuardConfig(root).fanoutCap) {
    // Finish every filesystem/index observation before snapshotting the baseline used to judge it.
    const indexCounts = countFanoutFrom(root, indexFiles(root));
    const inCommit = indexCounts !== null && hasStagedFiles(root);
    const counts = indexCounts !== null && inCommit ? indexCounts : countFanout(root);
    const headCounts = inCommit ? (countFanoutFrom(root, treeFilesAtRef(root, 'HEAD')) ?? {}) : {};
    const baseline = readRatchetBaseline(root, BASELINE);
    const hasBaseline = baseline !== null;
    // Only an ungoverned (no guard.config.json) + un-frozen repo fails open. Never key this on
    // .devkit/config.json: it is absent in devkit's own repo and in CI, which would disable the gate.
    const failOpen = !hasBaseline && !existsSync(join(root, CONFIG_FILENAME));
    // SAFETY: reads the Devkit-owned fan-out baseline shape produced by freeze/migration.
    const frozen = baseline
        ? JSON.parse(baseline.contents)
        : { cap, dirs: {} };
    // The gate blocks only above BOTH the config cap and the frozen allowance, so the limit is their max.
    const allowed = (dir) => Math.max(cap, frozen.cap, frozen.dirs?.[dir] ?? 0);
    return { failOpen, hasBaseline, frozen, inCommit, counts, headCounts, allowed };
}
// A folder whose child folders must be registered in a libDomains list before they may exist,
// resolved through the same named/domain/recurse dispatch the structure walker applies.
function isDomainGated(cfg, dir) {
    // SAFETY: cfg.structure.trees is object[] generically; at this config-read boundary each entry is a
    // tree spec, and every field read below is optional-chained or truth-tested before use.
    return cfg.structure.trees.some((tree) => {
        if (!tree.root || !tree.grammar)
            return false;
        if (dir !== tree.root && !dir.startsWith(`${tree.root}/`))
            return false;
        const rules = tree.grammar.rules ?? {};
        const exts = resolveTreeExtensions(cfg, tree);
        const below = dir === tree.root ? [] : dir.slice(tree.root.length + 1).split('/');
        // walkTree never applies grammar under ignored, frozen or __tests__ folders: nothing to register.
        const unjudged = new Set([
            ...(tree.ignoredDirs ?? []),
            ...(tree.frozenDirs ?? []),
            '__tests__',
        ]);
        if (below.some((name) => unjudged.has(name)))
            return false;
        let node = tree.grammar;
        for (const name of below) {
            node = node ? childGrammarNode(node, name, rules, exts)?.node : undefined;
        }
        return Boolean(node?.domainGate);
    });
}
// guard-size's split remedy trips guard-fanout when the folder has no headroom, so say so up front.
// Advisory only: a failure to judge fan-out yields no hint rather than breaking the size gate.
export function fanoutSplitHints(root, files) {
    try {
        const cfg = resolveGuardConfig(root);
        const match = sourceMatchers(cfg.sourceExtensions);
        const dirs = new Set();
        for (const file of files) {
            const segments = file.split('/');
            const name = segments.pop() ?? '';
            // Tests and barrels never count toward fan-out, so splitting one can never trip it.
            if (!match.isSource(name) || match.isTest(name) || match.isBarrel(name))
                continue;
            dirs.add(segments.join('/'));
        }
        if (dirs.size === 0)
            return [];
        const judged = judgeFanout(root, cfg.fanoutCap);
        if (judged.failOpen)
            return [];
        const hints = [];
        for (const dir of [...dirs].sort()) {
            const count = judged.counts[dir];
            if (count === undefined)
                continue; // exempt or outside scanRoots: fan-out does not judge it
            const allowed = judged.allowed(dir);
            const headroom = allowed - count;
            if (headroom > 0) {
                hints.push(`   ↳ ${dir}: ${count}/${allowed} impl files — room for ${headroom} more sibling file(s) before guard-fanout blocks`);
                continue;
            }
            const register = isDomainGated(cfg, dir)
                ? ' and register it in the tree’s structure libDomains'
                : '';
            hints.push(`   ↳ ${dir} is at ${count}/${allowed} impl files: a sibling split will trip guard-fanout — split into a subfolder instead${register}`);
        }
        return hints;
    }
    catch {
        return [];
    }
}
function runCli(cmd) {
    const root = process.cwd();
    const cfg = resolveGuardConfig(root);
    const cap = cfg.fanoutCap;
    if (cmd === 'freeze') {
        const offenders = overCap(countFanout(root), cap);
        const baseline = readRatchetBaseline(root, BASELINE);
        if (Object.keys(offenders).length > 0) {
            // Read the OUTGOING baseline before clobbering it, so the refresh can name what it is newly
            // grandfathering. Deliberately NOT shrink-only, matching an explicit guard-size refresh:
            // recording legitimate drift is the operation a stale baseline actually needs. Loud, not
            // forbidden — a blind `freeze` must not quietly absorb a folder that just went over-cap.
            // SAFETY: freeze reads the Devkit-owned fan-out baseline shape it writes below.
            const prior = baseline
                ? (JSON.parse(baseline.contents).dirs ?? {})
                : {};
            const out = { cap, dirs: offenders };
            writeRatchetBaseline(root, FANOUT_BASELINE, `${JSON.stringify(out, null, 2)}\n`);
            console.log(`✓ ${FANOUT_BASELINE}: cap ${cap}, ${Object.keys(offenders).length} over-cap folder(s) grandfathered`);
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
            removeRatchetBaseline(root, FANOUT_BASELINE);
            console.log(`✓ ${FANOUT_BASELINE}: no folder over cap ${cap} — no baseline written`);
        }
        process.exit(0);
    }
    // Reason: the two ratchets (folder-fanout / size-disable) are parallel-by-design independent guard bins (+ tests); each self-contained with the same freeze/gate CLI shell
    // fallow-ignore-next-line code-duplication
    if (cmd === 'gate') {
        const { failOpen, hasBaseline, frozen, inCommit, counts, headCounts, allowed } = judgeFanout(root, cap);
        if (failOpen)
            exitGate(2, ['guard-fanout: ungoverned repo and no fan-out baseline — opted out']);
        const over = overCap(counts, cap);
        // A ratchet must fail the CHANGE that broke it, not whoever commits next. During a commit judge
        // tracked state and require growth: the pending index against HEAD. Reading the index rather
        // than the filesystem drops untracked noise; reading it directly rather than through stagedSet
        // keeps aggregate directory counts honest during merges.
        // With a clean index (CI or a manual audit) there is no change to attribute, so the whole tree is
        // the subject and drift still blocks. An unborn HEAD has no prior state, which correctly makes
        // every over-cap folder part of the initial commit.
        const grew = Object.entries(over).filter(([dir, n]) => n > allowed(dir) && (!inCommit || n > (headCounts[dir] ?? 0)));
        if (grew.length > 0) {
            const why = [
                `🚫 Folder fan-out exceeded (cap ${frozen.cap} impl files/folder, any depth):`,
                ...grew.map(([dir, n]) => `   ${dir}: ${n} files (allowed ${allowed(dir)})`),
            ];
            for (const line of why)
                console.error(line);
            console.error('   Split into cohesive kebab subfolders (group by concern — graphify/co-occurrence can suggest clusters).');
            exitGate(1, why);
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
            removeRatchetBaseline(root, FANOUT_BASELINE, { stage: true });
            console.log(`✓ fan-out debt cleared — ${FANOUT_BASELINE} removed & staged.`);
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
// existsSync first: realpathSync throws on a missing argv[1], which would make a plain import throw.
if (process.argv[1] &&
    existsSync(process.argv[1]) &&
    import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    runCli(process.argv[2]);
}
