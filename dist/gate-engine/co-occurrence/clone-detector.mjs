#!/usr/bin/env node
/**
 * clone-detector — token-level copy-paste / sub-chunk / molecule detector.
 *
 * Wraps jscpd (Rabin-Karp, boundary-free) to catch duplication the embedding
 * matcher (matcher.mjs) misses: blocks duplicated INSIDE a larger symbol
 * (sub-chunk) and repeated inline JSX ("molecules"). Verbatim by design —
 * complements, doesn't replace, the semantic matcher.
 *
 * Shells the jscpd CLI (avoids ESM/CJS interop); parses its JSON report. Each
 * clone is keyed by a hash of its normalised duplicated fragment, NOT a line
 * range — so an allowlist approval survives unrelated edits and only re-surfaces
 * when the duplicated code itself changes.
 *
 * ── Portability (W-3) ────────────────────────────────────────────────────────
 * Scan roots (--paths default), the allowlist, and the jscpd cwd all resolve
 * against the CONSUMER cwd (process.cwd()) via resolveGuardConfig — never the
 * package dir. --paths / --min-tokens default from config.scanRoots /
 * config.thresholds.minTokens. JSCPD_BIN stays env-overridable (default
 * <cwd>/node_modules/.bin/jscpd); a missing jscpd fails OPEN (no crash).
 *
 * Usage:
 *   guard-clone scan [--min-tokens 50] [--paths "src/renderer src/main"]
 *   guard-clone json   # machine-readable clones
 *   guard-clone scan --changed --gate
 *       # commit gate: clones touching a staged file (--changed, set via
 *       # MATCHER_CHANGED_FILES or git), not covered by a live allowlist clone.
 *       # exit 1 = new clone → block · 0 = clean · 2 = could-not-run → fail-open.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFromCwd, resolveGuardConfig } from "../config.mjs";
import { loadChangedSet } from "./changed-files.mjs";
import { isExpired } from "./decay.mjs";
// Resolve config against the consumer cwd (W-3). Scan roots, allowlist, jscpd cwd all key off it.
const cfg = resolveGuardConfig(process.cwd());
const repoRoot = cfg.cwd;
// Allowlist: CO_OCCURRENCE_ALLOWLIST env (fixtures/tests) wins; else config.allowlistPath.
const allowlistPath = process.env.CO_OCCURRENCE_ALLOWLIST ?? resolveFromCwd(cfg, 'allowlistPath');
// Approval-hint CLI on a gate block — generic default = the engine's own bin; a consumer
// can point it at their own wrapper via GUARD_ALLOWLIST_CLI. The printed command
// double-quotes args; assumes paths/hashes are shell-safe (git-tracked paths + hex hashes).
const CO_SCRIPT = process.env.GUARD_ALLOWLIST_CLI || 'bunx guard-dup-allowlist';
const DEFAULTS = {
    // Token-clone floor + scan roots seed from the resolved config (consumer-tunable);
    // CLI --flags override per run.
    minTokens: cfg.thresholds.minTokens,
    paths: cfg.scanRoots,
    // Test boilerplate duplication is out of scope (dominates clone counts).
    ignore: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/__mocks__/**'],
};
// jscpd auto-detects formats by extension; we keep only source code clones.
const CODE_EXT = /\.(tsx?|jsx?)$/;
// jscpd bin resolution — HOIST-AGNOSTIC. Prefer devkit's OWN bundled jscpd (shipped as an
// optionalDependency) so a standalone/global consumer needs NO jscpd dep of their own; JSCPD_BIN env
// wins (tests/custom); the consumer's own node_modules is the last resort (package mode). We probe
// candidate `.bin` paths rather than `require.resolve('jscpd/package.json')` — jscpd's `exports`
// blocks that subpath. None found → fall back to the consumer path so a missing binary still fails
// OPEN (execFileSync throws ENOENT → caught below → exit 2), exactly as before.
const OWN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'); // gate-engine/co-occurrence → devkit root
const JSCPD_BIN = 
// JSCPD_BIN env wins VERBATIM (explicit override — used even if it doesn't exist, so a test can
// force the missing-binary fail-open path). Otherwise probe candidates, preferring devkit's OWN
// bundled jscpd; fall back to the consumer path so a truly-missing binary still fails OPEN below.
process.env.JSCPD_BIN ??
    [
        resolve(OWN_ROOT, 'node_modules', '.bin', 'jscpd'), // devkit dogfood tree
        resolve(OWN_ROOT, '..', '..', '.bin', 'jscpd'), // consumed/global: hoist root beside @norvalbv/devkit
        resolve(repoRoot, 'node_modules', '.bin', 'jscpd'), // consumer's own (package mode)
    ].find((p) => existsSync(p)) ??
    resolve(repoRoot, 'node_modules/.bin/jscpd');
/**
 * Run jscpd over `paths` and return normalised clone pairs.
 * Cross-file only by default — a block repeated WITHIN one file is a local
 * refactor, out of scope for the cross-file reuse story (and the noisiest:
 * near-dup fragments fragment into many overlapping entries). Pass
 * `includeSameFile: true` to also return intra-file clones.
 */
