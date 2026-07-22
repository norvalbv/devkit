/**
 * Detects devkit gate invocations living OUTSIDE the managed block — the "this gate runs twice per
 * commit" check. Split from hook-checks.mts (at its line budget) because the classifier carries all
 * the nuance: a bin name appears in a hook far more often than it is actually run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markEnd, markStart } from "../husky/husky.mjs";
// Bins devkit itself emits into the managed block. A call to one of these from outside the markers
// is (almost always) a hand-written copy that predates devkit owning the gate.
const DEVKIT_GATE_BINS = [
    'guard-deterministic',
    'guard-decisions',
    'guard-review',
    'guard-qavis-advisory',
    'guard-size',
    'guard-fanout',
    'guard-dup',
    'guard-clone',
    'guard-coverage',
];
// The gates `guard-deterministic` runs on the block's behalf — it is the single orchestrator, so
// these bin names never appear in the block themselves. Mirrors gate-engine/deterministic/run.mts.
const ORCHESTRATED_BINS = [
    'guard-size',
    'guard-fanout',
    'guard-dup',
    'guard-clone',
    'guard-coverage',
];
// Package-agnostic marker prefixes: a monorepo hook carries `# >>> devkit-guards: <pkg> >>>` per
// package, and every one of those ranges is managed territory (see strayGateCalls).
const MARK_START_ANY = '# >>> devkit-guards';
const MARK_END_ANY = '# <<< devkit-guards';
const SUBCOMMAND_RE = /^[a-z][a-z-]*$/;
const WHITESPACE_RE = /\s+/;
/** A remedy string naturally names the bin it tells you to run — not an invocation. */
const PRINTS_RE = /^(echo|printf)\b/;
/** Matches the text immediately BEFORE a bin when that bin is only being probed for existence. */
const PROBE_RE = /(^|[\s;|&(])(command\s+-v|which|type|hash)\s+$/;
// Whole-word boundaries around a bin occurrence, so `guard-dup-allowlist` is not a `guard-dup` call.
const BOUNDARY_BEFORE_RE = /[\s;|&(]$/;
const BOUNDARY_AFTER_RE = /^\s/;
// A package.json bin path (`./dist/gate-engine/review/cli.mjs`) → its self-host source form.
const DIST_PREFIX_RE = /^\.?\/?dist\//;
const MJS_EXT_RE = /\.mjs$/;
/**
 * The gate a line invokes, as `bin subcommand` (or just `bin`). The subcommand matters: devkit's
 * block runs `guard-decisions detect`, so a hand-written `guard-decisions detect` is a duplicate
 * but a hand-written `guard-decisions check-alignment` is NOT — devkit ships no fragment for it,
 * and flagging it would tell the consumer to delete their only invocation.
 */
/**
 * `[needle, bin]` pairs to scan for. In a SELF-HOSTED hook devkit rewrites `bunx guard-review` to
 * `node gate-engine/review/cli.mts` (see husky/self-host.mts), so the bin name never appears in the
 * block — scanning for names alone leaves blockSignatures empty and the whole check silently does
 * nothing in exactly the repo that dogfoods it. The alias comes from the consumer's own bin map.
 */
function gateNeedles(cwd) {
    const needles = DEVKIT_GATE_BINS.map((bin) => [bin, bin]);
    if (!cwd)
        return needles;
    try {
        const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
        for (const bin of DEVKIT_GATE_BINS) {
            const dist = pkg.bin?.[bin];
            if (dist)
                needles.push([dist.replace(DIST_PREFIX_RE, '').replace(MJS_EXT_RE, '.mts'), bin]);
        }
    }
    catch {
        // No/unreadable package.json — bin names alone still cover every non-self-hosted consumer.
    }
    return needles;
}
/**
 * Is the position after `before` inside a quoted string, or past an inline `#` comment? Walks the
 * prefix tracking shell quote state, because a bin name is very often *mentioned* rather than run —
 * in a remedy message or a trailing comment — and reporting those tells the consumer to go delete a
 * line that never invoked anything. Ambiguity resolves toward NOT reporting: this check is
 * advisory, so a missed duplicate is far cheaper than a false accusation.
 */
function isQuotedOrCommented(before) {
    let quote = null;
    for (let i = 0; i < before.length; i++) {
        const c = before[i];
        if (c === '\\') {
            i++;
            continue;
        }
        if (quote) {
            if (c === quote)
                quote = null;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            continue;
        }
        if (c === '#')
            return true;
    }
    return quote !== null;
}
function gateSignatures(code, needles) {
    const found = [];
    for (const [needle, bin] of needles) {
        // EVERY occurrence, not just the first: `command -v guard-dup && guard-dup scan` puts a probe
        // and a real invocation of the SAME bin on one line, so stopping at the first match filters the
        // whole bin away as "just a probe" and misses the duplicate entirely.
        for (let at = code.indexOf(needle); at !== -1; at = code.indexOf(needle, at + needle.length)) {
            const before = code.slice(0, at);
            const after = code.slice(at + needle.length);
            // Whole-word only — `guard-dup-allowlist` must not read as a `guard-dup` call.
            if (before && !BOUNDARY_BEFORE_RE.test(before))
                continue;
            if (after && !BOUNDARY_AFTER_RE.test(after))
                continue;
            // `command -v X` / `which X` ask whether the bin EXISTS; they never run the gate.
            if (PROBE_RE.test(before))
                continue;
            // Quoted or after an inline `#` — a message ABOUT the gate, not a call to it. Catches the
            // non-leading forms PRINTS_RE cannot: `[ -n "$V" ] && echo "next: guard-review --gate"`,
            // and `some_cmd  # guard-review runs in the block above`.
            if (isQuotedOrCommented(before))
                continue;
            found.push({ bin, at, end: at + needle.length });
        }
    }
    // Text order, so a chained line reads left-to-right in the report.
    return found
        .sort((a, b) => a.at - b.at)
        .map(({ bin, end }) => {
        const sub = code.slice(end).trim().split(WHITESPACE_RE)[0] ?? '';
        return SUBCOMMAND_RE.test(sub) ? `${bin} ${sub}` : bin;
    });
}
/**
 * Devkit gate invocations living OUTSIDE the managed block that the block ALSO runs — i.e. the
 * consumer runs that gate twice per commit. This is how a repo that hand-rolled its gates before
 * devkit absorbed them ends up paying for two LLM judges on every commit while
 * `.devkit/config.json` describes only one run.
 *
 * REPORT-ONLY on purpose. A stray call is *usually* legacy, but it can be deliberate — different
 * flags, a different position in the run order, a repo-specific wrapper — and devkit did not write
 * those lines, so it must never delete them unasked. Callers surface this loudly; a human decides.
 *
 * Two things keep this from crying wolf, both learned from real hooks:
 *   · it only reports a signature the managed block ALSO invokes, so a gate devkit doesn't emit
 *     (`guard-decisions check-alignment`) is left alone;
 *   · `echo`/`printf` lines are skipped, since a remedy string naturally names the very bin it is
 *     telling you to run.
 */
export function strayGateCalls(hookText, pkgRel = '', cwd) {
    const start = hookText.indexOf(markStart(pkgRel));
    const end = hookText.indexOf(markEnd(pkgRel));
    if (start === -1 || end === -1)
        return [];
    // Which gates THIS package's block runs — the set a duplicate must be drawn from.
    const needles = gateNeedles(cwd);
    const blockText = hookText.slice(start, end);
    const blockSignatures = new Set(blockText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && !PRINTS_RE.test(l))
        .flatMap((l) => gateSignatures(l, needles)));
    // `guard-deterministic` is an ORCHESTRATOR: the block never names size/fanout/dup/clone/coverage,
    // it runs them. Without expanding it, a stray `guard-dup` below the block could never match a
    // block signature and would go unreported — even though the orchestrator already runs that check.
    if (blockSignatures.has('guard-deterministic')) {
        for (const bin of ORCHESTRATED_BINS)
            blockSignatures.add(bin);
    }
    // "Managed" means EVERY devkit block in the file, not just this package's. A monorepo hook holds
    // one block per package, so a sibling's perfectly valid `guard-deterministic` sits outside this
    // package's range and would otherwise be reported as a duplicate — with a remedy telling the
    // consumer to delete a block devkit itself wrote.
    const managed = [];
    let cursor = 0;
    while (true) {
        const s = hookText.indexOf(MARK_START_ANY, cursor);
        if (s === -1)
            break;
        const e = hookText.indexOf(MARK_END_ANY, s);
        if (e === -1)
            break;
        managed.push([s, e + MARK_END_ANY.length]);
        cursor = e + MARK_END_ANY.length;
    }
    const insideManaged = (at) => managed.some(([s, e]) => at > s && at < e);
    const stray = [];
    let offset = 0;
    hookText.split('\n').forEach((raw, i) => {
        const lineStart = offset;
        offset += raw.length + 1;
        if (insideManaged(lineStart))
            return; // inside a managed block is where these belong
        const code = raw.trim();
        if (!code || code.startsWith('#') || PRINTS_RE.test(code))
            return;
        for (const sig of gateSignatures(code, needles)) {
            // Exact `bin subcommand` match, PLUS a bare-bin match for the gates guard-deterministic
            // orchestrates (the block names only the orchestrator, so a stray `guard-dup scan` has no
            // exact counterpart). The bare fallback is deliberately limited to those: applied to every
            // bin it would flag any OTHER subcommand of a gate the block runs — `guard-review transcript`
            // is a different command, not a second run of `guard-review --gate`.
            const bare = sig.split(' ')[0] ?? sig;
            const orchestrated = ORCHESTRATED_BINS.includes(bare) && blockSignatures.has(bare);
            if (blockSignatures.has(sig) || orchestrated) {
                stray.push({ bin: sig, line: i + 1, text: code });
            }
        }
    });
    return stray;
}
/**
 * Print the stray-call warning in the plain-log style `devkit doctor --self-host` uses (it builds no
 * CheckResult list). Silent when there is nothing to report. Never offers a fix: regenerating the
 * managed block cannot remove a line that lives outside it.
 */
export function printStrayGateCalls(hookText, pkgRel, cwd) {
    const stray = strayGateCalls(hookText, pkgRel, cwd);
    if (!stray.length)
        return;
    console.log(`  ⚠ ${stray.length} devkit gate call(s) OUTSIDE the managed block — these run a second time every commit:`);
    for (const s of stray)
        console.log(`      ${s.bin} (line ${s.line})`);
    console.log('      each duplicates a gate the block already runs — delete it, or keep it deliberately if it differs');
}
