/**
 * `devkit init` flag parsing — the InitFlags shape, the argv parser, and the flags→Selection
 * resolution for the --yes / non-TTY path. Extracted from cli/commands/init.mts (which retains
 * the apply layer); review-policy flags stay in review-profile.mts and compose in here.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_TARGETS, defaultSelection, GUARD_IDS } from '../../components.mjs';
import { readJson } from '../../fs-helpers.mjs';
import { parseReviewFlags } from './review-profile.mjs';
const guardDisableFlag = (guard) => (guard === 'review' ? 'review-gate' : guard);
export function disabledGuardsFromFlags(flags) {
    if (flags.no.has('guards'))
        return [...GUARD_IDS];
    return GUARD_IDS.filter((guard) => (flags.guards !== null && !flags.guards.includes(guard)) ||
        flags.no.has(guardDisableFlag(guard)));
}
export function parseFlags(args) {
    const flags = {
        yes: false,
        dryRun: false,
        force: false,
        stack: null,
        removeDeselected: false,
        fallow: false,
        legacyOxc: false,
        antiSlop: false,
        searchSteering: false,
        agentHooks: false,
        searchCode: false,
        adhd: false,
        priorArtGate: false,
        standalone: false,
        overlay: false,
        baselinesOnly: false,
        no: new Set(),
        guards: null,
        scanRoots: null,
        ...parseReviewFlags(args),
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--yes' || a === '-y')
            flags.yes = true;
        else if (a === '--dry-run')
            flags.dryRun = true;
        else if (a === '--force')
            flags.force = true;
        else if (a === '--remove-deselected')
            flags.removeDeselected = true;
        else if (a === '--fallow')
            flags.fallow = true;
        else if (a === '--oxc')
            flags.legacyOxc = true;
        else if (a === '--anti-slop')
            flags.antiSlop = true;
        else if (a === '--search-steering')
            flags.searchSteering = true;
        else if (a === '--agent-hooks')
            flags.agentHooks = true;
        else if (a === '--search-code')
            flags.searchCode = true;
        else if (a === '--adhd')
            flags.adhd = true;
        else if (a === '--prior-art-gate')
            flags.priorArtGate = true;
        else if (a === '--standalone')
            flags.standalone = true;
        else if (a === '--overlay')
            flags.overlay = true;
        else if (a === '--global-commit-gate')
            flags.globalCommitGate = true;
        else if (a === '--baselines-only')
            flags.baselinesOnly = true;
        else if (a === '--stack')
            flags.stack = args[++i];
        else if (a === '--guards')
            flags.guards = (args[++i] ?? '').split(',').map((g) => g.trim());
        // --scan-root <comma-list>: override guard.config.json scanRoots up front, so the freezes
        // + the react-app structureRoot grandfather a non-standard tree (e.g. services/webapp/src).
        else if (a === '--scan-root' || a === '--scan-roots')
            flags.scanRoots = (args[++i] ?? '')
                .split(',')
                .map((r) => r.trim())
                .filter(Boolean);
        else if (a.startsWith('--no-'))
            flags.no.add(a.slice('--no-'.length));
    }
    return flags;
}
// Build a selection from flags (the --yes / non-TTY path): all recommended, minus --no-*,
// guards narrowed by --guards / --no-guards.
export function selectionFromFlags(flags) {
    const sel = defaultSelection();
    for (const id of ['biome', 'tsconfig', 'skills', 'agents', 'husky', 'structure']) {
        if (flags.no.has(id))
            sel[id] = false;
    }
    if (flags.no.has('guards'))
        sel.guards = [];
    else if (flags.guards)
        sel.guards = flags.guards.filter((g) => GUARD_IDS.includes(g));
    const disabledGuards = disabledGuardsFromFlags(flags);
    sel.guards = sel.guards.filter((guard) => !disabledGuards.includes(guard));
    // Line-growth block is recommended-on; --no-line-growth opts out under --yes / non-TTY.
    if (flags.no.has('line-growth'))
        sel.lineGrowth = false;
    // fallow + the agent-hook components are OPT-IN: off unless their flag is passed (and --no-* keeps off).
    sel.fallow = flags.fallow && !flags.no.has('fallow');
    sel.antiSlop = flags.antiSlop && !flags.no.has('anti-slop');
    if (flags.legacyOxc)
        console.warn('  • --oxc is no longer needed: Oxc is core Devkit tooling');
    if (flags.no.has('oxc'))
        console.warn('  ! --no-oxc is retired and ignored: Oxc is core');
    sel.searchSteering = flags.searchSteering && !flags.no.has('search-steering');
    sel.agentHooks = flags.agentHooks && !flags.no.has('agent-hooks');
    sel.searchCode = flags.searchCode && !flags.no.has('search-code');
    // The vendored i-have-adhd skill: opt-in even under --yes (an output-style preference).
    sel.adhd = flags.adhd && !flags.no.has('adhd');
    // The prior-art gate denies harness tool calls: opt-in even under --yes.
    sel.priorArtGate = flags.priorArtGate && !flags.no.has('prior-art-gate');
    // Fresh defaults minus explicit --no-<provider>; selecting none is allowed.
    sel.agentTargets = AGENT_TARGETS.filter((t) => !flags.no.has(t));
    // The gate's registrations are Claude-only: recording it enabled with no claude surface would
    // install nothing and leave dead config, so deselect it visibly instead.
    if (sel.priorArtGate && !sel.agentTargets.includes('claude')) {
        sel.priorArtGate = false;
        console.warn('  ! prior-art gate skipped: its hooks are Claude-only and the claude surface is deselected');
    }
    return sel;
}
/** Recover managed capabilities published before an interrupted init wrote its component record. */
export function recoverInterruptedCapabilitySelection(cwd, flags, selection) {
    const recorded = readJson(join(cwd, '.devkit', 'config.json'));
    if (recorded?.components)
        return selection;
    if (existsSync(join(cwd, '.devkit', 'anti-slop', 'manifest.json')) &&
        !flags.no.has('anti-slop')) {
        selection.antiSlop = true;
    }
    return selection;
}
