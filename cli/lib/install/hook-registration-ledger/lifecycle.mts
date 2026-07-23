import { types as utilTypes } from 'node:util';
import { type AgentProvider, isAgentProvider } from '../agent-providers.mts';
import { HOOK_REGISTRATIONS } from '../hook-registrations.mts';
import {
  decodeHookRegistrationLedger,
  type HookInstallScope,
  type HookRegistrationLedgerV1,
  type HookRegistrationOwnershipV1,
  hookRegistrationDestination,
} from './codec.mts';

export { withAgentAssetLifecycleLock } from '../agent-asset-lock.mts';
export { readHookRegistrationLedger, writeHookRegistrationLedger } from './codec.mts';

const TRUSTED_PROJECTIONS = new WeakSet<object>();
const RUNNER_RE = /^(node|bash)\s+/;
const CLAUDE_PROJECT_DIR_RE = /"\$CLAUDE_PROJECT_DIR"?\/?/g;
const CURSOR_EVENT: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  PreToolUse: { Bash: 'beforeShellExecution' },
  PostToolUse: { Bash: 'afterShellExecution', 'Edit|Write|MultiEdit': 'afterFileEdit' },
  Stop: { '': 'stop' },
  PreCompact: { '': 'preCompact' },
};

export interface TrustedHookRegistrationProjection {
  readonly entries: readonly HookRegistrationOwnershipV1[];
}

const emptyEntries = (): HookRegistrationOwnershipV1[] => [];

function codexCommand(command: string): string {
  return command
    .replaceAll('$CLAUDE_PROJECT_DIR', '$(git rev-parse --show-toplevel)')
    .replaceAll('.claude/hooks/', '.codex/hooks/');
}

function cursorCommand(command: string): string {
  return command
    .replace(RUNNER_RE, '')
    .replace(CLAUDE_PROJECT_DIR_RE, '')
    .replaceAll('.claude/hooks/', '.cursor/hooks/')
    .replaceAll('"', '')
    .trim();
}

function nativeProjection(
  provider: AgentProvider,
  registration: { event: string; matcher: string; command: string },
): HookRegistrationOwnershipV1['native'] | null {
  const { event, matcher, command } = registration;
  if (provider === 'claude') return { event, matcher, command };
  if (provider === 'codex')
    return {
      event,
      matcher: matcher || null,
      command: codexCommand(command),
    };
  const cursorEvent = CURSOR_EVENT[event]?.[matcher];
  return cursorEvent
    ? { event: cursorEvent, matcher: null, command: cursorCommand(command) }
    : null;
}

/** Derive the only trusted ownership candidates: current bundled registrations, provider-native. */
export function projectHookRegistrations(
  componentIds: readonly string[],
  targets: readonly AgentProvider[],
  installScope: HookInstallScope,
): TrustedHookRegistrationProjection {
  const entries: HookRegistrationOwnershipV1[] = [];
  for (const ownerId of new Set(componentIds)) {
    for (const registration of HOOK_REGISTRATIONS[ownerId] ?? []) {
      for (const provider of new Set(targets)) {
        if (!isAgentProvider(provider)) throw new Error('hook registration target is invalid');
        const native = nativeProjection(provider, registration);
        if (!native) continue;
        entries.push({
          registrationId: registration.registrationId,
          ownerId,
          provider,
          installScope,
          destinationRel: hookRegistrationDestination(provider, installScope),
          native,
        });
      }
    }
  }
  const canonical = decodeHookRegistrationLedger(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'agent_hook_registration_ownership',
      entries,
    }),
  ).entries;
  for (const entry of canonical) {
    Object.freeze(entry.native);
    Object.freeze(entry);
  }
  const projection = Object.freeze({ entries: Object.freeze(canonical) });
  TRUSTED_PROJECTIONS.add(projection);
  return projection;
}

function trustedEntries(
  projection: TrustedHookRegistrationProjection,
  provider: AgentProvider,
  installScope: HookInstallScope,
): readonly HookRegistrationOwnershipV1[] {
  if (!TRUSTED_PROJECTIONS.has(projection))
    throw new Error('hook registration projection is not trusted');
  const destination = hookRegistrationDestination(provider, installScope);
  return projection.entries.filter(
    (entry) =>
      entry.provider === provider &&
      entry.installScope === installScope &&
      entry.destinationRel === destination,
  );
}

