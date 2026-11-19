import { AGENT_TARGETS } from '../../components.mts';
import { isTracked } from '../../git-tracked.mts';
import { isSafeAgentAssetPath } from '../agent-asset-manifest/lifecycle.mts';
import { type AgentProvider, requireAgentProviders } from '../agent-assets/agent-providers.mts';
import {
  type HookInstallScope,
  type HookRegistrationOwnershipV1,
  hookRegistrationDestination,
} from './codec.mts';
import {
  adoptExactLegacy,
  type HookRegistrationOptions,
  handlerLocation,
  hookHome,
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

type HookFile = ReturnType<typeof otherScopeFile>;

function unrecognisedAdvisories(provider: AgentProvider, file: HookFile): string[] {
  if (!file) return [];
  return unrecognisedFallowGates(dataRecord(file.document), provider).map(
    (handler) =>
      `${provider}:unrecognised-fallow-gate ${handlerLocation(file.rel, handler)}: ${handler.command}`,
  );
}

/** Doctor rows: `missing` is what `devkit init` repairs, `advisories` what only the user can. */
interface Findings {
  missing: string[];
  advisories: string[];
}

/** devkit's leftovers in the file the other scope writes, sorted by who can remove them. */
function otherScopeFindings(
  root: string,
  provider: AgentProvider,
  scope: HookInstallScope,
  entries: HookRegistrationOwnershipV1[],
): Findings {
  const found: Findings = { missing: [], advisories: [] };
  const elsewhere = otherScopePass(root, provider, scope, entries);
  if (!elsewhere) return found;
  const into = elsewhere.repairable ? found.missing : found.advisories;
  if (elsewhere.retiredFound) into.push(`${provider}:retired-registration:${elsewhere.rel}`);
  if (elsewhere.switched) into.push(`${provider}:scope-switch:${elsewhere.rel}`);
  else if (elsewhere.stranded) found.advisories.push(`${provider}:scope-switch:${elsewhere.rel}`);
  return found;
}

/** devkit's shared spelling left in the shared file of an overlay repo runs beside the anchored one,
 * no longer deduplicated by the harness; an unledgered copy is the user's to delete. */
function unanchoredDuplicates(
  root: string,
  provider: AgentProvider,
  componentIds: string[],
  entries: HookRegistrationOwnershipV1[],
): string[] {
  const file = otherScopeFile(root, provider, 'overlay');
  if (!file || !dataRecord(file.document)) return [];
  const projection = projectHookRegistrations(componentIds, [provider], 'shared', null);
  const ledger = ledgerOf([...projection.entries]);
  // drifted = more than one copy, or a copy under another matcher: each still runs beside the anchor.
  const { present, drifted } = checkProjectedHookRegistrations(
    file.document,
    projection,
    ledger,
    provider,
    'shared',
  );
  return [...present, ...drifted]
    .filter(
      ({ registrationId }) =>
        !entries.some(
          (entry) =>
            entry.provider === provider &&
            entry.destinationRel === file.rel &&
            entry.registrationId === registrationId,
        ),
    )
    .map(
      ({ native }) =>
        `${provider}:unanchored-duplicate ${handlerLocation(file.rel, native)}: ${native.command}`,
    );
}

/** Install never writes a tracked overlay destination, so everything found in it is report-only. */
function trackedAdvisories(root: string, provider: AgentProvider, rel: string): string[] {
  const found = [`${provider}:tracked:${rel}`];
  if (!isSafeAgentAssetPath(root, rel, true)) return found;
  const document = providerDocument(root, provider, rel);
  if (stripReclaimedCommands(document, provider).changed)
    found.push(`${provider}:retired-registration:${rel}`);
  return [...found, ...unrecognisedAdvisories(provider, { rel, document })];
}

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
  const home = hookHome(root);
  const ledger = readHookRegistrationLedger(root);
  const missing: string[] = [];
  const advisories: string[] = [];
  for (const provider of requireAgentProviders(targets)) {
    const rel = hookRegistrationDestination(provider, scope);
    advisories.push(...unrecognisedAdvisories(provider, otherScopeFile(root, provider, scope)));
    if (overlay)
      advisories.push(...unanchoredDuplicates(root, provider, componentIds, ledger?.entries ?? []));
    // Mirrors skipProvider: install never registers into a tracked overlay file, so this can't be fixed.
    if (overlay && isTracked(root, rel)) {
      advisories.push(...trackedAdvisories(root, provider, rel));
      const elsewhere = otherScopeFindings(root, provider, scope, ledger?.entries ?? []);
      missing.push(...elsewhere.missing);
      advisories.push(...elsewhere.advisories);
      continue;
    }
    if (!isSafeAgentAssetPath(root, rel, true)) {
      missing.push(`${provider}:unsafe-config`);
      continue;
    }
    const document = providerDocument(root, provider, rel);
    // Reconcile the ledger, but evaluate the ORIGINAL document below — reporting only the ledger
    // half would hide a settings.json still naming a hook script that does not exist.
    const adopted = adoptExactLegacy(
      ledger?.entries ?? [],
      document,
      legacyOwnedComponentIds,
      provider,
      scope,
      home,
    );
    const legacy = reconcileLegacyHookCommands(adopted, provider, rel, scope, home);
    const retired = stripReclaimedCommands(document, provider).changed;
    if (retired) missing.push(`${provider}:retired-registration`);
    advisories.push(...unrecognisedAdvisories(provider, { rel, document }));
    const elsewhere = otherScopeFindings(root, provider, scope, ledger?.entries ?? []);
    missing.push(...elsewhere.missing);
    advisories.push(...elsewhere.advisories);
    // A prior spelling the ledger already moved past is still in the document after a crashed write.
    const leftover =
      !retired && stripReclaimedCommands(document, provider, legacy.stripped).changed;
    if (legacy.ledgerChanged || leftover) missing.push(`${provider}:superseded-registration`);
    const result = checkProjectedHookRegistrations(
      document,
      projectHookRegistrations(componentIds, [provider], scope, home),
      ledgerOf(legacy.entries),
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
