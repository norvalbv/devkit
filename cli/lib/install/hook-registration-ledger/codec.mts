import { firstDuplicateJsonKey } from '../../../../gate-engine/critique/json-duplicate-keys.mts';
import { isWellFormedUnicode } from '../agent-assets.mts';
import { type AgentProvider, isAgentProvider } from '../agent-providers.mts';

export const HOOK_REGISTRATION_LEDGER_REL =
  '.devkit/agent-hook-registrations-manifest.json' as const;

export type HookInstallScope = 'shared' | 'overlay';

/**
 * Untrusted ownership candidate only. A future destructive consumer must join every identity,
 * provider, scope, destination, and native field to a trusted bundled or historical projection,
 * then exactly match the current provider entry. It must never execute `native.command`.
 */
export interface HookRegistrationOwnershipV1 {
  registrationId: string;
  ownerId: string;
  provider: AgentProvider;
  installScope: HookInstallScope;
  destinationRel: string;
  native: {
    event: string;
    matcher: string | null;
    command: string;
  };
}

export interface HookRegistrationLedgerV1 {
  schemaVersion: 1;
  kind: 'agent_hook_registration_ownership';
  entries: HookRegistrationOwnershipV1[];
}

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_ID_BYTES = 128;
const MAX_EVENT_BYTES = 128;
const MAX_MATCHER_BYTES = 512;
const MAX_COMMAND_BYTES = 4096;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const REGISTRATION_ID_RE = /^[a-z0-9][a-z0-9._:-]*$/;
const EVENT_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CONTROL_RANGE = String.raw`\x00-\x1F\x7F-\x9F`;
const CONTROL_RE = new RegExp(`[${CONTROL_RANGE}]`, 'u');
const INSTALL_SCOPES = new Set<HookInstallScope>(['shared', 'overlay']);

const DESTINATION: Record<AgentProvider, Record<HookInstallScope, string>> = {
  claude: {
    shared: '.claude/settings.json',
    overlay: '.claude/settings.local.json',
  },
  codex: {
    shared: '.codex/hooks.json',
    overlay: '.codex/hooks.json',
  },
  cursor: {
    shared: '.cursor/hooks.json',
    overlay: '.cursor/hooks.json',
  },
};

function exactObject(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key)))
    throw new Error(`${label} fields do not match the v1 contract`);
  return object;
}

function boundedText(
  value: unknown,
  label: string,
  maxBytes: number,
  pattern?: RegExp,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && !value) ||
    !isWellFormedUnicode(value) ||
    CONTROL_RE.test(value) ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    (pattern && !pattern.test(value))
  )
    throw new Error(`${label} is invalid`);
  return value;
}

function decodeEntry(value: unknown, index: number): HookRegistrationOwnershipV1 {
  const label = `hook registration ledger entry ${index}`;
  const entry = exactObject(value, label, [
    'registrationId',
    'ownerId',
    'provider',
    'installScope',
    'destinationRel',
    'native',
  ]);
  const registrationId = boundedText(
    entry.registrationId,
    `${label}.registrationId`,
    MAX_ID_BYTES,
    REGISTRATION_ID_RE,
  );
  const ownerId = boundedText(entry.ownerId, `${label}.ownerId`, MAX_ID_BYTES, ID_RE);
  if (!isAgentProvider(entry.provider)) throw new Error(`${label}.provider is invalid`);
  const provider = entry.provider;
  if (!INSTALL_SCOPES.has(entry.installScope as HookInstallScope))
    throw new Error(`${label}.installScope is invalid`);
  const installScope = entry.installScope as HookInstallScope;
  const destinationRel = boundedText(entry.destinationRel, `${label}.destinationRel`, MAX_ID_BYTES);
  if (destinationRel !== DESTINATION[provider][installScope])
    throw new Error(`${label}.destinationRel does not match its provider and scope`);

  const native = exactObject(entry.native, `${label}.native`, ['event', 'matcher', 'command']);
  const event = boundedText(native.event, `${label}.native.event`, MAX_EVENT_BYTES, EVENT_RE);
  const matcher =
    native.matcher === null
      ? null
      : boundedText(native.matcher, `${label}.native.matcher`, MAX_MATCHER_BYTES, undefined, true);
  const command = boundedText(native.command, `${label}.native.command`, MAX_COMMAND_BYTES);
  return {
    registrationId,
    ownerId,
    provider,
    installScope,
    destinationRel,
    native: { event, matcher, command },
  };
}

function ownershipKey(entry: HookRegistrationOwnershipV1): string {
  return JSON.stringify([entry.provider, entry.destinationRel, entry.registrationId]);
}

function nativeKey(entry: HookRegistrationOwnershipV1): string {
  return JSON.stringify([
    entry.provider,
    entry.destinationRel,
    entry.native.event,
    entry.native.matcher,
    entry.native.command,
  ]);
}

/**
 * Decode one bounded JSON document into canonical, detached, untrusted ownership candidates.
 * This performs no I/O and grants no removal or command-execution authority.
 */
export function decodeHookRegistrationLedger(json: string): HookRegistrationLedgerV1 {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES)
    throw new Error('hook registration ledger JSON exceeds the accepted limit');
  const duplicate = firstDuplicateJsonKey(json);
  if (duplicate !== null)
    throw new Error(
      `hook registration ledger has duplicate object field ${JSON.stringify(duplicate)}`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('hook registration ledger is not valid JSON');
  }
  const root = exactObject(parsed, 'hook registration ledger', [
    'schemaVersion',
    'kind',
    'entries',
  ]);
  if (root.schemaVersion !== 1) throw new Error('unsupported hook registration ledger version');
  if (root.kind !== 'agent_hook_registration_ownership')
    throw new Error('unsupported hook registration ledger kind');
  if (!Array.isArray(root.entries) || root.entries.length > MAX_ENTRIES)
    throw new Error('hook registration ledger entries are invalid');

  const ownershipKeys = new Set<string>();
  const nativeKeys = new Set<string>();
  const registrationOwners = new Map<string, string>();
  const entries = root.entries.map((value, index) => {
    const entry = decodeEntry(value, index);
    const owned = ownershipKey(entry);
    if (ownershipKeys.has(owned)) throw new Error('duplicate hook registration ownership key');
    ownershipKeys.add(owned);
    const native = nativeKey(entry);
    if (nativeKeys.has(native)) throw new Error('duplicate native hook registration');
    nativeKeys.add(native);
    const owner = registrationOwners.get(entry.registrationId);
    if (owner !== undefined && owner !== entry.ownerId)
      throw new Error('hook registration identity has conflicting owners');
    registrationOwners.set(entry.registrationId, entry.ownerId);
    return { key: owned, entry };
  });
  entries.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return {
    schemaVersion: 1,
    kind: 'agent_hook_registration_ownership',
    entries: entries.map(({ entry }) => entry),
  };
}