export function detectClones({ minTokens = DEFAULTS.minTokens, paths = DEFAULTS.paths, includeSameFile = false, } = {}) {
    const out = mkdtempSync(join(tmpdir(), 'jscpd-'));
    // finally guarantees the temp report dir is removed on every path — jscpd
    // failure, malformed report, or a throw inside the parse/map.
    try {
        try {
            execFileSync(JSCPD_BIN, [
                ...paths,
                '--min-tokens',
                String(minTokens),
                '--mode',
                'mild',
                '--reporters',
                'json',
                '--output',
                out,
                '--ignore',
                DEFAULTS.ignore.join(','),
                '--silent',
            ], { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] });
        }
        catch (e) {
            // jscpd exits non-zero only with --threshold (we set none), so a throw
            // here is a real failure — usually the binary is missing.
            throw new Error(`jscpd failed (${e instanceof Error ? e.message : String(e)}). Ensure the 'jscpd' dependency is installed (e.g. bun add -d jscpd) or set JSCPD_BIN to its path.`);
        }
        const reportPath = join(out, 'jscpd-report.json');
        if (!existsSync(reportPath))
            return [];
        const report = JSON.parse(readFileSync(reportPath, 'utf8'));
        return (report.duplicates ?? [])
            .filter((d) => CODE_EXT.test(d.firstFile.name) && CODE_EXT.test(d.secondFile.name))
            .filter((d) => includeSameFile || d.firstFile.name !== d.secondFile.name)
            .map((d) => ({
            fragmentHash: hashFragment(d.fragment ?? ''),
            lines: d.lines,
            tokens: d.tokens,
            fileA: relPath(d.firstFile.name),
            startA: d.firstFile.startLoc ?? d.firstFile.start,
            endA: d.firstFile.endLoc ?? d.firstFile.end,
            fileB: relPath(d.secondFile.name),
            startB: d.secondFile.startLoc ?? d.secondFile.start,
            endB: d.secondFile.endLoc ?? d.secondFile.end,
            fragment: d.fragment ?? '',
        }))
            .sort((a, b) => b.lines - a.lines);
    }
    finally {
        rmSync(out, { recursive: true, force: true });
    }
}
const SRC_PREFIX_RE = /^.*\/src\//;
const BACKSLASH_RE = /\\/g;
const WHITESPACE_RE = /\s+/g;
export function relPath(f) {
    // Normalize '\'→'/' FIRST so the repo-root strip + SRC_PREFIX_RE (both '/'-based) match a
    // Windows-style path jscpd might report; keeps allowlist keys forward-slash + OS-agnostic.
    // Strip against the CONSUMER cwd (repoRoot = cfg.cwd), not the package dir.
    return f.replace(BACKSLASH_RE, '/').replace(`${repoRoot}/`, '').replace(SRC_PREFIX_RE, 'src/');
}
/** Stable key: hash the fragment with whitespace collapsed so reformatting
 * doesn't change the key, but real code changes do. */
export function hashFragment(fragment) {
    const normalised = fragment.replace(WHITESPACE_RE, ' ').trim();
    return createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}
/** Fragment hashes of clones already approved AND still live (non-expired) in the
 * allowlist — the gate surfaces only clones not in this set. */