function exactEntry(
  left: HookRegistrationOwnershipV1,
  right: HookRegistrationOwnershipV1,
): boolean {
  return (
    left.registrationId === right.registrationId &&
    left.ownerId === right.ownerId &&
    left.provider === right.provider &&
    left.installScope === right.installScope &&
    left.destinationRel === right.destinationRel &&
    left.native.event === right.native.event &&
    left.native.matcher === right.native.matcher &&
    left.native.command === right.native.command
  );
}

function sameOwnershipKey(
  left: HookRegistrationOwnershipV1,
  right: HookRegistrationOwnershipV1,
): boolean {
  return (
    left.registrationId === right.registrationId &&
    left.provider === right.provider &&
    left.destinationRel === right.destinationRel
  );
}

/** Transfer exact same-destination ownership when package/overlay scope changes. */
export function transferHookRegistrationScope(
  entries: readonly HookRegistrationOwnershipV1[],
  provider: AgentProvider,
  installScope: HookInstallScope,
): HookRegistrationOwnershipV1[] {
  const expected = projectHookRegistrations(
    Object.keys(HOOK_REGISTRATIONS),
    [provider],
    installScope,
  ).entries;
  return entries.map(
    (entry) =>
      expected.find(
        (candidate) =>
          sameOwnershipKey(entry, candidate) && exactEntry({ ...entry, installScope }, candidate),
      ) ?? entry,
  );
}

function canonicalLedger(ledger: HookRegistrationLedgerV1 | null): HookRegistrationLedgerV1 {
  if (ledger === null)
    return { schemaVersion: 1, kind: 'agent_hook_registration_ownership', entries: [] };
  return decodeHookRegistrationLedger(JSON.stringify(ledger));
}

function dataRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      utilTypes.isProxy(value)
    )
      return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const record: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') return null;
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      Object.defineProperty(record, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }
    return record;
  } catch {
    return null;
  }
}

function exactData(value: unknown, expected: Record<string, unknown>): boolean {
  const actual = dataRecord(value);
  if (!actual) return false;
  const keys = Object.keys(expected);
  return (
    Object.keys(actual).length === keys.length &&
    keys.every((key) => Object.hasOwn(actual, key) && actual[key] === expected[key])
  );
}

interface EventMatch {
  list: unknown[] | null;
  exact: Array<{ outer: number; inner?: number }>;
  related: boolean;
  malformed: boolean;
  groupIndex: number | null;
}

function matcherGroup(
  value: unknown,
  matcher: string | null,
): { group: Record<string, unknown>; hooks: unknown[] | null } | null {
  const group = dataRecord(value);
  const matches =
    matcher === null
      ? group !== null && !Object.hasOwn(group, 'matcher')
      : group?.matcher === matcher;
  if (!group || !matches) return null;
  return { group, hooks: Array.isArray(group.hooks) ? group.hooks : null };
}

function eventMatch(
  hooks: Record<string, unknown>,
  entry: HookRegistrationOwnershipV1,
): EventMatch {
  const raw = hooks[entry.native.event];
  const empty = { exact: [], related: false, malformed: false, groupIndex: null };
  if (raw === undefined) return { list: [], ...empty };
  if (!Array.isArray(raw)) return { list: null, ...empty };
  const nested = entry.provider !== 'cursor';
  const exact: EventMatch['exact'] = [];
  let related = false;
  let malformed = false;
  let groupIndex: number | null = null;
  for (const [index, value] of raw.entries()) {
    if (!nested) {
      if (exactData(value, { command: entry.native.command })) exact.push({ outer: index });
      else if (dataRecord(value)?.command === entry.native.command) related = true;
      continue;
    }
    const candidate = matcherGroup(value, entry.native.matcher);
    if (!candidate) {
      const otherGroup = dataRecord(value);
      if (
        Array.isArray(otherGroup?.hooks) &&
        otherGroup.hooks.some((hook) => {
          const handler = dataRecord(hook);
          return handler?.type === 'command' && handler.command === entry.native.command;
        })
      )
        related = true;
      continue;
    }
    groupIndex ??= index;
    if (!candidate.hooks) {
      malformed = true;
      continue;
    }
    for (const [hookIndex, hook] of candidate.hooks.entries()) {
      if (exactData(hook, { type: 'command', command: entry.native.command }))
        exact.push({ outer: index, inner: hookIndex });
      else {
        const handler = dataRecord(hook);
        if (handler?.type === 'command' && handler.command === entry.native.command) related = true;
      }
    }
  }
  return { list: raw, exact, related, malformed, groupIndex };
}

