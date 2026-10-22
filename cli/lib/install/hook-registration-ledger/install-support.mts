import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../../atomic-write.mts';
import { readJson } from '../../fs-helpers.mts';
import { isTracked } from '../../git-tracked.mts';
import { isSafeAgentAssetPath } from '../agent-asset-manifest/lifecycle.mts';
import {
  type AgentProvider,
  LEGACY_AGENT_PROVIDERS,
  SUPPORTED_AGENT_PROVIDERS,
} from '../agent-assets/agent-providers.mts';
import { dataRecord } from './plain-data.mts';
import {
  encodeHookRegistrationLedger,
  HOOK_REGISTRATION_LEDGER_REL,
  type HookInstallScope,
  type HookRegistrationLedgerV1,
  type HookRegistrationOwnershipV1,
  hookRegistrationDestination,
} from './codec.mts';
import { reconcileLegacyHookCommands } from './legacy-commands.mts';
import {
  checkProjectedHookRegistrations,
  projectHookRegistrations,
  removeLedgerAuthorizedHookRegistrations,
  transferHookRegistrationScope,
  writeHookRegistrationLedger,
} from './lifecycle.mts';
import { HOOK_REGISTRATIONS } from './registrations.mts';

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

// Exact spellings only: devkit's one env prefix, optional bash/sh, then the script bare, as `./`, or
// under a double-quoted CLAUDE_PROJECT_DIR. Anything else (BASH_ENV=, PATH=) may run consumer code.
const retiredFallowGate = (dir: string) => {
  const script = String.raw`\.${dir}/hooks/fallow-gate\.sh`;
  const projectDir = String.raw`(?:\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\})`;
  const path = String.raw`(?:(?:\./)?${script}|"${projectDir}/${script}"|"${projectDir}"/${script})`;
  return new RegExp(String.raw`^(?:FALLOW_GATE_COMMIT_ONLY=1 )?(?:(?:ba)?sh )?${path}$`);
};
const RETIRED_SCRIPT = new Map<AgentProvider, RegExp>([
  ['claude', retiredFallowGate('claude')],
  ['cursor', retiredFallowGate('cursor')],
]);
const isRetired = (provider: AgentProvider, command: string) =>
  RETIRED_SCRIPT.get(provider)?.test(command) ?? false;

// Any spelling that names the provider's fallow-gate.sh. Doctor only reports these, never strips them.
const FALLOW_GATE_PATH = new Map<AgentProvider, RegExp>(
  SUPPORTED_AGENT_PROVIDERS.map((provider) => [
    provider,
    new RegExp(String.raw`(?:^|[\s"'/=])\.${provider}/hooks/fallow-gate\.sh(?![\w.-])`),
  ]),
);

/** One handler a ledger row proves devkit wrote: its command AND where the row says it sits. */
export interface OwnedHandler {
  event: string;
  matcher: string | null;
  command: string;
}

/** One entry of a provider hook list: a Cursor handler, or a Claude/Codex matcher group. */
interface HookEntry {
  command?: unknown;
  matcher?: unknown;
  hooks?: unknown;
}

const commandOf = (entry: HookEntry | null) => String(entry?.command ?? '');

// Mirrors lifecycle.mts matcherGroup: null means the group carries no `matcher` key.
const matcherOf = (group: HookEntry) =>
  Object.hasOwn(group, 'matcher') ? String(group.matcher) : null;

function entryHandlers(event: string, entry: HookEntry | null, flat: boolean): OwnedHandler[] {
  if (flat) return [{ event, matcher: null, command: commandOf(entry) }];
  if (!entry || !Array.isArray(entry.hooks)) return [];
  const matcher = matcherOf(entry);
  return entry.hooks.map((handler) => ({
    event,
    matcher,
    command: commandOf(dataRecord(handler)),
  }));
}

/** A provider hook document, as `dataRecord` returns it: only `hooks` is read. */
interface HookDocument {
  hooks?: unknown;
}

/** Every handler in a provider hook document, read-only. Cursor keeps a flat list per event. */
function handlersOf(document: HookDocument | null, provider: AgentProvider) {
  return Object.entries(dataRecord(document?.hooks) ?? {}).flatMap(([event, list]) =>
    (Array.isArray(list) ? list : []).flatMap((entry) =>
      entryHandlers(event, dataRecord(entry), provider === 'cursor'),
    ),
  );
}

/** Handlers naming fallow's agent gate in a spelling `isRetired` will not delete. */
export const unrecognisedFallowGates = (document: HookDocument | null, provider: AgentProvider) =>
  handlersOf(document, provider).filter(
    ({ command }) =>
      (FALLOW_GATE_PATH.get(provider)?.test(command) ?? false) && !isRetired(provider, command),
  );

export const handlerLocation = (rel: string, { event, matcher }: OwnedHandler) =>
  `${rel} ${event}${matcher ? `[${matcher}]` : ''}`;

/** A handler the reconcile took out of a provider document, and why. */
export interface DroppedHandler extends OwnedHandler {
  reason: string;
}

function reclaimReason(
  provider: AgentProvider,
  owned: readonly OwnedHandler[],
  event: string,
  command: string,
  sitsHere: (handler: OwnedHandler) => boolean,
) {
  if (isRetired(provider, command)) return 'retired';
  const ownedHere = owned.some((h) => h.event === event && h.command === command && sitsHere(h));
  return ownedHere ? 'superseded' : null;
}

/** Reclaim fallow's agent gate anywhere, whoever wrote it (devkit's staged wrapper replaces it),
 * plus what a previous devkit release wrote; `owned` stays inside the event its row names. */
