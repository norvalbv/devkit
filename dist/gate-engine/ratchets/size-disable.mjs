#!/usr/bin/env node
// Size-debt ratchet: the inline `eslint-disable max-lines` / `max-lines-per-function`
// directives are the ONLY way a file escapes the project's line/function caps. A NEW
// oversized file would need such a disable — so we freeze the current disable counts
// and refuse to let them GROW. Existing giants are grandfathered; the count can only
// shrink (split a file, delete its disable).
//
// This is the mechanism that makes another 5k-LOC monolith un-birthable: max-lines is
// already enforced at commit, so without a new disable a fresh oversized file fails
// lint — and this gate blocks the new disable.
//
//   bunx guard-size freeze   # re-count + write the consumer's baseline
//   bunx guard-size gate     # fail if counts grew (pre-commit)
//
// PARAMETERIZED (W-3): scanRoots come from resolveGuardConfig(cwd) — the CONSUMER's
// guard.config.json + GUARD_* env, never hardcoded. The baseline
// (eslint/baselines/size.json) is per-repo STATE: read/written under the CONSUMER cwd,
// never the package dir. Per the "never hard-code a count" rule, freeze re-walks the
// tree and writes whatever it finds — never a literal.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILENAME, resolveGuardConfig, sourceMatchers } from "../config.mjs";
import { hasStagedFiles, stageBaseline, stagedSet } from "./git-index.mjs";
// Per-repo STATE, resolved against the consumer cwd (never __dirname).
const BASELINE = 'eslint/baselines/size.json';
// Raw-line cap baseline (the `maxLines` gate): grandfathered over-cap source files, shrink-only.
const LINES_BASELINE = 'eslint/baselines/size-lines.json';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '__snapshots__', '_shared']);
// Only an actual directive comment counts — a line that merely MENTIONS the phrase
// (string literal, prose comment) must not inflate the ratchet and falsely block.
const DIRECTIVE_START = /^\s*(?:\/\/|\/\*)\s*eslint-disable/;
// Disable-directive counters, hoisted (devkit lint: useTopLevelRegex) — matched per source line.
const RE_MAX_LINES_PER_FN = /max-lines-per-function/g;
const RE_MAX_LINES = /max-lines\b/g;
// `match` = the cfg.sourceExtensions matchers (TS by default; a JS/MJS repo sets ["mjs","js"]).
function walk(root, dir, files, match) {
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
            if (!SKIP_DIRS.has(e.name))
                walk(root, rel, files, match);
        }
        else if (match.isSource(e.name) && !match.isTest(e.name)) {
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
    let fileDisables = 0;
    let fnDisables = 0;
    for (const f of files) {
        const text = readFileSync(join(root, f), 'utf8');
        for (const line of text.split('\n')) {
            if (!DIRECTIVE_START.test(line))
                continue;
            const fn = (line.match(RE_MAX_LINES_PER_FN) || []).length;
            const file = (line.replace(RE_MAX_LINES_PER_FN, '').match(RE_MAX_LINES) || []).length;
            fnDisables += fn;
            fileDisables += file;
        }
    }
    return { fileDisables, fnDisables, scannedFiles: files.length };
}
// Raw-line cap: source (non-test) files whose line count exceeds `maxLines`. Counts ALL lines (matches
// eslint's max-lines with skipBlankLines/skipComments false). Returns a sorted [{file, lines}] list;
// empty when the cap is off (`maxLines` 0). This is what lets size be ratchet-owned — no eslint rule.
export function countOversized(root = process.cwd(), scanRoots, maxLines, match) {
    const cfg = resolveGuardConfig(root);
    const cap = maxLines ?? cfg.maxLines;
    if (!cap)
        return [];
    const m = match ?? sourceMatchers(cfg.sourceExtensions);
    const files = (scanRoots ?? cfg.scanRoots).flatMap((r) => walk(root, r, [], m));
    const over = [];
    for (const f of files) {
        const lines = readFileSync(join(root, f), 'utf8').split('\n').length;
        if (lines > cap)
            over.push({ file: f, lines });
    }
    return over.sort((a, b) => a.file.localeCompare(b.file));
}
// Grandfather the current over-cap source files into the raw-line baseline (size-lines.json),
// shrink-only — min(prev, current) so a re-freeze after a `--no-verify` growth can't launder a larger
// count back in. Writes ONLY the line baseline; it NEVER touches the disable-count baseline
// (size.json), so an already-adopted repo can turn the cap on without re-snapshotting (and possibly
// laundering) its disable debt. Returns the number of files over the cap; deletes a stale baseline
// when none remain. No-op (returns 0) when the cap is off (`maxLines` 0).
export function freezeLines(root = process.cwd()) {
    const cfg = resolveGuardConfig(root);
    if (!cfg.maxLines)
        return 0;
    const linesBaselineFile = join(root, LINES_BASELINE);
    const over = countOversized(root);
    const prev = existsSync(linesBaselineFile)
        ? JSON.parse(readFileSync(linesBaselineFile, 'utf8')).files
        : {};
    const files = Object.fromEntries(over.map((o) => [o.file, o.file in prev ? Math.min(prev[o.file], o.lines) : o.lines]));
    if (Object.keys(files).length > 0) {
        mkdirSync(dirname(linesBaselineFile), { recursive: true });
        writeFileSync(linesBaselineFile, `${JSON.stringify({ maxLines: cfg.maxLines, files }, null, 2)}\n`);
    }
    else {
        rmSync(linesBaselineFile, { force: true });
    }
    return over.length;
}
// ── line-growth block enablement (onboarding + upgrade back-fill) ───────────────────────────────
// Turning the maxLines cap ON is a config write (guard.config.json) — the mirror of the gate below
// that ENFORCES it. Kept here so the cap value + its grandfather freeze share one home. `devkit init`
// writes the cap on first adoption (its own freeze grandfathers giants); `devkit upgrade` calls
// enableLineGrowth to set the cap AND grandfather in one step on an already-adopted repo.
// The default raw-line cap written when the block is enabled. Fixed — a consumer tunes it by
// hand-editing guard.config.json (setMaxLines preserves an existing positive value).
export const LINE_CAP = 500;
// The //-comment sibling written next to `maxLines` (guard.config.json keeps guidance in "//" keys).
const MAXLINES_DOC = 'Raw line cap per source file (guard-size ratchet enforces it; existing giants grandfathered shrink-only). 0 = off. Per-FUNCTION caps need a parser — not yet.';
/** Does guard.config.json already declare a positive `maxLines` cap? */
export function hasLineCap(cwd) {
    const cfgPath = join(cwd, 'guard.config.json');
    if (!existsSync(cfgPath))
        return false;
    try {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
        return typeof cfg.maxLines === 'number' && cfg.maxLines > 0;
    }
    catch {
        return false;
    }
}
/**
 * Write `maxLines` (+ its doc sibling) into guard.config.json when it isn't already a positive cap.
 * Add-only — never overwrites a consumer's tuned value. No-op (returns false) when guard.config.json
 * wasn't written (no guards/structure selected) or a cap is already set. Returns true when it wrote.
 */
