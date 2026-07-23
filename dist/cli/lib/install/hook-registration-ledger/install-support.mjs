import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from "../../atomic-write.mjs";
import { readJson } from "../../fs-helpers.mjs";
import { isTracked } from "../../git-tracked.mjs";
import { isSafeAgentAssetPath } from "../agent-asset-manifest/lifecycle.mjs";
import { LEGACY_AGENT_PROVIDERS } from "../agent-providers.mjs";
import { encodeHookRegistrationLedger, HOOK_REGISTRATION_LEDGER_REL, } from "./codec.mjs";
import { checkProjectedHookRegistrations, projectHookRegistrations, writeHookRegistrationLedger, } from "./lifecycle.mjs";
export const ledgerOf = (entries = []) => ({
    schemaVersion: 1,
    kind: 'agent_hook_registration_ownership',
    entries,
});
export const ownedKey = (entry) => JSON.stringify([entry.provider, entry.destinationRel, entry.registrationId]);
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
