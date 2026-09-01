#!/usr/bin/env node
// Ratchet inline max-lines disables and raw-line debt: existing giants are grandfathered, but their
// ceilings can only shrink (split a file or delete its disable).
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync, } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILENAME, resolveGuardConfig, sourceMatchers } from '../config.mjs';
import { readRatchetBaseline, removeRatchetBaseline, SIZE_BASELINE, writeRatchetBaseline, } from './baseline-paths.mjs';
import { hasStagedFiles, indexTreeRef, mergeBaseRef, pullRequestScope, stagedSet, } from './git-index.mjs';
import { freezeLinesBaseline } from './size-lines-freeze.mjs';
import { lineBaselineForGate, lineCountsAtRef, lineViolationReport, measureLines, tightenLineBaseline, } from './size-line-authority.mjs';
import { LINES_BASELINE, SIZE_SKIP_DIRS } from './size-policy.mjs';
import { runPreflightCli } from './size-preflight.mjs';
const BASELINE = SIZE_BASELINE;
// Only an actual directive comment counts — a line that merely MENTIONS the phrase
// (string literal, prose comment) must not inflate the ratchet and falsely block.
const DIRECTIVE_START = /^\s*(?:\/\/|\/\*)\s*eslint-disable/;
// Disable-directive counters, hoisted (devkit lint: useTopLevelRegex) — matched per source line.
const RE_MAX_LINES_PER_FN = /max-lines-per-function/g;
const RE_MAX_LINES = /max-lines\b/g;
function walk(root, dir, files, match, includeTests = false) {
    let entries;
    try {
        entries = readdirSync(join(root, dir), { withFileTypes: true });
    }
    catch {
        return files;
    }
    for (const e of entries) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) {
            if (!SIZE_SKIP_DIRS.has(e.name))
                walk(root, rel, files, match, includeTests);
        }
        else if (match.isSource(e.name) && (includeTests || !match.isTest(e.name))) {
            files.push(rel);
        }
    }
    return files;
}
// Count disable directives, distinguishing the file-level `max-lines` rule from
// `max-lines-per-function` (the former is a substring of the latter). `scanRoots`
// is passed explicitly so callers share one path; defaults off cfg(root).
export function countDisables(root = process.cwd(), scanRoots) {
    const cfg = resolveGuardConfig(root);
    const rootsToScan = scanRoots ?? cfg.scanRoots;
    const match = sourceMatchers(cfg.sourceExtensions);
    const files = rootsToScan.flatMap((r) => walk(root, r, [], match));
    // Per file → its disable counts; a file with none is omitted (the baseline never lists zeros).
    const perFile = {};
    for (const f of files) {
        const text = readFileSync(join(root, f), 'utf8');
        let file = 0;
        let fn = 0;
        for (const line of text.split('\n')) {
            if (!DIRECTIVE_START.test(line))
                continue;
            fn += (line.match(RE_MAX_LINES_PER_FN) || []).length;
            file += (line.replace(RE_MAX_LINES_PER_FN, '').match(RE_MAX_LINES) || []).length;
        }
        if (file || fn)
            perFile[f] = { file, fn };
    }
    const fileDisables = Object.values(perFile).reduce((s, c) => s + c.file, 0);
    const fnDisables = Object.values(perFile).reduce((s, c) => s + c.fn, 0);
    return { fileDisables, fnDisables, perFile, scannedFiles: files.length };
}
export function countOversized(root = process.cwd(), scanRoots, maxLines, match, maxTestLines) {
    const cfg = resolveGuardConfig(root);
    const sourceCap = maxLines ?? cfg.maxLines;
    const testCap = maxTestLines ?? cfg.maxTestLines;
    if (!sourceCap && !testCap)
        return [];
    const m = match ?? sourceMatchers(cfg.sourceExtensions);
    const files = (scanRoots ?? cfg.scanRoots).flatMap((r) => walk(root, r, [], m, testCap > 0));
    const over = [];
    for (const f of files) {
        const cap = m.isTest(f) ? testCap : sourceCap;
        const measured = measureLines(readFileSync(join(root, f), 'utf8'));
        if (cap > 0 && measured.lines > cap)
            over.push({ file: f, lines: measured.lines });
    }
    return over.sort((a, b) => a.file.localeCompare(b.file));
}
// Grandfather the current over-cap source files into the raw-line baseline (size-lines.json).
// Automatic onboarding stays shrink-only; the explicit CLI refresh may raise a ceiling, but names
// every increase so legitimate main-branch drift can be reconciled without a silent laundering path.
// Writes ONLY the line baseline and never touches the disable-count baseline (size.json). Returns
// the number of files over the cap; deletes a stale baseline when none remain.
export function freezeLines(root = process.cwd(), mode = 'shrink-only') {
    const cfg = resolveGuardConfig(root);
    if (!cfg.maxLines && !cfg.maxTestLines)
        return 0;
    return freezeLinesBaseline(root, cfg, countOversized(root), mode);
}
// ── line-growth onboarding + upgrade back-fill ─────────────────────────────────────────────────
// The default raw-line cap written when the block is enabled. Fixed — a consumer tunes it by
// hand-editing guard.config.json (setMaxLines preserves an existing positive value).
export const LINE_CAP = 500;
export const TEST_LINE_CAP = 2000;
// The //-comment sibling written next to `maxLines` (guard.config.json keeps guidance in "//" keys).
const MAXLINES_DOC = 'Raw line cap per source file (guard-size ratchet enforces it; existing giants grandfathered shrink-only). 0 = off. Per-FUNCTION caps need a parser — not yet.';
const MAXTESTLINES_DOC = 'Loose raw line cap per test file; existing oversized tests are grandfathered shrink-only. 0 = off.';
/** Does guard.config.json explicitly configure both line caps, including 0 = off? */
export function hasLineCap(cwd) {
    const cfgPath = join(cwd, 'guard.config.json');
    if (!existsSync(cfgPath))
        return false;
    try {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
        return (typeof cfg.maxLines === 'number' &&
            Number.isFinite(cfg.maxLines) &&
            cfg.maxLines >= 0 &&
            typeof cfg.maxTestLines === 'number' &&
            Number.isFinite(cfg.maxTestLines) &&
            cfg.maxTestLines >= 0);
    }
    catch {
        return false;
    }
}
/**
 * Add missing source/test caps to guard.config.json without overwriting tuned positive values.
 * Returns true when it writes either cap.
 */