function addRegistration(match: EventMatch, entry: HookRegistrationOwnershipV1): unknown[] {
  if (!match.list) throw new Error('cannot add to a malformed hook event');
  if (entry.provider === 'cursor') return [...match.list, { command: entry.native.command }];
  const handler = { type: 'command', command: entry.native.command };
  if (match.groupIndex === null) {
    const group =
      entry.native.matcher === null
        ? { hooks: [handler] }
        : { matcher: entry.native.matcher, hooks: [handler] };
    return [...match.list, group];
  }
  const list = [...match.list];
  const candidate = matcherGroup(list[match.groupIndex], entry.native.matcher);
  if (!candidate?.hooks) throw new Error('cannot add to a malformed hook matcher group');
  list[match.groupIndex] = { ...candidate.group, hooks: [...candidate.hooks, handler] };
  return list;
}

function removeRegistration(match: EventMatch, entry: HookRegistrationOwnershipV1): unknown[] {
  if (!match.list || match.exact.length !== 1) throw new Error('registration is not exact');
  const location = match.exact[0];
  if (entry.provider === 'cursor') return match.list.filter((_, index) => index !== location.outer);
  const list = [...match.list];
  const candidate = matcherGroup(list[location.outer], entry.native.matcher);
  if (!candidate?.hooks || location.inner === undefined)
    throw new Error('registration group is not exact');
  const remainingHooks = candidate.hooks.filter((_, index) => index !== location.inner);
  const onlyScaffold = Object.keys(candidate.group).every(
    (key) => key === 'matcher' || key === 'hooks',
  );
  if (remainingHooks.length === 0 && onlyScaffold)
    return list.filter((_, index) => index !== location.outer);
  list[location.outer] = {
    ...candidate.group,
    hooks: remainingHooks,
  };
  return list;
}

function editableDocument(document: unknown): {
  root: Record<string, unknown>;
  hooks: Record<string, unknown> | null;
} {
  if (document === null || document === undefined) return { root: {}, hooks: {} };
  const root = dataRecord(document);
  if (!root) throw new Error('provider hook document must be a plain data object');
  if (!Object.hasOwn(root, 'hooks')) return { root, hooks: {} };
  return { root, hooks: dataRecord(root.hooks) };
}

function ledgerContext(
  ledger: HookRegistrationLedgerV1 | null,
  provider: AgentProvider,
  installScope: HookInstallScope,
): HookRegistrationOwnershipV1[] {
  const destination = hookRegistrationDestination(provider, installScope);
  return canonicalLedger(ledger).entries.filter(
    (entry) =>
      entry.provider === provider &&
      entry.installScope === installScope &&
      entry.destinationRel === destination,
  );
}

function partitionLedger(
  ledger: HookRegistrationLedgerV1 | null,
  expected: readonly HookRegistrationOwnershipV1[],
  provider: AgentProvider,
  installScope: HookInstallScope,
): { authorized: HookRegistrationOwnershipV1[]; untrusted: HookRegistrationOwnershipV1[] } {
  const authorized: HookRegistrationOwnershipV1[] = [];
  const untrusted: HookRegistrationOwnershipV1[] = [];
  for (const entry of ledgerContext(ledger, provider, installScope)) {
    (expected.some((candidate) => exactEntry(entry, candidate)) ? authorized : untrusted).push(
      entry,
    );
  }
  return { authorized, untrusted };
}

