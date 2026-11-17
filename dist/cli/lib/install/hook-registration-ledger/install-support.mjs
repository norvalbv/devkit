import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../../atomic-write.mjs';
import { readJson } from '../../fs-helpers.mjs';
import { isTracked } from '../../git-tracked.mjs';
import { isSafeAgentAssetPath } from '../agent-asset-manifest/lifecycle.mjs';
import { LEGACY_AGENT_PROVIDERS, SUPPORTED_AGENT_PROVIDERS, } from '../agent-assets/agent-providers.mjs';
import { dataRecord } from './plain-data.mjs';
import { encodeHookRegistrationLedger, HOOK_REGISTRATION_LEDGER_REL, hookRegistrationDestination, } from './codec.mjs';
import { checkProjectedHookRegistrations, projectHookRegistrations, writeHookRegistrationLedger, } from './lifecycle.mjs';
export const ledgerOf = (entries = []) => ({
    schemaVersion: 1,
    kind: 'agent_hook_registration_ownership',
    entries,
});
export const ownedKey = (entry) => JSON.stringify([entry.provider, entry.destinationRel, entry.registrationId]);
// Exact spellings only: devkit's one env prefix, optional bash/sh, then the script bare, as `./`, or
// under a double-quoted CLAUDE_PROJECT_DIR. Anything else (BASH_ENV=, PATH=) may run consumer code.
const retiredFallowGate = (dir) => {
    const script = String.raw `\.${dir}/hooks/fallow-gate\.sh`;
    const projectDir = String.raw `(?:\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\})`;
    const path = String.raw `(?:(?:\./)?${script}|"${projectDir}/${script}"|"${projectDir}"/${script})`;
    return new RegExp(String.raw `^(?:FALLOW_GATE_COMMIT_ONLY=1 )?(?:(?:ba)?sh )?${path}$`);
};
const RETIRED_SCRIPT = new Map([
    ['claude', retiredFallowGate('claude')],
    ['cursor', retiredFallowGate('cursor')],
]);
const isRetired = (provider, command) => RETIRED_SCRIPT.get(provider)?.test(command) ?? false;
// Any spelling that names the provider's fallow-gate.sh. Doctor only reports these, never strips them.
const FALLOW_GATE_PATH = new Map(SUPPORTED_AGENT_PROVIDERS.map((provider) => [
    provider,
    new RegExp(String.raw `(?:^|[\s"'/=])\.${provider}/hooks/fallow-gate\.sh(?![\w.-])`),
]));
const commandOf = (entry) => String(entry?.command ?? '');
// Mirrors lifecycle.mts matcherGroup: null means the group carries no `matcher` key.
const matcherOf = (group) => Object.hasOwn(group, 'matcher') ? String(group.matcher) : null;
function entryHandlers(event, entry, flat) {
    if (flat)
        return [{ event, matcher: null, command: commandOf(entry) }];
    if (!entry || !Array.isArray(entry.hooks))
        return [];
    const matcher = matcherOf(entry);
    return entry.hooks.map((handler) => ({
        event,
        matcher,
        command: commandOf(dataRecord(handler)),
    }));
}
/** Every handler in a provider hook document, read-only. Cursor keeps a flat list per event. */
function handlersOf(document, provider) {
    return Object.entries(dataRecord(document?.hooks) ?? {}).flatMap(([event, list]) => (Array.isArray(list) ? list : []).flatMap((entry) => entryHandlers(event, dataRecord(entry), provider === 'cursor')));
}
/** Handlers naming fallow's agent gate in a spelling `isRetired` will not delete. */
export const unrecognisedFallowGates = (document, provider) => handlersOf(document, provider).filter(({ command }) => (FALLOW_GATE_PATH.get(provider)?.test(command) ?? false) && !isRetired(provider, command));
export const handlerLocation = (rel, { event, matcher }) => `${rel} ${event}${matcher ? `[${matcher}]` : ''}`;
function reclaimReason(provider, owned, event, command, sitsHere) {
    if (isRetired(provider, command))
        return 'retired';
    const ownedHere = owned.some((h) => h.event === event && h.command === command && sitsHere(h));
    return ownedHere ? 'superseded' : null;
}
/** Reclaim fallow's agent gate anywhere, whoever wrote it (devkit's staged wrapper replaces it),
 * plus what a previous devkit release wrote; `owned` stays inside the event its row names. */