export function setMaxLines(cwd, cap = LINE_CAP, testCap = TEST_LINE_CAP) {
    const cfgPath = join(cwd, 'guard.config.json');
    if (!existsSync(cfgPath))
        return false;
    let cfg;
    try {
        cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    }
    catch {
        // Unparseable guard.config.json → skip (mirror hasLineCap). A corrupt user-edited file must not
        // crash init/upgrade; the gates surface the JSON error separately when they run.
        return false;
    }
    const hasSource = typeof cfg.maxLines === 'number' && Number.isFinite(cfg.maxLines) && cfg.maxLines >= 0;
    const hasTest = typeof cfg.maxTestLines === 'number' &&
        Number.isFinite(cfg.maxTestLines) &&
        cfg.maxTestLines >= 0;
    if (hasSource && hasTest)
        return false;
    if (!hasSource)
        Object.assign(cfg, { '//maxLines': MAXLINES_DOC, maxLines: cap });
    if (!hasTest)
        Object.assign(cfg, { '//maxTestLines': MAXTESTLINES_DOC, maxTestLines: testCap });
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
    return true;
}
/**
 * Enable the block on an already-adopted repo (the upgrade back-fill): set the cap, then grandfather
 * the current over-cap files via a lines-only freeze that NEVER touches the disable-count baseline
 * (size.json) — so no unrelated size debt is laundered in. Returns whether the cap is now in effect
 * and how many files were grandfathered. Skips gracefully (enabled:false) when guard.config.json is
 * absent or unparseable — freezeLines would otherwise re-resolve that same corrupt file and throw.
 */