/** Add only missing trusted registrations; an identical unledgered registration is a collision. */
export function installProjectedHookRegistrations(
  document: unknown,
  projection: TrustedHookRegistrationProjection,
  ledger: HookRegistrationLedgerV1 | null,
  provider: AgentProvider,
  installScope: HookInstallScope,
) {
  const expected = trustedEntries(projection, provider, installScope);
  const { authorized, untrusted } = partitionLedger(ledger, expected, provider, installScope);
  const { root, hooks } = editableDocument(document);
  const result = {
    document: root,
    ownershipEntries: emptyEntries(),
    collisions: emptyEntries(),
    blocked: emptyEntries(),
    untrustedLedgerEntries: untrusted,
    changed: false,
  };
  if (!hooks) {
    result.blocked.push(...expected);
    return result;
  }
  for (const entry of expected) {
    if (untrusted.some((candidate) => sameOwnershipKey(candidate, entry))) {
      result.blocked.push(entry);
      continue;
    }
    const match = eventMatch(hooks, entry);
    if (match.list === null || match.malformed) {
      result.blocked.push(entry);
      continue;
    }
    const isAuthorized = authorized.some((candidate) => exactEntry(candidate, entry));
    if (match.exact.length === 1 && !match.related) {
      if (isAuthorized) result.ownershipEntries.push(entry);
      else result.collisions.push(entry);
      continue;
    }
    if (match.exact.length > 0 || match.related) {
      (isAuthorized ? result.blocked : result.collisions).push(entry);
      continue;
    }
    hooks[entry.native.event] = addRegistration(match, entry);
    result.ownershipEntries.push(entry);
    result.changed = true;
  }
  if (result.changed) root.hooks = hooks;
  return result;
}

/** Remove one exact config item only after ledger and trusted projection agree on every field. */
export function removeLedgerAuthorizedHookRegistrations(
  document: unknown,
  projection: TrustedHookRegistrationProjection,
  ledger: HookRegistrationLedgerV1 | null,
  provider: AgentProvider,
  installScope: HookInstallScope,
) {
  const expected = trustedEntries(projection, provider, installScope);
  const { authorized, untrusted } = partitionLedger(ledger, expected, provider, installScope);
  const { root, hooks } = editableDocument(document);
  const result = {
    document: root,
    removed: emptyEntries(),
    alreadyAbsent: emptyEntries(),
    drifted: emptyEntries(),
    blocked: emptyEntries(),
    untrustedLedgerEntries: untrusted,
    changed: false,
  };
  if (!hooks) {
    result.blocked.push(...authorized);
    return result;
  }
  for (const entry of authorized) {
    const match = eventMatch(hooks, entry);
    if (match.list === null || match.malformed) {
      result.blocked.push(entry);
    } else if (match.exact.length === 1 && !match.related) {
      const updated = removeRegistration(match, entry);
      if (updated.length === 0) delete hooks[entry.native.event];
      else hooks[entry.native.event] = updated;
      result.removed.push(entry);
      result.changed = true;
    } else if (match.exact.length > 0 || match.related) {
      result.drifted.push(entry);
    } else {
      result.alreadyAbsent.push(entry);
    }
  }
  if (result.changed) root.hooks = hooks;
  return result;
}

/** Read-only doctor projection: both exact config presence and exact ledger authority are required. */
export function checkProjectedHookRegistrations(
  document: unknown,
  projection: TrustedHookRegistrationProjection,
  ledger: HookRegistrationLedgerV1 | null,
  provider: AgentProvider,
  installScope: HookInstallScope,
) {
  const expected = trustedEntries(projection, provider, installScope);
  const { authorized, untrusted } = partitionLedger(ledger, expected, provider, installScope);
  const { hooks } = editableDocument(document);
  const result = {
    ok: false,
    present: emptyEntries(),
    missing: emptyEntries(),
    drifted: emptyEntries(),
    collisions: emptyEntries(),
    blocked: emptyEntries(),
    untrustedLedgerEntries: untrusted,
  };
  if (!hooks) {
    result.blocked.push(...expected);
    return result;
  }
  for (const entry of expected) {
    const match = eventMatch(hooks, entry);
    const isAuthorized = authorized.some((candidate) => exactEntry(candidate, entry));
    if (match.list === null || match.malformed) result.blocked.push(entry);
    else if (isAuthorized && match.exact.length === 1 && !match.related) result.present.push(entry);
    else if (isAuthorized && (match.exact.length > 0 || match.related)) result.drifted.push(entry);
    else if (!isAuthorized && (match.exact.length > 0 || match.related))
      result.collisions.push(entry);
    else result.missing.push(entry);
  }
  result.ok =
    result.present.length === expected.length &&
    result.untrustedLedgerEntries.length === 0 &&
    result.blocked.length === 0;
  return result;
}
