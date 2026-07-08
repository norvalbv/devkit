#!/usr/bin/env node
/**
 * guard-dup-allowlist — CRUD over `.co-occurrence-allowlist.json`, the tool the dup gate
 * (guard-dup / matcher) and clone gate (guard-clone / clone-detector) print as their
 * approval remedy. Before this shipped the gates advertised a bin that did not exist and
 * the only way to approve an intentional dup was hand-editing the JSON.
 *
 * ── Portability (W-3) ────────────────────────────────────────────────────────
 * The allowlist path resolves against the CONSUMER cwd via resolveGuardConfig — the
 * CO_OCCURRENCE_ALLOWLIST env (fixtures/tests) wins, else config.allowlistPath (default
 * `.co-occurrence-allowlist.json`). No index needed; this only mutates JSON.
 *
 * Modes (see `guard-dup-allowlist --help`):
 *   add <symA> <fileA> <symB> <fileB> --description "why" [--similarity N] [--range-a R] [--range-b R] [--decay-days N]
 *   add-clone <hash> <fileA> <fileB>  --description "why" [--lines N] [--range-a R] [--range-b R] [--decay-days N]
 *   remove <symA> <fileA> <symB> <fileB>      remove-clone <hash>
 *   check <symA> <fileA> <symB> <fileB>       # exit 0 if a live entry covers it, 1 if not
 *   list [--json]                             prune   # drop entries past date + decayDays
 *
 * Every mutation is read-`loadAllowlist`-modify-`saveAllowlist`; a corrupt allowlist makes
 * `loadAllowlist` refuse (exit 2) without writing, so no verb can wipe baselined entries.
 */
