import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../../atomic-write.mts';
import { readJson } from '../../fs-helpers.mts';
import { isTracked } from '../../git-tracked.mts';
import { isSafeAgentAssetPath } from '../agent-asset-manifest/lifecycle.mts';
import { type AgentProvider, LEGACY_AGENT_PROVIDERS } from '../agent-assets/agent-providers.mts';
import { dataRecord } from './plain-data.mts';
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

const RETIRED_COMMANDS: Partial<Record<string, Partial<Record<AgentProvider, readonly string[]>>>> =
  {
    fallow: {
      claude: [
        'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-gate.sh"',
        'FALLOW_GATE_COMMIT_ONLY=1 bash "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-gate.sh"',
      ],
      cursor: ['.cursor/hooks/fallow-gate.sh'],
    },
  };

/** One handler a ledger row proves devkit wrote: its command AND where the row says it sits. */
export interface OwnedHandler {
  event: string;
  matcher: string | null;
  command: string;
}

/** Reclaim what a previous devkit release wrote here. RETIRED_COMMANDS accepts the literal anywhere
 * (a pre-ledger config names no location, sc-1321); `owned` stays inside the event its row names. */
export function stripReclaimedCommands(
  document: unknown,
  provider: AgentProvider,
  owned: readonly OwnedHandler[] = [],
) {
  const commands = new Set(
    Object.values(RETIRED_COMMANDS).flatMap(
      (commandsByProvider) => commandsByProvider?.[provider] ?? [],
    ),
  );
  // The old `provider === 'codex'` clause was unreachable (no codex arm, so `!commands.size` won),
  // and codex DOES need the superseded arm.
  if (!commands.size && !owned.length) return { document, changed: false };
  const root = dataRecord(document);
  const hooks = dataRecord(root?.hooks);
  if (!root || !hooks) return { document, changed: false };
  const nextHooks = { ...hooks };
  let changed = false;
  for (const [event, rawList] of Object.entries(hooks)) {
    if (!Array.isArray(rawList)) continue;
    if (provider === 'cursor') {
      const list = rawList.filter((entry) => {
        const item = dataRecord(entry);
        const command = String(item?.command ?? '');
        // Cursor keeps a FLAT list per event, so the event alone locates a handler.
        return (
          !commands.has(command) &&
          !owned.some((handler) => handler.event === event && handler.command === command)
        );
      });
      if (list.length === rawList.length) continue;
      changed = true;
      if (list.length) nextHooks[event] = list;
      else delete nextHooks[event];
      continue;
    }
    const list: unknown[] = [];
    let eventChanged = false;
    for (const rawGroup of rawList) {
      const group = dataRecord(rawGroup);
      const handlers = Array.isArray(group?.hooks) ? group.hooks : null;
      if (!group || !handlers) {
        list.push(rawGroup);
        continue;
      }
      const kept = handlers.filter((entry) => {
        const command = String(dataRecord(entry)?.command ?? '');
        return (
          !commands.has(command) &&
          !owned.some(
            (handler) =>
              handler.event === event &&
              handler.command === command &&
              // Mirrors lifecycle.mts matcherGroup: null means the group carries no `matcher` key.
              (handler.matcher === null
                ? !Object.hasOwn(group, 'matcher')
                : group.matcher === handler.matcher),
          )
        );
      });
      if (kept.length === handlers.length) {
        list.push(rawGroup);
        continue;
      }
      eventChanged = true;
      const onlyScaffold = Object.keys(group).every((key) => key === 'matcher' || key === 'hooks');
      if (kept.length || !onlyScaffold) list.push({ ...group, hooks: kept });
    }
    if (!eventChanged) continue;
    changed = true;
    if (list.length) nextHooks[event] = list;
    else delete nextHooks[event];
  }
  return changed ? { document: { ...root, hooks: nextHooks }, changed } : { document, changed };
}

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
