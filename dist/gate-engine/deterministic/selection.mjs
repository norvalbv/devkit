/** Which deterministic gates a run executes: the repo's selection, review's allowlist and `--only`. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseJsonObject } from '../config-json.mjs';
import { DETERMINISTIC } from './registry.mjs';
/** `components.<name> === true`, guarded so an inherited Object.prototype member never counts. */
function componentEnabled(components, name) {
    return components !== undefined && Object.hasOwn(components, name) && components[name] === true;
}
const ALL_IDS = DETERMINISTIC.map((g) => g.id);
const GUARD_COMPONENTS = DETERMINISTIC.filter((g) => !('configComponent' in g));
// A selected guard arms a gate by its own id, or one that rides it (decisions → decision-checks).
const armed = (gate, guards) => guards.has(gate.id) || (!!gate.withGuard && guards.has(gate.withGuard));
// The set the missing/unreadable-config fallback runs: every guard EXCEPT the opt-in ones. `--only`
// and an explicit components.guards selection can still run opt-in guards (they're in ALL_IDS).
const DEFAULT_IDS = DETERMINISTIC.filter((g) => !('optIn' in g && g.optIn)).map((g) => g.id);
export function canonicalIds(ids) {
    const selected = new Set(ids);
    return ALL_IDS.filter((id) => selected.has(id));
}
export function reviewIds() {
    const configured = (process.env.DEVKIT_REVIEW_GUARDS ?? '')
        .split(',')
        .map((guard) => guard.trim())
        .filter(Boolean);
    const selected = new Set(configured);
    return GUARD_COMPONENTS.filter((g) => armed(g, selected)).map((g) => g.id);
}
// The guards .devkit/config.json selects. A missing or unreadable config runs DEFAULT_IDS, so no
// expected gate is skipped and no opt-in gate wedges a repo that never asked for it.
export function selectedIds(cwd) {
    if (process.env.DEVKIT_RUN_MODE === 'review')
        return reviewIds();
    const cfgPath = path.join(cwd, '.devkit', 'config.json');
    if (!existsSync(cfgPath))
        return DEFAULT_IDS;
    try {
        const parsed = parseJsonObject(readFileSync(cfgPath, 'utf8'), cfgPath);
        // Own properties only, at every layer: a polluted Object.prototype must never opt a gate in or out.
        const components = Object.hasOwn(parsed, 'components') ? parsed.components : undefined;
        const guards = components !== undefined &&
            Object.hasOwn(components, 'guards') &&
            Array.isArray(components.guards)
            ? components.guards
            : DEFAULT_IDS;
        const selectedGuards = new Set(guards);
        return DETERMINISTIC.filter((gate) => {
            const component = 'configComponent' in gate ? gate.configComponent : undefined;
            return component ? componentEnabled(components, component) : armed(gate, selectedGuards);
        }).map((gate) => gate.id);
    }
    catch {
        return DEFAULT_IDS;
    }
}
// `--only` narrows a run and never grants authority: an unknown id or an empty list refuses the run.
function refuseUnknownOnly(only) {
    const unknown = only.filter((id) => !ALL_IDS.includes(id));
    if (!unknown.length && only.length > 0)
        return false;
    const why = unknown.length ? `unknown gate id(s): ${unknown.join(', ')}` : 'empty selection';
    console.error(`✗ guard-deterministic --only: ${why} (known: ${ALL_IDS.join(', ')}) — refusing to run.`);
    return true;
}
// Under review, `--only` is intersected with the positive allowlist so a hook cannot re-enable a guard.
function refuseReviewOnly(only, allowed) {
    const allowlist = new Set(allowed);
    const disallowed = only.filter((id) => !allowlist.has(id));
    if (disallowed.length === 0)
        return false;
    console.error(`✗ guard-deterministic --only: gate id(s) not enabled for review: ${[...new Set(disallowed)].join(', ')} — refusing to run.`);
    return true;
}
/** The gate ids this run executes, or null after printing why `--only` refused the run. */
export function resolveSelection(cwd, only) {
    if (only && refuseUnknownOnly(only))
        return null;
    const reviewMode = process.env.DEVKIT_RUN_MODE === 'review';
    const allowed = reviewMode ? reviewIds() : selectedIds(cwd);
    if (reviewMode && only && refuseReviewOnly(only, allowed))
        return null;
    return { reviewMode, effectiveIds: canonicalIds(only ?? allowed) };
}