export function enableLineGrowth(cwd) {
    // setMaxLines is false when it wrote nothing: cap already present (fine — grandfather it) OR the
    // file is unreadable (bail — don't freeze against a config we can't parse).
    if (!setMaxLines(cwd) && !hasLineCap(cwd))
        return { enabled: false, grandfathered: 0 };
    return { enabled: true, grandfathered: freezeLines(cwd) };
}
/** How many files WOULD be grandfathered at the default caps — for `--dry-run`; writes nothing. */
export function previewGrandfather(cwd) {
    return countOversized(cwd, undefined, LINE_CAP, undefined, TEST_LINE_CAP).length;
}
// The maxLines gate as a per-file, per-commit shrink-only ratchet. When files are staged (a
// commit in progress) it evaluates ONLY those files, so a parallel agent's unstaged edits can
// neither block this commit nor tighten their files' ceilings. With nothing staged (CI, or a
// manual `guard-size gate`) it enforces the whole committed tree and never mutates — there is
// no commit to carry a baseline change. Exits 1 on a file over its ceiling.
// Reason: sequential grow-check then per-file auto-lower, each a trivial guard at low nesting; splitting scatters one gate decision
// fallow-ignore-next-line complexity
function runLinesGate(root, cfg, ciScope) {
    const over = countOversized(root);
    const staged = stagedSet(root);
    const inCommit = staged !== null && hasStagedFiles(root);
    const match = sourceMatchers(cfg.sourceExtensions);
    const cap = (f) => (match.isTest(f) ? cfg.maxTestLines : cfg.maxLines);
    // A PR supplies an exact base scope; local commits use the index; audits use the whole tree.
    const selected = ciScope ?? (inCommit ? staged : null);
    const candidate = ciScope ? 'HEAD' : inCommit ? indexTreeRef(root) : null;
    const prBase = ciScope ? process.env.GUARD_RATCHET_BASE : undefined;
    const prParent = prBase ? mergeBaseRef(root, prBase) : null;
    const parents = prBase ? (prParent ? [prParent] : []) : undefined;
    const grandfathered = lineBaselineForGate(root, candidate, parents);
    const scoped = candidate && selected
        ? lineCountsAtRef(root, candidate, selected, cfg)
        : selected
            ? over.filter((o) => selected.has(o.file))
            : over;
    // A file fails when it exceeds its own recorded ceiling (grandfathered) or the cap (new file).
    const { error, lines: report } = lineViolationReport(root, cfg, scoped, cap, grandfathered, {
        candidate,
        inCommit,
        parents,
        prBase,
    });
    if (error) {
        console.error(error);
        process.exit(2);
    }
    if (report.length) {
        for (const line of report)
            console.error(line);
        process.exit(1);
    }
    if (ciScope || !inCommit || !staged)
        return; // CI never tightens/stages
    // Tighten only the committing files' ceilings; every other recorded count is preserved as-is,
    // so a concurrent agent's uncommitted shrink is never locked in.
    if (!candidate)
        return;
    const { files: next, lineCountVersion, tightened, } = tightenLineBaseline(root, candidate, staged, grandfathered, cap);
    if (tightened) {
        if (Object.keys(next).length === 0) {
            // Last grandfathered giant healed → the baseline is now empty. Delete it (an empty file is
            // not kept as a sentinel) and stage the removal so it rides this commit.
            removeRatchetBaseline(root, LINES_BASELINE, { stage: true });
            console.log(`✓ line debt cleared — ${LINES_BASELINE} removed & staged.`);
        }
        else {
            writeRatchetBaseline(root, LINES_BASELINE, `${JSON.stringify({ lineCountVersion, maxLines: cfg.maxLines, maxTestLines: cfg.maxTestLines, files: next }, null, 2)}\n`, { stage: true });
            console.log(`✓ line debt tightened — ${LINES_BASELINE} lowered & staged.`);
        }
    }
}
function readDisableBaseline(contents) {
    if (contents === null)
        return { grandfathered: {}, legacy: false };
    // SAFETY: this is Devkit-owned disable-baseline JSON; the legacy shape is handled below.
    const raw = JSON.parse(contents);
    if (raw?.files)
        return { grandfathered: raw.files, legacy: false };
    return { grandfathered: {}, legacy: true };
}
// The disable gate: the max-lines-disable analogue of runLinesGate, per-file and per-commit
// shrink-only (an unlisted file's ceiling is 0 — no NEW disables). Staged files → auto-lower/clear
// their entries and stage the baseline; nothing staged (CI / manual) → whole-tree enforce, never
// mutate. A pre-per-file baseline re-grandfathers via `guard-size freeze`: with real disables the
// gate blocks (its counts aren't recognised); a stale {0,0} self-deletes in the commit.
// Reason: sequential grow-check then per-file auto-lower, each a trivial guard at low nesting; one gate decision, mirrors runLinesGate
// fallow-ignore-next-line complexity
function runDisableGate(root, baselineContents, current, ciScope) {
    const { grandfathered, legacy } = readDisableBaseline(baselineContents);
    const cur = current.perFile;
    const staged = stagedSet(root);
    const inCommit = staged !== null && hasStagedFiles(root);
    const ceil = (f) => grandfathered[f] ?? { file: 0, fn: 0 };
    // A file fails when its disables exceed its recorded ceiling (0 for an unlisted/new file). A PR
    // scopes to its diff. Otherwise a LEGACY baseline stays whole-tree: it has no per-file
    // grandfathering, so an unstaged disable must block rather than let the commit path below delete
    // size.json wholesale (changed=legacy, empty map), silently un-grandfathering it.
    const selected = legacy ? null : (ciScope ?? (inCommit ? staged : null));
    const scoped = selected
        ? [...selected]
        : legacy
            ? Object.keys(cur)
            : Object.keys({ ...cur, ...grandfathered });
    const grew = scoped.filter((f) => cur[f] && (cur[f].file > ceil(f).file || cur[f].fn > ceil(f).fn));
    if (grew.length) {
        if (legacy) {
            console.error(`🚫 ${BASELINE} is a pre-per-file baseline — its grandfathered disables aren't recognised. Run \`guard-size freeze\` to migrate.`);
            process.exit(1);
        }
        console.error('🚫 New `eslint-disable max-lines` directive(s) — size debt may only SHRINK.');
        for (const f of grew) {
            console.error(`   ${f}: ${cur[f].file}/${cur[f].fn} file/fn disables vs ${ceil(f).file}/${ceil(f).fn} allowed`);
        }
        console.error('   Split the file below the cap instead of disabling.');
        process.exit(1);
    }
    if (ciScope || !inCommit || !staged) {
        // No commit in progress → never mutate. Nudge a re-freeze if anything shrank or a legacy file lingers.
        if (legacy) {
            console.log(`✓ ${BASELINE} is a pre-per-file baseline — run \`guard-size freeze\` to migrate.`);
        }
        else if (Object.keys(grandfathered).some((f) => (cur[f]?.file ?? 0) < grandfathered[f].file || (cur[f]?.fn ?? 0) < grandfathered[f].fn)) {
            console.log('✓ size debt shrank — run `guard-size freeze` to lock it in.');
        }
        return;
    }
    // In a commit: tighten only the committing files' entries. A legacy baseline (empty here) is always
    // rewritten off the old shape → its stale {0,0} is removed & staged.
    const next = { ...grandfathered };
    let changed = legacy;
    for (const f of staged) {
        if (!(f in grandfathered))
            continue;
        const c = cur[f]; // undefined = all disables healed
        if (!c) {
            delete next[f];
            changed = true;
        }
        else if (c.file < next[f].file || c.fn < next[f].fn) {
            next[f] = { file: Math.min(next[f].file, c.file), fn: Math.min(next[f].fn, c.fn) };
            changed = true;
        }
    }
    if (!changed)
        return;
    if (Object.keys(next).length === 0) {
        removeRatchetBaseline(root, SIZE_BASELINE, { stage: true });
        console.log(`✓ size debt cleared — ${SIZE_BASELINE} removed & staged.`);
    }
    else {
        writeRatchetBaseline(root, SIZE_BASELINE, `${JSON.stringify({ files: next }, null, 2)}\n`, {
            stage: true,
        });
        console.log(`✓ size debt tightened — ${SIZE_BASELINE} lowered & staged.`);
    }
}
// Reason: flat freeze/gate/usage CLI dispatch: branch count is one mutually-exclusive command state plus gate's sequential grew-file/grew-fn/shrank guards, each a trivial exit-or-print at near-zero nesting; splitting scatters the command handler
// fallow-ignore-next-line complexity
function runCli(cmd) {
    const root = process.cwd();
    const cfg = resolveGuardConfig(root);
    const current = countDisables(root);
    // Read after the tree walk rather than holding a potentially stale snapshot across the full scan.
    const baseline = readRatchetBaseline(root, BASELINE);
    if (cmd === 'freeze') {
        // Per-file map. Shrink-only: min against the prior per-file count so a --no-verify growth can't be
        // laundered back in. A pre-per-file (or missing) baseline has no per-file prior → this first freeze
        // re-grandfathers current counts (the migration point).
        const { grandfathered: prev } = readDisableBaseline(baseline?.contents ?? null);
        const files = {};
        for (const [f, c] of Object.entries(current.perFile)) {
            const p = prev[f];
            files[f] = p ? { file: Math.min(p.file, c.file), fn: Math.min(p.fn, c.fn) } : c;
        }
        if (Object.keys(files).length > 0) {
            writeRatchetBaseline(root, SIZE_BASELINE, `${JSON.stringify({ files }, null, 2)}\n`);
            console.log(`✓ ${SIZE_BASELINE}: frozen max-lines disables for ${Object.keys(files).length} file(s) (from ${current.scannedFiles} source files)`);
        }
        else {
            // No disables anywhere → no debt to grandfather. Don't write an empty baseline; delete a stale one.
            removeRatchetBaseline(root, SIZE_BASELINE);
            console.log(`✓ ${SIZE_BASELINE}: no max-lines disables (${current.scannedFiles} source files) — no baseline written`);
        }
        if (cfg.maxLines || cfg.maxTestLines) {
            const over = freezeLines(root, 'refresh');
            console.log(over > 0
                ? `✓ ${LINES_BASELINE}: ${over} oversized file(s) grandfathered`
                : `✓ ${LINES_BASELINE}: no oversized files — no baseline written`);
        }
        process.exit(0);
    }
    // Reason: the two ratchets (folder-fanout / size-disable) are parallel-by-design independent guard bins (+ tests); each self-contained with the same freeze/gate CLI shell
    // fallow-ignore-next-line code-duplication
    if (cmd === 'gate') {
        const ciScope = pullRequestScope(root);
        const hasBaseline = baseline !== null;
        // A missing baseline means "no grandfathered debt". Enforce from config (empty baseline = 0/0)
        // whenever the repo is governed (guard.config.json present — true in devkit's own repo, CI, and
        // any adopted consumer). Only an UNgoverned repo with no baseline fails open, so a repo that
        // never adopted the ratchet is never wedged. Never key this on .devkit/config.json — it is
        // absent in devkit's sync-dogfooded repo and in CI, which would silently disable the gate.
        if (!hasBaseline && !existsSync(join(root, CONFIG_FILENAME))) {
            process.exit(2); // ungoverned + un-frozen → fail open
        }
        // Disable ratchet: per-file, per-commit shrink-only (auto-lowers as disables are removed).
        runDisableGate(root, baseline?.contents ?? null, current, ciScope);
        if (cfg.maxLines || cfg.maxTestLines)
            runLinesGate(root, cfg, ciScope);
        process.exit(0);
    }
    console.error('usage: guard-size <freeze|gate|preflight --base <ref> [-- path...]>');
    process.exit(2);
}
// Run as a CLI only when invoked directly; importing this module (tests) has no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    if (process.argv[2] === 'preflight')
        runPreflightCli(process.argv.slice(3));
    runCli(process.argv[2]);
}
