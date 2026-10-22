import { AGENT_TARGETS } from '../../components.mts';
import { isSafeAgentAssetPath } from '../agent-asset-manifest/lifecycle.mts';
import { requireAgentProviders } from '../agent-assets/agent-providers.mts';
import { type HookInstallScope, hookRegistrationDestination } from './codec.mts';
import {
  adoptExactLegacy,
  type HookRegistrationOptions,
  handlerLocation,
  ledgerOf,
  otherScopeFile,
  otherScopePass,
  providerDocument,
  stripReclaimedCommands,
  unrecognisedFallowGates,
} from './install-support.mts';
import { reconcileLegacyHookCommands } from './legacy-commands.mts';
import {
  checkProjectedHookRegistrations,
  projectHookRegistrations,
  readHookRegistrationLedger,
} from './lifecycle.mts';
import { dataRecord } from './plain-data.mts';

/** Doctor's read-only view of hook registrations. `advisories` are findings devkit must not repair,
 * so they never make `ok` false: an unrecognised fallow-gate.sh spelling is reported, never deleted. */
export function checkHookRegistrations(
  root: string,
  componentIds: string[],
  {
    overlay = false,
    targets = AGENT_TARGETS,
    legacyOwnedComponentIds,
  }: Pick<HookRegistrationOptions, 'overlay' | 'targets' | 'legacyOwnedComponentIds'> = {},
) {
  const scope: HookInstallScope = overlay ? 'overlay' : 'shared';
  const ledger = readHookRegistrationLedger(root);
  const missing: string[] = [];
  const advisories: string[] = [];
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
    const elsewhere = otherScopePass(root, provider, scope, ledger?.entries ?? []);
    if (elsewhere) {
      const into = elsewhere.repairable ? missing : advisories;
      if (elsewhere.retiredFound) into.push(`${provider}:retired-registration:${elsewhere.rel}`);
      if (elsewhere.switched) into.push(`${provider}:scope-switch:${elsewhere.rel}`);
      else if (elsewhere.stranded) advisories.push(`${provider}:scope-switch:${elsewhere.rel}`);
    }
    for (const file of [{ rel, document }, otherScopeFile(root, provider, scope)]) {
      if (!file) continue;
      for (const handler of unrecognisedFallowGates(dataRecord(file.document), provider))
        advisories.push(
          `${provider}:unrecognised-fallow-gate ${handlerLocation(file.rel, handler)}: ${handler.command}`,
        );
    }
    if (legacy.ledgerChanged) missing.push(`${provider}:superseded-registration`);
    const effectiveLedger = legacyOwnedComponentIds?.length
      ? ledgerOf(
          adoptExactLegacy(legacy.entries, document, legacyOwnedComponentIds, provider, scope),
        )
      : ledgerOf(legacy.entries);
    const result = checkProjectedHookRegistrations(
      document,
      projectHookRegistrations(componentIds, [provider], scope),
      effectiveLedger,
      provider,
      scope,
    );
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
