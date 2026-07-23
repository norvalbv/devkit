import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../../atomic-write.mts';
import { readJson } from '../../fs-helpers.mts';
import { isTracked } from '../../git-tracked.mts';
import { isSafeAgentAssetPath } from '../agent-asset-manifest/lifecycle.mts';
import { type AgentProvider, LEGACY_AGENT_PROVIDERS } from '../agent-providers.mts';
import {
  encodeHookRegistrationLedger,
  HOOK_REGISTRATION_LEDGER_REL,
  type HookInstallScope,
  type HookRegistrationLedgerV1,
  type HookRegistrationOwnershipV1,
} from './codec.mts';
import {
  checkProjectedHookRegistrations,
  projectHookRegistrations,
  writeHookRegistrationLedger,
} from './lifecycle.mts';

export interface HookRegistrationOptions {
  dryRun?: boolean;
  targets?: string[];
  overlay?: boolean;
  legacyOwnedComponentIds?: string[];
}

export interface ProviderPlan {
  provider: AgentProvider;
  rel: string;
  document: unknown;
  changed: boolean;
  report?: boolean;
}

export const ledgerOf = (
  entries: HookRegistrationOwnershipV1[] = [],
): HookRegistrationLedgerV1 => ({
  schemaVersion: 1,
  kind: 'agent_hook_registration_ownership',
  entries,
});

export const ownedKey = (entry: HookRegistrationOwnershipV1) =>
  JSON.stringify([entry.provider, entry.destinationRel, entry.registrationId]);

export function providerDocument(root: string, provider: AgentProvider, rel: string): unknown {
  const path = join(root, rel);
  if (!existsSync(path)) return provider === 'cursor' ? { version: 1 } : {};
  const document = readJson(path);
  if (document === null) throw new Error(`${rel} must contain a provider hook object`);
  return document;
}

export function adopt(
  entries: HookRegistrationOwnershipV1[],
  candidates: readonly HookRegistrationOwnershipV1[],
) {
  const keys = new Set(entries.map(ownedKey));
  return [...entries, ...candidates.filter((candidate) => !keys.has(ownedKey(candidate)))];
}

export function release(
  entries: HookRegistrationOwnershipV1[],
  removed: readonly HookRegistrationOwnershipV1[],
) {
  const keys = new Set(removed.map(ownedKey));
  return entries.filter((entry) => !keys.has(ownedKey(entry)));
}

export function adoptExactLegacy(
  entries: HookRegistrationOwnershipV1[],
  document: unknown,
  componentIds: string[] | undefined,
  provider: AgentProvider,
  scope: HookInstallScope,
) {
  if (!componentIds || !LEGACY_AGENT_PROVIDERS.includes(provider as never)) return entries;
  const projection = projectHookRegistrations(componentIds, [provider], scope);
  const exact = checkProjectedHookRegistrations(
    document,
    projection,
    ledgerOf([...projection.entries]),
    provider,
    scope,
  );
  return adopt(entries, exact.present);
}

export function skipProvider(root: string, provider: AgentProvider, rel: string, overlay: boolean) {
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

function writeProvider(root: string, plan: ProviderPlan) {
  if (!isSafeAgentAssetPath(root, plan.rel, true))
    throw new Error(`refusing unsafe hook destination: ${plan.rel}`);
  const path = join(root, plan.rel);
  mkdirSync(dirname(path), { recursive: true });
  if (!isSafeAgentAssetPath(root, plan.rel, true))
    throw new Error(`refusing unsafe hook destination: ${plan.rel}`);
  writeFileAtomic(path, `${JSON.stringify(plan.document, null, 2)}\n`);
}

function noteCodex(plan: ProviderPlan, dryRun: boolean) {
  if (plan.provider === 'codex' && plan.changed)
    console.log(
      `  ! ${dryRun ? '[dry-run] ' : ''}.codex/hooks.json changed — review and trust it with /hooks before Codex runs it`,
    );
}

function publishLedger(
  root: string,
  next: HookRegistrationLedgerV1,
  previous: HookRegistrationLedgerV1,
) {
  if (encodeHookRegistrationLedger(next) === encodeHookRegistrationLedger(previous)) return;
  if (!next.entries.length) rmSync(join(root, HOOK_REGISTRATION_LEDGER_REL), { force: true });
  else writeHookRegistrationLedger(root, next);
}

export function publishPlan(
  root: string,
  plan: ProviderPlan,
  entries: HookRegistrationOwnershipV1[],
  previous: HookRegistrationLedgerV1,
  dryRun: boolean,
): HookRegistrationLedgerV1 {
  const next = ledgerOf(entries);
  if (!dryRun) {
    const intermediate = plan.changed ? ledgerOf(adopt([...next.entries], previous.entries)) : next;
    publishLedger(root, intermediate, previous);
    if (plan.changed) writeProvider(root, plan);
    publishLedger(root, next, intermediate);
  }
  noteCodex(plan, dryRun);
  return next;
}