export function stripReclaimedCommands(document, provider, owned = []) {
    const dropped = [];
    if (!RETIRED_SCRIPT.has(provider) && !owned.length)
        return { document, changed: false, dropped };
    const root = dataRecord(document);
    const hooks = dataRecord(root?.hooks);
    if (!root || !hooks)
        return { document, changed: false, dropped };
    const nextHooks = { ...hooks };
    let changed = false;
    for (const [event, rawList] of Object.entries(hooks)) {
        if (!Array.isArray(rawList))
            continue;
        if (provider === 'cursor') {
            const list = rawList.filter((entry) => {
                const command = String(dataRecord(entry)?.command ?? '');
                // Cursor keeps a FLAT list per event, so the event alone locates a handler.
                const reason = reclaimReason(provider, owned, event, command, () => true);
                if (reason)
                    dropped.push({ event, matcher: null, command, reason });
                return !reason;
            });
            if (list.length === rawList.length)
                continue;
            changed = true;
            if (list.length)
                nextHooks[event] = list;
            else
                delete nextHooks[event];
            continue;
        }
        const list = [];
        let eventChanged = false;
        for (const rawGroup of rawList) {
            const group = dataRecord(rawGroup);
            const handlers = Array.isArray(group?.hooks) ? group.hooks : null;
            if (!group || !handlers) {
                list.push(rawGroup);
                continue;
            }
            // Mirrors lifecycle.mts matcherGroup: null means the group carries no `matcher` key.
            const matcher = Object.hasOwn(group, 'matcher') ? String(group.matcher) : null;
            const kept = handlers.filter((entry) => {
                const command = String(dataRecord(entry)?.command ?? '');
                const reason = reclaimReason(provider, owned, event, command, (handler) => handler.matcher === null ? matcher === null : group.matcher === handler.matcher);
                if (reason)
                    dropped.push({ event, matcher, command, reason });
                return !reason;
            });
            if (kept.length === handlers.length) {
                list.push(rawGroup);
                continue;
            }
            eventChanged = true;
            const onlyScaffold = Object.keys(group).every((key) => key === 'matcher' || key === 'hooks');
            if (kept.length || !onlyScaffold)
                list.push({ ...group, hooks: kept });
        }
        if (!eventChanged)
            continue;
        changed = true;
        if (list.length)
            nextHooks[event] = list;
        else
            delete nextHooks[event];
    }
    const next = changed ? { ...root, hooks: nextHooks } : document;
    return { document: next, changed, dropped };
}
/** One line per removed handler, so a settings diff never reads as consumer data loss. */
export function reportDropped(rel, dropped, dryRun) {
    for (const handler of dropped) {
        const { command, reason } = handler;
        const where = handlerLocation(rel, handler);
        console.log(`  ${dryRun ? '[dry-run] remove' : '✓ removed'} ${where}: ${command} (${reason})`);
    }
}
export const asDropped = (entries, verb) => entries.map(({ native, ownerId }) => ({ ...native, reason: `${verb}: ${ownerId}` }));
const OTHER_SCOPE = { shared: 'overlay', overlay: 'shared' };
/** The Claude settings file the scope does NOT own; Claude Code runs both. */
export function otherClaudeSettings(root, provider, scope) {
    if (provider !== 'claude')
        return null;
    const rel = hookRegistrationDestination(provider, OTHER_SCOPE[scope]);
    // A missing file reads as `{}`, so only a symlinked or non-file path needs refusing here.
    if (!isSafeAgentAssetPath(root, rel, true))
        return null;
    try {
        return { rel, document: providerDocument(root, provider, rel) };
    }
    catch {
        return null; // Not the scope's file: its parse errors are the user's, never a devkit failure.
    }
}
/** A retired command in the Claude settings file the scope does NOT own. */
export function retiredElsewhere(root, provider, scope, other = otherClaudeSettings(root, provider, scope)) {
    if (!other)
        return null;
    const { rel, document } = other;
    const stripped = stripReclaimedCommands(document, provider);
    if (!stripped.changed)
        return null;
    // Overlay must stay git-invisible, so a committed settings.json is reported, never edited.
    const repairable = scope === 'shared' || !isTracked(root, rel);
    return { rel, document: stripped.document, dropped: stripped.dropped, repairable };
}
export function reclaimRetiredElsewhere(root, provider, scope, dryRun) {
    const elsewhere = retiredElsewhere(root, provider, scope);
    if (!elsewhere?.repairable)
        return;
    if (!dryRun)
        writeProvider(root, { provider, ...elsewhere, changed: true });
    reportDropped(elsewhere.rel, elsewhere.dropped, dryRun);
}
export function providerDocument(root, provider, rel) {
    const path = join(root, rel);
    if (!existsSync(path))
        return provider === 'cursor' ? { version: 1 } : {};
    const document = readJson(path);
    if (document === null)
        throw new Error(`${rel} must contain a provider hook object`);
    return document;
}
export function adopt(entries, candidates) {
    const keys = new Set(entries.map(ownedKey));
    return [...entries, ...candidates.filter((candidate) => !keys.has(ownedKey(candidate)))];
}
export function release(entries, removed) {
    const keys = new Set(removed.map(ownedKey));
    return entries.filter((entry) => !keys.has(ownedKey(entry)));
}
export function adoptExactLegacy(entries, document, componentIds, provider, scope) {
    if (!componentIds || !LEGACY_AGENT_PROVIDERS.includes(provider))
        return entries;
    const projection = projectHookRegistrations(componentIds, [provider], scope);
    const exact = checkProjectedHookRegistrations(document, projection, ledgerOf([...projection.entries]), provider, scope);
    return adopt(entries, exact.present);
}
export function skipProvider(root, provider, rel, overlay) {
    if (overlay && provider !== 'claude' && isTracked(root, rel)) {
        console.log(`  ! ${rel} is git-tracked — skipping (can't hide a tracked edit)`);
        return true;
    }
    if (!isSafeAgentAssetPath(root, rel, true)) {
        console.log(`  ! ${rel} is unsafe — preserving it and its ownership state`);
        return true;
    }
    return false;
}
function writeProvider(root, plan) {
    if (!isSafeAgentAssetPath(root, plan.rel, true))
        throw new Error(`refusing unsafe hook destination: ${plan.rel}`);
    const path = join(root, plan.rel);
    mkdirSync(dirname(path), { recursive: true });
    if (!isSafeAgentAssetPath(root, plan.rel, true))
        throw new Error(`refusing unsafe hook destination: ${plan.rel}`);
    writeFileAtomic(path, `${JSON.stringify(plan.document, null, 2)}\n`);
}
function noteCodex(plan, dryRun) {
    if (plan.provider === 'codex' && plan.changed)
        console.log(`  ! ${dryRun ? '[dry-run] ' : ''}.codex/hooks.json changed — review and trust it with /hooks before Codex runs it`);
}
function publishLedger(root, next, previous) {
    if (encodeHookRegistrationLedger(next) === encodeHookRegistrationLedger(previous))
        return;
    if (!next.entries.length)
        rmSync(join(root, HOOK_REGISTRATION_LEDGER_REL), { force: true });
    else
        writeHookRegistrationLedger(root, next);
}
export function publishPlan(root, plan, entries, previous, dryRun) {
    const next = ledgerOf(entries);
    if (!dryRun) {
        const intermediate = plan.changed ? ledgerOf(adopt([...next.entries], previous.entries)) : next;
        publishLedger(root, intermediate, previous);
        if (plan.changed)
            writeProvider(root, plan);
        publishLedger(root, next, intermediate);
    }
    noteCodex(plan, dryRun);
    return next;
}