function liveAllowlistedHashes() {
    // Missing → no approvals yet (empty). But a corrupt-but-PRESENT file must NOT silently
    // become "empty" — that makes every approved clone re-surface as novel → the gate
    // false-blocks (the inverse of the matcher's wipe). Fail OPEN instead (exit 2), matching
    // the matcher's contract: an infra/corrupt failure never bricks a commit.
    if (allowlistPath == null || !existsSync(allowlistPath))
        return new Set();
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(allowlistPath, 'utf8'));
    }
    catch {
        console.error(`clone-detector: ${allowlistPath} exists but is not valid JSON — refusing (fail-open).`);
        process.exit(2);
    }
    if (!parsed || typeof parsed !== 'object') {
        console.error(`clone-detector: ${allowlistPath} is not a valid allowlist object — refusing (fail-open).`);
        process.exit(2);
    }
    const clones = Array.isArray(parsed.clones) ? parsed.clones : [];
    return new Set(clones.filter((c) => !isExpired(c)).map((c) => c.fragmentHash));
}
const loc = (c, side) => {
    const v = c[side];
    return typeof v === 'number' ? v : v.line;
};
// ── CLI ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const mode = argv[0] ?? 'scan';
const flag = (name, def) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : def;
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const minTokens = Number(flag('--min-tokens', DEFAULTS.minTokens));
    const pathsArg = flag('--paths', null);
    const paths = pathsArg ? pathsArg.split(/\s+/) : DEFAULTS.paths;
    const includeSameFile = argv.includes('--include-same-file');
    const gate = argv.includes('--gate');
    const changed = argv.includes('--changed');
    let clones;
    try {
        clones = detectClones({ minTokens, paths, includeSameFile });
    }
    catch (e) {
        // jscpd missing / errored = "could not run". The gate fails OPEN (exit 2) so
        // an infra failure never bricks a commit; non-gate callers surface the error.
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(gate ? 2 : 1);
    }
    // --changed: keep only clones touching a staged file — this commit's clones,
    // not pre-existing ones. Staged set from the hook's staged list / git.
    if (changed) {
        const staged = loadChangedSet(repoRoot);
        clones = clones.filter((c) => staged.has(c.fileA) || staged.has(c.fileB));
    }
    if (gate) {
        // Block on NEW clones (fragmentHash not covered by a live allowlist entry).
        const allowed = liveAllowlistedHashes();
        const novel = clones.filter((c) => !allowed.has(c.fragmentHash));
        for (const c of novel) {
            console.log(`  ${String(c.lines).padStart(3)}L  ${c.fragmentHash}  ${c.fileA}:${loc(c, 'startA')} <> ${c.fileB}:${loc(c, 'startB')}`);
        }
        if (novel.length > 0) {
            console.log(`\nclone gate: ${novel.length} new clone(s) — block.`);
            // Ready-to-paste approval, pre-filled with lines + ranges (fill in <why>), so an
            // approved entry keeps its metadata instead of the empty fields you get by hand.
            // Capped to APPROVE_CAP (mirrors matcher.mjs) — every clone is listed in the rows
            // above; the full command set stays out of the token stream and re-prints on re-run.
            const APPROVE_CAP = 6;
            console.log('To approve an intentional clone (fill in the reason):');
            for (const c of novel.slice(0, APPROVE_CAP)) {
                console.log(`  ${CO_SCRIPT} add-clone "${c.fragmentHash}" "${c.fileA}" "${c.fileB}" --lines ${c.lines} --range-a ${loc(c, 'startA')}-${loc(c, 'endA')} --range-b ${loc(c, 'startB')}-${loc(c, 'endB')} --description "<why>"`);
            }
            if (novel.length > APPROVE_CAP) {
                console.log(`  (+${novel.length - APPROVE_CAP} more — re-run after addressing these)`);
            }
        }
        else {
            console.log('clone gate: no new clones ✓');
        }
        process.exit(novel.length > 0 ? 1 : 0);
    }
    if (mode === 'json') {
        process.stdout.write(JSON.stringify(clones, null, 2));
    }
    else {
        const sameFile = clones.filter((c) => c.fileA === c.fileB).length;
        console.log(`clone-detector: ${clones.length} clones (min-tokens ${minTokens}) — ${sameFile} same-file (sub-chunk), ${clones.length - sameFile} cross-file`);
        console.log('');
        for (const c of clones.slice(0, 15)) {
            const where = c.fileA === c.fileB
                ? `${c.fileA} (${loc(c, 'startA')}↔${loc(c, 'startB')})`
                : `${c.fileA}:${loc(c, 'startA')} <> ${c.fileB}:${loc(c, 'startB')}`;
            console.log(`  ${String(c.lines).padStart(3)}L  ${c.fragmentHash}  ${where}`);
        }
        if (clones.length > 15)
            console.log(`  … +${clones.length - 15} more`);
    }
}
