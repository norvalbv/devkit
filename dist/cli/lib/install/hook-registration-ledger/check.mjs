import { AGENT_TARGETS } from '../../components.mjs';
import { isSafeAgentAssetPath } from '../agent-asset-manifest/lifecycle.mjs';
import { requireAgentProviders } from '../agent-assets/agent-providers.mjs';
import { hookRegistrationDestination } from './codec.mjs';
import { adoptExactLegacy, ledgerOf, providerDocument, retiredElsewhere, stripReclaimedCommands, } from './install-support.mjs';
import { reconcileLegacyHookCommands } from './legacy-commands.mjs';
import { checkProjectedHookRegistrations, projectHookRegistrations, readHookRegistrationLedger, } from './lifecycle.mjs';
/** Doctor's read-only view of hook registrations. `advisories` are findings devkit must not repair. */
export function checkHookRegistrations(root, componentIds, { overlay = false, targets = AGENT_TARGETS, legacyOwnedComponentIds, } = {}) {
    const scope = overlay ? 'overlay' : 'shared';
    const ledger = readHookRegistrationLedger(root);
    const missing = [];
    const advisories = [];
    for (const provider of requireAgentProviders(targets)) {
        const rel = hookRegistrationDestination(provider, scope);
        if (!isSafeAgentAssetPath(root, rel, true)) {
            missing.push(`${provider}:unsafe-config`);
            continue;
        }
        const document = providerDocument(root, provider, rel);
        // Reconcile the ledger, but evaluate the ORIGINAL document below — reporting only the ledger
        // half would hide a settings.json still naming a hook script that does not exist.
        const legacy = reconcileLegacyHookCommands(ledger?.entries ?? [], provider, rel);
        if (stripReclaimedCommands(document, provider).changed)
            missing.push(`${provider}:retired-registration`);
        const elsewhere = retiredElsewhere(root, provider, scope);
        if (elsewhere)
            (elsewhere.repairable ? missing : advisories).push(`${provider}:retired-registration:${elsewhere.rel}`);
        if (legacy.ledgerChanged)
            missing.push(`${provider}:superseded-registration`);
        const effectiveLedger = legacyOwnedComponentIds?.length
            ? ledgerOf(adoptExactLegacy(legacy.entries, document, legacyOwnedComponentIds, provider, scope))
            : ledgerOf(legacy.entries);
        const result = checkProjectedHookRegistrations(document, projectHookRegistrations(componentIds, [provider], scope), effectiveLedger, provider, scope);
        for (const [reason, candidates] of Object.entries({
            missing: result.missing,
            drifted: result.drifted,
            collision: result.collisions,
            blocked: result.blocked,
            'untrusted-ledger': result.untrustedLedgerEntries,
        }))
            for (const candidate of candidates)
                missing.push(`${provider}:${candidate.registrationId}:${reason}`);
    }
    return { ok: missing.length === 0, missing, advisories };
}