import { fileURLToPath } from 'node:url';
import { resolveFromCwd, resolveGuardConfig } from "../config.mjs";
import { loadAllowlist, MODES, saveAllowlist, symFileKey, } from "./allowlist-io.mjs";
import { isExpired } from "./decay.mjs";
const LABEL = 'guard-dup-allowlist';
// The freeze threshold baseline entries use (matcher runBaseline --decay-days default). A
// re-add must never drop below it, else a baselined pair silently un-freezes (7-day decay).
const BASELINE_DECAY = 3650;
const BACKSLASH_RE = /\\/g;
const norm = (p) => p.replace(BACKSLASH_RE, '/');
const today = () => new Date().toISOString().slice(0, 10);
// Resolve the allowlist path the same way both detectors do; refuse (exit 2) if unset.
function allowlistPath() {
    const p = process.env.CO_OCCURRENCE_ALLOWLIST ??
        resolveFromCwd(resolveGuardConfig(process.cwd()), 'allowlistPath');
    if (p == null) {
        console.error(`${LABEL}: no allowlist path configured (guard.config.json allowlistPath).`);
        process.exit(2);
    }
    return p;
}
// Parse `<pos...> [--flag value | --bool]`, flags may interleave with positionals. A flag
// followed by a non-`--` token consumes it as the value; otherwise it's a boolean.
function parseArgs(argv) {
    const positionals = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                flags[a.slice(2)] = next;
                i++;
            }
            else
                flags[a.slice(2)] = true;
        }
        else
            positionals.push(a);
    }
    return { positionals, flags };
}
const strFlag = (v) => typeof v === 'string' && v.trim() !== '' ? v : undefined;
const numFlag = (v) => {
    const s = strFlag(v);
    return s !== undefined && !Number.isNaN(Number(s)) ? Number(s) : undefined;
};
// A required, MEANINGFUL reason — an unexplained approval defeats the gate. Reject both a
// missing --description and the literal `<why>` placeholder the gate prints for you to fill.
function requireDescription(flags) {
    const d = strFlag(flags.description);
    if (d === undefined || d.trim() === '<why>') {
        console.error(`${LABEL}: --description "<real reason>" is required (replace the <why> placeholder).`);
        process.exit(1);
    }
    return d;
}
function usageError(msg) {
    console.error(`${LABEL} ${msg}`);
    process.exit(1);
}
// A frozen baseline entry: 3650-day decay or a "baseline …" description (matcher runBaseline).
const isBaseline = (p) => String(p.description ?? '').startsWith('baseline ') || (p.decayDays ?? 0) >= BASELINE_DECAY;
// A decay of < 1 day is instantly expired — the approval would report success yet the gate
// would keep blocking (a silently useless entry). Reject it rather than write a dead approval.
function requirePositiveDecay(flags) {
    const d = numFlag(flags['decay-days']);
    if (d !== undefined && d < 1)
        usageError('--decay-days must be an integer >= 1.');
    return d;
}
function runAdd({ positionals, flags }) {
    if (positionals.length !== 4)
        usageError('add: expected <symA> <fileA> <symB> <fileB>.');
    const description = requireDescription(flags);
    const [symbolA, symbolB] = [positionals[0], positionals[2]];
    const fileA = norm(positionals[1]);
    const fileB = norm(positionals[3]);
    const decayDays = requirePositiveDecay(flags);
    const key = symFileKey({ symbolA, fileA, symbolB, fileB });
    const path = allowlistPath();
    const { pairs, clones } = loadAllowlist(path, LABEL);
    const existing = pairs.find((p) => symFileKey(p) === key);
    // Baseline guard: a frozen baseline entry (decayDays 3650 / "baseline …") is left ENTIRELY
    // untouched. A re-add is almost always the gate command pasted over an already-baselined
    // pair; downgrading its decay would silently un-freeze it (breaking reconcile's baseline/
    // human partition) and rebuilding the entry would drop its findability metadata. Retire it
    // with `remove` first if you genuinely mean to re-approve it on human (7-day) terms.
    if (existing && isBaseline(existing)) {
        console.log(`Pair already baseline-frozen — unchanged: ${symbolA} <> ${symbolB}`);
        return;
    }
    const entry = { symbolA, fileA, symbolB, fileB, description, date: today() };
    const rangeA = strFlag(flags['range-a']);
    const rangeB = strFlag(flags['range-b']);
    const similarity = numFlag(flags.similarity);
    if (rangeA)
        entry.rangeA = rangeA;
    if (rangeB)
        entry.rangeB = rangeB;
    if (similarity !== undefined)
        entry.similarity = similarity;
    if (decayDays !== undefined)
        entry.decayDays = decayDays;
    const next = existing ? pairs.map((p) => (symFileKey(p) === key ? entry : p)) : [...pairs, entry];
    saveAllowlist(path, { pairs: next, clones });
    console.log(`${existing ? 'Updated' : 'Added'} pair: ${symbolA} <> ${symbolB}  (${fileA} / ${fileB})`);
}
function runAddClone({ positionals, flags }) {
    if (positionals.length !== 3)
        usageError('add-clone: expected <hash> <fileA> <fileB>.');
    const description = requireDescription(flags);
    const decayDays = requirePositiveDecay(flags);
    const [fragmentHash] = positionals;
    const path = allowlistPath();
    const { pairs, clones } = loadAllowlist(path, LABEL);
    const entry = {
        fragmentHash,
        fileA: norm(positionals[1]),
        fileB: norm(positionals[2]),
        description,
        date: today(),
    };
    const lines = numFlag(flags.lines);
    const rangeA = strFlag(flags['range-a']);
    const rangeB = strFlag(flags['range-b']);
    if (lines !== undefined)
        entry.lines = lines;
    if (rangeA)
        entry.rangeA = rangeA;
    if (rangeB)
        entry.rangeB = rangeB;
    if (decayDays !== undefined)
        entry.decayDays = decayDays;
    const existing = clones.some((c) => c.fragmentHash === fragmentHash);
    const next = existing
        ? clones.map((c) => (c.fragmentHash === fragmentHash ? entry : c))
        : [...clones, entry];
    saveAllowlist(path, { pairs, clones: next });
    console.log(`${existing ? 'Updated' : 'Added'} clone: ${fragmentHash}  (${entry.fileA} / ${entry.fileB})`);
}
function runRemove({ positionals }) {
    if (positionals.length !== 4)
        usageError('remove: expected <symA> <fileA> <symB> <fileB>.');
    const key = symFileKey({
        symbolA: positionals[0],
        fileA: norm(positionals[1]),
        symbolB: positionals[2],
        fileB: norm(positionals[3]),
    });
    const path = allowlistPath();
    const { pairs, clones } = loadAllowlist(path, LABEL);
    const next = pairs.filter((p) => symFileKey(p) !== key);
    if (next.length === pairs.length) {
        console.log(`${LABEL}: no matching pair (nothing removed).`);
        return;
    }
    saveAllowlist(path, { pairs: next, clones });
    console.log(`Removed pair: ${positionals[0]} <> ${positionals[2]}`);
}
function runRemoveClone({ positionals }) {
    if (positionals.length !== 1)
        usageError('remove-clone: expected <hash>.');
    const [fragmentHash] = positionals;
    const path = allowlistPath();
    const { pairs, clones } = loadAllowlist(path, LABEL);
    const next = clones.filter((c) => c.fragmentHash !== fragmentHash);
    if (next.length === clones.length) {
        console.log(`${LABEL}: no matching clone (nothing removed).`);
        return;
    }
    saveAllowlist(path, { pairs, clones: next });
    console.log(`Removed clone: ${fragmentHash}`);
}
// Coverage pre-check: exit 0 if a LIVE (non-expired) pair covers the argument, 1 if not —
// mirrors the matcher's `scan --new` suppression so "covered here" == "gate won't block".
function runCheck({ positionals }) {
    if (positionals.length !== 4)
        usageError('check: expected <symA> <fileA> <symB> <fileB>.');
    const key = symFileKey({
        symbolA: positionals[0],
        fileA: norm(positionals[1]),
        symbolB: positionals[2],
        fileB: norm(positionals[3]),
    });
    const { pairs } = loadAllowlist(allowlistPath(), LABEL);
    const covered = pairs.some((p) => !isExpired(p) && symFileKey(p) === key);
    console.log(covered ? 'covered (live)' : 'not covered');
    process.exit(covered ? 0 : 1);
}
function runList({ flags }) {
    const path = allowlistPath();
    const { pairs, clones } = loadAllowlist(path, LABEL);
    if (flags.json) {
        process.stdout.write(`${JSON.stringify({ pairs, clones }, null, 2)}\n`);
        return;
    }
    console.log(`${pairs.length} pair(s), ${clones.length} clone(s) — ${path}`);
    const tag = (e) => (isExpired(e) ? 'EXPIRED' : 'live   ');
    for (const p of pairs)
        console.log(`  ${tag(p)}  ${p.symbolA} <> ${p.symbolB}  (${p.fileA} / ${p.fileB})`);
    for (const c of clones)
        console.log(`  ${tag(c)}  clone ${c.fragmentHash}  (${c.fileA ?? '?'} / ${c.fileB ?? '?'})`);
}
// Calendar burn-down: drop entries past date + decayDays from disk. Read-time already
// ignores them (they re-surface as uncovered); prune reclaims the file. Distinct from
// `guard-dup reconcile`, which drops entries a detect() pass no longer produces.
function runPrune() {
    const path = allowlistPath();
    const { pairs, clones } = loadAllowlist(path, LABEL);
    const livePairs = pairs.filter((p) => !isExpired(p));
    const liveClones = clones.filter((c) => !isExpired(c));
    const dropped = pairs.length - livePairs.length + (clones.length - liveClones.length);
    if (dropped === 0) {
        console.log('Nothing expired — allowlist unchanged.');
        return;
    }
    saveAllowlist(path, { pairs: livePairs, clones: liveClones });
    console.log(`Pruned ${dropped} expired entr${dropped === 1 ? 'y' : 'ies'} → ${path}`);
}
function usage() {
    console.log(`guard-dup-allowlist — approve/retire entries in .co-occurrence-allowlist.json

Modes:
  add <symA> <fileA> <symB> <fileB> --description "why" [--similarity N] [--range-a R] [--range-b R] [--decay-days N]
  add-clone <hash> <fileA> <fileB> --description "why" [--lines N] [--range-a R] [--range-b R] [--decay-days N]
  remove <symA> <fileA> <symB> <fileB>
  remove-clone <hash>
  check <symA> <fileA> <symB> <fileB>     exit 0 if a live entry covers it, 1 if not
  list [--json]
  prune                                   drop entries past date + decayDays

Allowlist path: $CO_OCCURRENCE_ALLOWLIST or guard.config.json allowlistPath (default .co-occurrence-allowlist.json).`);
}
// Guard dispatch behind the direct-invocation check (like clone-detector.mts) so importing
// this module — e.g. a test reading MODES from allowlist-io — never runs the CLI.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const argv = process.argv.slice(2);
    const mode = argv[0];
    if (!mode || mode === '--help' || mode === '-h') {
        usage();
        process.exit(0);
    }
    const rest = parseArgs(argv.slice(1));
    switch (mode) {
        case 'add':
            runAdd(rest);
            break;
        case 'add-clone':
            runAddClone(rest);
            break;
        case 'remove':
            runRemove(rest);
            break;
        case 'remove-clone':
            runRemoveClone(rest);
            break;
        case 'check':
            runCheck(rest);
            break;
        case 'list':
            runList(rest);
            break;
        case 'prune':
            runPrune();
            break;
        default:
            console.error(`${LABEL}: unknown mode "${mode}". Use: ${MODES.join(' | ')}`);
            process.exit(1);
    }
}