export function stripReclaimedCommands(
  document: unknown,
  provider: AgentProvider,
  owned: readonly OwnedHandler[] = [],
) {
  const dropped: DroppedHandler[] = [];
  if (!RETIRED_SCRIPT.has(provider) && !owned.length) return { document, changed: false, dropped };
  const root = dataRecord(document);
  const hooks = dataRecord(root?.hooks);
  if (!root || !hooks) return { document, changed: false, dropped };
  const nextHooks = { ...hooks };
  let changed = false;
  for (const [event, rawList] of Object.entries(hooks)) {
    if (!Array.isArray(rawList)) continue;
    if (provider === 'cursor') {
      const list = rawList.filter((entry) => {
        const command = String(dataRecord(entry)?.command ?? '');
        // Cursor keeps a FLAT list per event, so the event alone locates a handler.
        const reason = reclaimReason(provider, owned, event, command, () => true);
        if (reason) dropped.push({ event, matcher: null, command, reason });
        return !reason;
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
      // Mirrors lifecycle.mts matcherGroup: null means the group carries no `matcher` key.
      const matcher = Object.hasOwn(group, 'matcher') ? String(group.matcher) : null;
      const kept = handlers.filter((entry) => {
        const command = String(dataRecord(entry)?.command ?? '');
        const reason = reclaimReason(provider, owned, event, command, (handler) =>
          handler.matcher === null ? matcher === null : group.matcher === handler.matcher,
        );
        if (reason) dropped.push({ event, matcher, command, reason });
        return !reason;
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
  const next = changed ? { ...root, hooks: nextHooks } : document;
  return { document: next, changed, dropped };
}

/** One line per removed handler, so a settings diff never reads as consumer data loss. */
export function reportDropped(rel: string, dropped: readonly DroppedHandler[], dryRun: boolean) {
  for (const handler of dropped) {
    const { command, reason } = handler;
    const where = handlerLocation(rel, handler);
    console.log(`  ${dryRun ? '[dry-run] remove' : '✓ removed'} ${where}: ${command} (${reason})`);
  }
}

export const asDropped = (
  entries: readonly HookRegistrationOwnershipV1[],
  verb: string,
): DroppedHandler[] =>
  entries.map(({ native, ownerId }) => ({ ...native, reason: `${verb}: ${ownerId}` }));

const OTHER_SCOPE = { shared: 'overlay', overlay: 'shared' } as const;

/** The file the OTHER scope writes, when it differs from this scope's (only Claude's do today). */
export function otherScopeFile(root: string, provider: AgentProvider, scope: HookInstallScope) {
  const rel = hookRegistrationDestination(provider, OTHER_SCOPE[scope]);
  if (rel === hookRegistrationDestination(provider, scope)) return null;
  // A missing file reads as `{}`, so only a symlinked or non-file path needs refusing here.
  if (!isSafeAgentAssetPath(root, rel, true)) return null;
  try {
    return { rel, document: providerDocument(root, provider, rel) };
  } catch {
    return null; // Not the scope's file: its parse errors are the user's, never a devkit failure.
  }
}

/** Reconcile one destination, then take out devkit's ledgered registrations for `ids`. No writes. */
export function reclaimPass(
  root: string,
  provider: AgentProvider,
  scope: HookInstallScope,
  ids: string[],
  entries: HookRegistrationOwnershipV1[],
  legacyOwnedComponentIds?: string[],
) {
  const rel = hookRegistrationDestination(provider, scope);
  const legacy = reconcileLegacyHookCommands(entries, provider, rel);
  const document = providerDocument(root, provider, rel);
  const retired = stripReclaimedCommands(document, provider, legacy.stripped);
  let next = adoptExactLegacy(
    legacy.entries,
    retired.document,
    legacyOwnedComponentIds,
    provider,
    scope,
  );
  next = transferHookRegistrationScope(next, provider, scope);
  const removed = removeLedgerAuthorizedHookRegistrations(
    retired.document,
    projectHookRegistrations(ids, [provider], scope),
    ledgerOf(next),
    provider,
    scope,
  );
  next = release(next, [...removed.removed, ...removed.alreadyAbsent]);
  return { rel, legacy, retired, removed, entries: next };
}

/** devkit's registrations left in the file the OTHER scope writes, when it differs (a switch). */
export function otherScopePass(
  root: string,
  provider: AgentProvider,
  scope: HookInstallScope,
  entries: HookRegistrationOwnershipV1[],
) {
  // One file for both scopes (codex, cursor) returns null: transferHookRegistrationScope covers it.
  const file = otherScopeFile(root, provider, scope);
  if (!file || !dataRecord(file.document)) return null;
  const { rel } = file;
  // Never adopt: an unledgered identical handler in a file this scope doesn't own is the user's.
  const ids = Object.keys(HOOK_REGISTRATIONS);
  const pass = reclaimPass(root, provider, OTHER_SCOPE[scope], ids, entries);
  const changed = pass.retired.changed || pass.removed.changed;
  const retiredFound = pass.retired.dropped.some(({ reason }) => reason === 'retired');
  const superseded = pass.retired.dropped.some(({ reason }) => reason !== 'retired');
  const switched = superseded || pass.entries.length !== entries.length;
  // Drifted or blocked rows stay put (never thrown: not the scope's file), so only doctor names them.
  const stranded = pass.removed.drifted.length + pass.removed.blocked.length > 0;
  if (!changed && !switched && !stranded) return null;
  // Overlay must stay git-invisible, so a committed settings.json is reported, never edited.
  const repairable = !changed || scope === 'shared' || !isTracked(root, rel);
  return { ...pass, changed, switched, retiredFound, repairable, stranded };
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