export function setMaxLines(cwd, cap = LINE_CAP) {
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
    if (typeof cfg.maxLines === 'number' && cfg.maxLines > 0)
        return false;
    cfg['//maxLines'] = MAXLINES_DOC;
    cfg.maxLines = cap;
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
/** How many source files WOULD be grandfathered at the default cap — for `--dry-run`; writes nothing. */
export function previewGrandfather(cwd) {
    return countOversized(cwd, undefined, LINE_CAP).length;
}
// The maxLines gate as a per-file, per-commit shrink-only ratchet. When files are staged (a
// commit in progress) it evaluates ONLY those files, so a parallel agent's unstaged edits can
// neither block this commit nor tighten their files' ceilings. With nothing staged (CI, or a
// manual `guard-size gate`) it enforces the whole committed tree and never mutates — there is
// no commit to carry a baseline change. Exits 1 on a file over its ceiling.
// Reason: sequential grow-check then per-file auto-lower, each a trivial guard at low nesting; splitting scatters one gate decision
// fallow-ignore-next-line complexity
function runLinesGate(root, cfg, linesBaselineFile) {
    const over = countOversized(root);
    const grandfathered = existsSync(linesBaselineFile)
        ? JSON.parse(readFileSync(linesBaselineFile, 'utf8')).files
        : {};
    const staged = stagedSet(root);
    const inCommit = staged !== null && staged.size > 0;
    // Scope to the committing files; with nothing staged, fall back to the whole tree (CI).
    const scoped = inCommit ? over.filter((o) => staged?.has(o.file)) : over;
    // A file fails when it exceeds its own recorded ceiling (grandfathered) or the cap (new file).
    const grew = scoped.filter((o) => o.lines > Math.max(cfg.maxLines, grandfathered[o.file] ?? 0));
    if (grew.length) {
        console.error(`🚫 ${grew.length} file(s) exceed their line limit — split them:`);
        for (const o of grew) {
            console.error(`   ${o.file}: ${o.lines} lines (max ${Math.max(cfg.maxLines, grandfathered[o.file] ?? 0)})`);
        }
        process.exit(1);
    }
    if (!inCommit || !staged)
        return; // no commit in progress → never tighten/stage
    // Tighten only the committing files' ceilings; every other recorded count is preserved as-is,
    // so a concurrent agent's uncommitted shrink is never locked in.
    const next = { ...grandfathered };
    let tightened = false;
    for (const f of staged) {
        if (!(f in grandfathered))
            continue;
        const cur = over.find((o) => o.file === f)?.lines; // undefined = healed under the cap
        if (cur === undefined) {
            delete next[f];
            tightened = true;
        }
        else if (cur < grandfathered[f]) {
            next[f] = cur;
            tightened = true;
        }
    }
    if (tightened) {
        if (Object.keys(next).length === 0) {
            // Last grandfathered giant healed → the baseline is now empty. Delete it (an empty file is
            // not kept as a sentinel) and stage the removal so it rides this commit.
            rmSync(linesBaselineFile, { force: true });
            stageBaseline(root, LINES_BASELINE);
            console.log(`✓ line debt cleared — ${LINES_BASELINE} removed & staged.`);
        }
        else {
            writeFileSync(linesBaselineFile, `${JSON.stringify({ maxLines: cfg.maxLines, files: next }, null, 2)}\n`);
            stageBaseline(root, LINES_BASELINE);
            console.log(`✓ line debt tightened — ${LINES_BASELINE} lowered & staged.`);
        }
    }
}
// Reason: flat freeze/gate/usage CLI dispatch: branch count is one mutually-exclusive command state plus gate's sequential grew-file/grew-fn/shrank guards, each a trivial exit-or-print at near-zero nesting; splitting scatters the command handler
// fallow-ignore-next-line complexity
function runCli(cmd) {
    const root = process.cwd();
    const cfg = resolveGuardConfig(root);
    const baselineFile = join(root, BASELINE);
    const linesBaselineFile = join(root, LINES_BASELINE);
    const current = countDisables(root);
    if (cmd === 'freeze') {
        const out = { fileDisables: current.fileDisables, fnDisables: current.fnDisables };
        if (out.fileDisables || out.fnDisables) {
            mkdirSync(dirname(baselineFile), { recursive: true });
            writeFileSync(baselineFile, `${JSON.stringify(out, null, 2)}\n`);
            console.log(`✓ ${BASELINE}: frozen max-lines disables = ${out.fileDisables} file-level, ${out.fnDisables} per-function (from ${current.scannedFiles} source files)`);
        }
        else {
            // No disables anywhere → no debt to grandfather. Don't write an empty baseline; delete a stale one.
            rmSync(baselineFile, { force: true });
            console.log(`✓ ${BASELINE}: no max-lines disables (${current.scannedFiles} source files) — no baseline written`);
        }
        if (cfg.maxLines) {
            const over = freezeLines(root);
            console.log(over > 0
                ? `✓ ${LINES_BASELINE}: ${over} file(s) over ${cfg.maxLines} lines grandfathered (shrink-only)`
                : `✓ ${LINES_BASELINE}: no file over ${cfg.maxLines} lines — no baseline written`);
        }
        process.exit(0);
    }
    // Reason: the two ratchets (folder-fanout / size-disable) are parallel-by-design independent guard bins (+ tests); each self-contained with the same freeze/gate CLI shell
    // fallow-ignore-next-line code-duplication
    if (cmd === 'gate') {
        const hasBaseline = existsSync(baselineFile);
        // A missing baseline means "no grandfathered debt". Enforce from config (empty baseline = 0/0)
        // whenever the repo is governed (guard.config.json present — true in devkit's own repo, CI, and
        // any adopted consumer). Only an UNgoverned repo with no baseline fails open, so a repo that
        // never adopted the ratchet is never wedged. Never key this on .devkit/config.json — it is
        // absent in devkit's sync-dogfooded repo and in CI, which would silently disable the gate.
        if (!hasBaseline && !existsSync(join(root, CONFIG_FILENAME))) {
            process.exit(2); // ungoverned + un-frozen → fail open
        }
        const frozen = hasBaseline
            ? JSON.parse(readFileSync(baselineFile, 'utf8'))
            : { fileDisables: 0, fnDisables: 0 };
        const grewFile = current.fileDisables > frozen.fileDisables;
        const grewFn = current.fnDisables > frozen.fnDisables;
        if (grewFile || grewFn) {
            console.error('🚫 New `eslint-disable max-lines` directive(s) — size debt may only SHRINK.');
            if (grewFile)
                console.error(`   file-level: ${current.fileDisables} now vs ${frozen.fileDisables} allowed`);
            if (grewFn)
                console.error(`   per-function: ${current.fnDisables} now vs ${frozen.fnDisables} allowed`);
            console.error('   Split the file below the cap instead of disabling.');
            process.exit(1);
        }
        // Debt fully healed (frozen had disables, now none): self-delete the stale baseline in a real
        // commit so it doesn't linger. A partial shrink just reminds to re-freeze.
        const healed = (frozen.fileDisables > 0 || frozen.fnDisables > 0) &&
            current.fileDisables === 0 &&
            current.fnDisables === 0;
        if (healed && hasBaseline) {
            if (hasStagedFiles(root)) {
                rmSync(baselineFile, { force: true });
                stageBaseline(root, BASELINE);
                console.log(`✓ size debt cleared — ${BASELINE} removed & staged.`);
            }
            else {
                console.log(`✓ size debt shrank to zero — run \`guard-size freeze\` to remove ${BASELINE}.`);
            }
        }
        else if (current.fileDisables < frozen.fileDisables ||
            current.fnDisables < frozen.fnDisables) {
            console.log(`✓ size debt shrank (${current.fileDisables}/${current.fnDisables} vs frozen ${frozen.fileDisables}/${frozen.fnDisables}) — run \`guard-size freeze\` to lock it in.`);
        }
        // Raw-line cap (the maxLines gate): a per-file, per-COMMIT shrink-only ratchet.
        if (cfg.maxLines)
            runLinesGate(root, cfg, linesBaselineFile);
        process.exit(0);
    }
    console.error('usage: guard-size <freeze|gate>');
    process.exit(2);
}
// Run as a CLI only when invoked directly; importing this module (tests) has no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    runCli(process.argv[2]);
}
