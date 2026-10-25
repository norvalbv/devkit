/**
 * Repo-supplied command gates: the hook's `--structure` / `--extra` flags and guard.config.json
 * `extraGates`. guard-deterministic runs each one beside the built-in gates; non-zero blocks.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CONFIG_FILENAME, envFlag, resolveGuardConfig } from '../config.mjs';
import { emitGateBypass } from '../judge/gate-events.mjs';
import { gitPrefix, stagedSet } from '../ratchets/git-index.mjs';
import { recheckCommand } from './recheck.mjs';
import { DETERMINISTIC } from './registry.mjs';
// In dev the tree is .mts; in the shipped dist it is .mjs, so derive the extension from THIS module.
const STRUCTURE_RUN = fileURLToPath(new URL(`../structure/run${import.meta.url.endsWith('.mts') ? '.mts' : '.mjs'}`, import.meta.url));
const WHITESPACE_RE = /\s+/;
const LEADING_DASH_RE = /^-/;
/** The argv token devkit replaces with the commit's staged paths, relative to the gate's cwd. */
export const STAGED_PLACEHOLDER = '{staged}';
// macOS ARG_MAX is 1 MiB shared with the environment; past this a spawn fails with E2BIG.
const MAX_STAGED_BYTES = 256 * 1024;
// Strips a built-in gate's `guard-` bin prefix to its bare telemetry name.
export const GUARD_PREFIX_RE = /^guard-/;
// Built-in names would merge telemetry with that gate and print its remedies for this one.
const RESERVED = new Set(['structure-lint', ...DETERMINISTIC.map((g) => g.id)]);
const labelSchema = z
    .string()
    .regex(/^[a-z0-9][\w.-]*$/i)
    .refine((l) => !RESERVED.has(l) && !l.startsWith('guard-'), 'is a built-in gate name');
const extraGatesSchema = z.record(labelSchema, z.string().trim().min(1)).optional();
/**
 * The gates guard.config.json `extraGates` declares (label → command), in declaration order. A
 * malformed block becomes one command-less spec, so a gate the repo meant to run never vanishes.
 */
export function configExtraGates(cwd) {
    let raw;
    try {
        raw = resolveGuardConfig(cwd).extraGates;
    }
    catch (e) {
        console.error(`✗ ${CONFIG_FILENAME}: ${e instanceof Error ? e.message : String(e)}`);
        return [{ label: `${CONFIG_FILENAME}(unreadable)` }];
    }
    // zod's record drops a `__proto__` key without an issue, so that gate would silently vanish.
    if (Object.hasOwn(Object(raw), '__proto__')) {
        console.error(`✗ ${CONFIG_FILENAME} extraGates.__proto__: is not a valid gate name`);
        return [{ label: 'extraGates' }];
    }
    const parsed = extraGatesSchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const at = issue.path.length ? `.${issue.path.join('.')}` : '';
        console.error(`✗ ${CONFIG_FILENAME} extraGates${at}: ${issue.message}`);
        return [{ label: 'extraGates' }];
    }
    return Object.entries(parsed.data ?? {}).map(([label, cmd]) => ({ label, cmd }));
}
/**
 * Is structure lint bypassed for THIS run? The orchestrator owns this predicate rather than
 * guard-structure because Electron consumers supply their own arbitrary eslint command through
 * `--structure`; putting the bypass inside guard-structure would leave those consumers wedged.
 *
 * `GUARD_STRUCTURE_OK` is the canonical operator assertion. `GUARD_NO_STRUCTURE` is the accepted
 * guessable alias, matching coverageBypassed. guard-deterministic banners + telemeters the skip and
 * salts its prefix-cache scope so this one-run assertion cannot authorise a later normal run.
 */
export function structureBypassed() {
    return envFlag('STRUCTURE_OK') || envFlag('NO_STRUCTURE');
}
// Gate label or id → the bypass flag that gate reads in its own process. A bypassed run must not
// record a prefix key a later clean run of the same tree would hit, so run.mts salts on these.
export const GATE_BYPASSES = {
    'hook-parity': 'HOOK_PARITY_OK',
    'decisions-integrity': 'DECISIONS_INTEGRITY_OK',
    'decision-checks': 'DECISION_CHECKS_OK',
};
/** The bypass suffixes set for this run, sorted so the prefix-cache salt ignores export order. */
export function bypassedSuffixes() {
    return Object.values(GATE_BYPASSES).filter(envFlag).sort();
}
/**
 * A cache hit runs no gate, so a gate's own bypass emission never fires: emit it here for each
 * bypassed gate in `ran`. Returns every bypassed flag under its canonical name, for the banner.
 */
export function reportCachedBypasses(ran) {
    const bypassed = Object.entries(GATE_BYPASSES).filter(([, suffix]) => envFlag(suffix));
    for (const [gate, suffix] of bypassed) {
        if (ran.includes(gate))
            emitGateBypass(gate, `GUARD_${suffix}`);
    }
    return bypassed.map(([, suffix]) => `GUARD_${suffix}`);
}
/** `tokens` with `{staged}` spread into the staged paths, made relative to the `prefix` dir. */
export function expandStaged(tokens, staged, prefix) {
    const marked = tokens.filter((t) => t.includes(STAGED_PLACEHOLDER));
    if (!marked.length)
        return { argv: tokens };
    if (marked.length > 1 || marked[0] !== STAGED_PLACEHOLDER) {
        return { unrunnable: `${STAGED_PLACEHOLDER} must be one whole argument` };
    }
    if (!staged)
        return { unrunnable: 'staged set unreadable' };
    if (!staged.size)
        return { empty: true };
    // A sibling package's path stays `../x`: a test here may import it. `./` keeps `-x` a path.
    const paths = [...staged]
        .sort()
        .map((p) => path.posix.relative(prefix, p).replace(LEADING_DASH_RE, './-'));
    const bytes = paths.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0);
    if (bytes > MAX_STAGED_BYTES) {
        return { unrunnable: `staged set too large for argv (${paths.length} paths)` };
    }
    const at = tokens.indexOf(STAGED_PLACEHOLDER);
    return { argv: [...tokens.slice(0, at), ...paths, ...tokens.slice(at + 1)] };
}
/**
 * A `--structure` / `--extra` / extraGates command → a gate. `guard-structure …` runs the sibling
 * module and keeps its exit-2 opt-out; any other command spawns via PATH and blocks on non-zero.
 */
export function commandGate(label, cwd, cmd) {
    const tokens = (cmd ?? '').split(WHITESPACE_RE).filter(Boolean);
    if (!tokens.length)
        return { label, argv: null, failOpen2: false };
    const usesStaged = tokens.some((t) => t.includes(STAGED_PLACEHOLDER));
    const staged = usesStaged ? stagedSet(cwd) : null;
    const x = expandStaged(tokens, staged, staged ? gitPrefix(cwd) : '');
    if ('empty' in x)
        return { label, argv: null, failOpen2: false, notRun: 'no staged paths, not run' };
    if ('unrunnable' in x)
        return { label, argv: null, failOpen2: false, unrunnable: x.unrunnable };
    const structure = x.argv[0] === 'guard-structure';
    const argv = structure ? ['node', STRUCTURE_RUN, ...x.argv.slice(1)] : x.argv;
    // The tokens that RUN, quoted. An expanded path list would go stale once the fix is staged.
    const recheck = usesStaged ? undefined : recheckCommand(argv, structure ? cwd : undefined);
    return { label, argv, failOpen2: structure, recheck };
}
