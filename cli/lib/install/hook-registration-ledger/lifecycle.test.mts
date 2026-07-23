import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentProvider } from '../agent-providers.mts';
import {
  HOOK_REGISTRATION_LEDGER_REL,
  type HookRegistrationLedgerV1,
  type HookRegistrationOwnershipV1,
} from './codec.mts';
import {
  checkProjectedHookRegistrations,
  installProjectedHookRegistrations,
  projectHookRegistrations,
  readHookRegistrationLedger,
  removeLedgerAuthorizedHookRegistrations,
  withAgentAssetLifecycleLock,
  writeHookRegistrationLedger,
} from './lifecycle.mts';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hook-registration-lifecycle-'));
  roots.push(root);
  return root;
}

function ledger(entries: HookRegistrationOwnershipV1[]): HookRegistrationLedgerV1 {
  return { schemaVersion: 1, kind: 'agent_hook_registration_ownership', entries };
}

function providerEntries(
  projection: ReturnType<typeof projectHookRegistrations>,
  provider: AgentProvider,
): HookRegistrationOwnershipV1[] {
  return projection.entries
    .filter((entry) => entry.provider === provider)
    .map((entry) => ({
      ...entry,
      native: { ...entry.native },
    }));
}

function data(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected object');
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected array');
  return value;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('trusted provider-native hook projection', () => {
  it('projects current registrations for Claude, Codex, and Cursor without executing commands', () => {
    const projection = projectHookRegistrations(
      ['searchSteering', 'agentHooks'],
      ['claude', 'codex', 'cursor'],
      'shared',
    );
    expect(providerEntries(projection, 'claude')).toHaveLength(8);
    expect(providerEntries(projection, 'codex')).toHaveLength(8);
    expect(providerEntries(projection, 'cursor')).toHaveLength(7);

    const codexStop = providerEntries(projection, 'codex').find(
      (entry) => entry.registrationId === 'agent-hooks:decision-stop',
    );
    expect(codexStop).toMatchObject({
      destinationRel: '.codex/hooks.json',
      native: {
        event: 'Stop',
        matcher: null,
        command: 'bash "$(git rev-parse --show-toplevel)/.codex/hooks/decision-stop-check.sh"',
      },
    });
    const codexFormat = providerEntries(projection, 'codex').find(
      (entry) => entry.registrationId === 'agent-hooks:format-after-edit',
    );
    expect(codexFormat?.native.matcher).toBe('Edit|Write|MultiEdit');

    const cursorPrompt = providerEntries(projection, 'cursor').find(
      (entry) => entry.registrationId === 'agent-hooks:prompt-reminder',
    );
    expect(cursorPrompt).toBeUndefined();
    expect(
      providerEntries(projection, 'cursor').find(
        (entry) => entry.registrationId === 'agent-hooks:decision-stop',
      ),
    ).toMatchObject({
      destinationRel: '.cursor/hooks.json',
      native: {
        event: 'stop',
        matcher: null,
        command: '.cursor/hooks/decision-stop-check.sh',
      },
    });
  });

  it('rejects a caller-forged projection at the destructive boundary', () => {
    expect(() =>
      installProjectedHookRegistrations({}, { entries: [] }, null, 'claude', 'shared'),
    ).toThrow(/not trusted/);
  });
});

describe('provider-native install and doctor lifecycle', () => {
  it('emits exact matcher-less Codex groups and preserves every foreign field and handler', () => {
    const projection = projectHookRegistrations(['agentHooks'], ['codex'], 'shared');
    const foreign = { type: 'command', command: 'node ./foreign-stop.mjs', timeout: 17 };
    const existing = {
      description: 'consumer-owned',
      future: { enabled: true },
      hooks: { Stop: [{ hooks: [foreign], groupMetadata: 'keep' }] },
    };
    Object.defineProperty(existing, '__proto__', {
      configurable: true,
      enumerable: true,
      value: { consumerOwned: true },
      writable: true,
    });
    const installed = installProjectedHookRegistrations(
      existing,
      projection,
      null,
      'codex',
      'shared',
    );
    expect(installed.changed).toBe(true);
    expect(installed.ownershipEntries).toHaveLength(6);
    expect(installed.collisions).toEqual([]);
    expect(installed.document).toMatchObject({
      description: 'consumer-owned',
      future: { enabled: true },
    });
    expect(Object.hasOwn(installed.document, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(installed.document, '__proto__')?.value).toEqual({
      consumerOwned: true,
    });

    const hooks = data(installed.document.hooks);
    const stopGroups = list(hooks.Stop).map(data);
    expect(stopGroups).toHaveLength(1);
    expect(stopGroups[0]).not.toHaveProperty('matcher');
    expect(stopGroups[0].groupMetadata).toBe('keep');
    const stopHandlers = list(stopGroups[0].hooks).map(data);
    expect(stopHandlers).toContainEqual(foreign);
    expect(stopHandlers.filter((hook) => hook.command !== foreign.command)).toHaveLength(3);
    expect(JSON.stringify(installed.document)).not.toContain('$CLAUDE_PROJECT_DIR');

    const ownership = ledger(installed.ownershipEntries);
    expect(
      checkProjectedHookRegistrations(installed.document, projection, ownership, 'codex', 'shared'),
    ).toMatchObject({ ok: true, present: { length: 6 } });
    const repeated = installProjectedHookRegistrations(
      installed.document,
      projection,
      ownership,
      'codex',
      'shared',
    );
    expect(repeated.changed).toBe(false);
    expect(repeated.ownershipEntries).toHaveLength(6);
    expect(repeated.document).toEqual(installed.document);
  });

  it('recognizes exact handlers inside legacy grouped Claude settings when ledger-authorized', () => {
    const projection = projectHookRegistrations(['agentHooks'], ['claude'], 'shared');
    const first = installProjectedHookRegistrations({}, projection, null, 'claude', 'shared');
    const hooks = data(first.document.hooks);
    const stopGroups = list(hooks.Stop).map(data);
    expect(stopGroups).toHaveLength(1);
    expect(list(stopGroups[0].hooks)).toHaveLength(3);

    const authorized = ledger(first.ownershipEntries);
    const bootstrap = installProjectedHookRegistrations(
      first.document,
      projection,
      authorized,
      'claude',
      'shared',
    );
    expect(bootstrap.changed).toBe(false);
    expect(bootstrap.ownershipEntries).toHaveLength(6);
    expect(
      checkProjectedHookRegistrations(first.document, projection, authorized, 'claude', 'shared')
        .ok,
    ).toBe(true);
  });

  it('reports an authorized command moved to another matcher as drift instead of duplicating it', () => {
    const projection = projectHookRegistrations(['searchSteering'], ['claude'], 'shared');
    const installed = installProjectedHookRegistrations({}, projection, null, 'claude', 'shared');
    const target = providerEntries(projection, 'claude').find(
      (entry) => entry.registrationId === 'search-steering:pre-bash',
    );
    if (!target) throw new Error('missing projected registration');
    const hooks = data(installed.document.hooks);
    const groups = list(hooks[target.native.event]).map(data);
    const source = groups.find((group) => group.matcher === target.native.matcher);
    if (!source) throw new Error('missing source matcher group');
    const [handler] = list(source.hooks);
    source.hooks = [];
    groups.push({ matcher: 'OtherTool', hooks: [handler] });
    hooks[target.native.event] = groups;

    const repeated = installProjectedHookRegistrations(
      installed.document,
      projection,
      ledger(installed.ownershipEntries),
      'claude',
      'shared',
    );
    expect(repeated.changed).toBe(false);
    expect(repeated.blocked.map((entry) => entry.registrationId)).toEqual([target.registrationId]);
    expect(JSON.stringify(repeated.document).match(/search-tool-guard/g)).toHaveLength(1);
  });

  it('preserves an identical unledgered registration as a collision instead of claiming it', () => {
    const projection = projectHookRegistrations(['searchSteering'], ['cursor'], 'shared');
    const expected = providerEntries(projection, 'cursor');
    const existing = {
      version: 1,
      hooks: { [expected[0].native.event]: [{ command: expected[0].native.command }] },
    };
    const installed = installProjectedHookRegistrations(
      existing,
      projection,
      null,
      'cursor',
      'shared',
    );
    expect(installed.collisions.map((entry) => entry.registrationId)).toEqual([
      expected[0].registrationId,
    ]);
    expect(installed.ownershipEntries).toHaveLength(1);
    expect(list(data(installed.document.hooks)[expected[0].native.event])).toHaveLength(1);
  });

  it('blocks a projected registration whose ledger ownership key has stale native fields', () => {
    const projection = projectHookRegistrations(['searchSteering'], ['cursor'], 'shared');
    const expected = providerEntries(projection, 'cursor');
    const target = expected[0];
    const stale = {
      ...target,
      native: { ...target.native, command: 'node .cursor/hooks/obsolete-hook.mjs' },
    };
    const installed = installProjectedHookRegistrations(
      {},
      projection,
      ledger([stale]),
      'cursor',
      'shared',
    );
    expect(installed.blocked.map((entry) => entry.registrationId)).toEqual([target.registrationId]);
    expect(installed.untrustedLedgerEntries).toEqual([stale]);
    expect(installed.ownershipEntries.map((entry) => entry.registrationId)).not.toContain(
      target.registrationId,
    );
    expect(JSON.stringify(installed.document)).not.toContain(target.native.command);
  });

  it('fails closed on a malformed hook block without overwriting it', () => {
    const projection = projectHookRegistrations(['searchSteering'], ['claude'], 'shared');
    const existing = { consumer: true, hooks: 'foreign-format' };
    const installed = installProjectedHookRegistrations(
      existing,
      projection,
      null,
      'claude',
      'shared',
    );
    expect(installed.changed).toBe(false);
    expect(installed.blocked).toHaveLength(2);
    expect(installed.document).toEqual(existing);
  });
});

describe('ledger-authorized exact removal', () => {
  it('removes one exact Claude handler while preserving siblings, groups, and foreign keys', () => {
    const projection = projectHookRegistrations(['agentHooks'], ['claude'], 'shared');
    const foreign = { type: 'command', command: 'bash ./foreign.sh', timeout: 9 };
    const existing = {
      permissions: { allow: ['Read'] },
      hooks: { Stop: [{ matcher: '', hooks: [foreign], note: 'keep-group' }] },
    };
    const installed = installProjectedHookRegistrations(
      existing,
      projection,
      null,
      'claude',
      'shared',
    );
    const ownership = ledger(installed.ownershipEntries);
    const removed = removeLedgerAuthorizedHookRegistrations(
      installed.document,
      projection,
      ownership,
      'claude',
      'shared',
    );
    expect(removed.removed).toHaveLength(6);
    expect(removed.drifted).toEqual([]);
    expect(removed.document.permissions).toEqual({ allow: ['Read'] });
    const stop = data(list(data(removed.document.hooks).Stop)[0]);
    expect(stop).toMatchObject({ matcher: '', note: 'keep-group' });
    expect(stop.hooks).toEqual([foreign]);
  });

  it('prunes only empty devkit scaffolding from a fully owned document', () => {
    const projection = projectHookRegistrations(['agentHooks'], ['claude'], 'shared');
    const installed = installProjectedHookRegistrations({}, projection, null, 'claude', 'shared');
    const removed = removeLedgerAuthorizedHookRegistrations(
      installed.document,
      projection,
      ledger(installed.ownershipEntries),
      'claude',
      'shared',
    );
    expect(removed.document).toEqual({ hooks: {} });
  });

  it('leaves duplicate, decorated, and ledger-tampered candidates untouched as drift/evidence', () => {
    const projection = projectHookRegistrations(['searchSteering'], ['cursor'], 'shared');
    const installed = installProjectedHookRegistrations({}, projection, null, 'cursor', 'shared');
    const entries = providerEntries(projection, 'cursor');
    const hooks = data(installed.document.hooks);
    const duplicateEvent = entries[0].native.event;
    hooks[duplicateEvent] = [
      ...list(hooks[duplicateEvent]),
      { command: entries[0].native.command },
    ];
    const decoratedEvent = entries[1].native.event;
    hooks[decoratedEvent] = list(hooks[decoratedEvent]).map((hook) => ({
      ...data(hook),
      timeout: 5,
    }));
    const duplicateResult = removeLedgerAuthorizedHookRegistrations(
      installed.document,
      projection,
      ledger(installed.ownershipEntries),
      'cursor',
      'shared',
    );
    expect(duplicateResult.drifted.map((entry) => entry.registrationId)).toContain(
      entries[0].registrationId,
    );
    expect(duplicateResult.drifted.map((entry) => entry.registrationId)).toContain(
      entries[1].registrationId,
    );
    expect(list(data(duplicateResult.document.hooks)[duplicateEvent])).toHaveLength(2);
    expect(list(data(duplicateResult.document.hooks)[decoratedEvent])).toHaveLength(1);

    const tampered = { ...entries[1], native: { ...entries[1].native, command: 'rm -rf nope' } };
    const before = structuredClone(installed.document);
    const untrusted = removeLedgerAuthorizedHookRegistrations(
      installed.document,
      projection,
      ledger([tampered]),
      'cursor',
      'shared',
    );
    expect(untrusted.changed).toBe(false);
    expect(untrusted.untrustedLedgerEntries).toEqual([tampered]);
    expect(untrusted.document).toEqual(before);
  });
});

describe('bounded atomic ledger storage', () => {
  it('round-trips canonical data atomically without temporary siblings', () => {
    const root = tempRoot();
    const projection = projectHookRegistrations(['searchSteering'], ['cursor'], 'shared');
    const entries = providerEntries(projection, 'cursor').reverse();
    expect(readHookRegistrationLedger(root)).toBeNull();
    withAgentAssetLifecycleLock(root, false, () =>
      writeHookRegistrationLedger(root, ledger(entries)),
    );
    const read = readHookRegistrationLedger(root);
    expect(read?.entries.map((entry) => entry.registrationId)).toEqual(
      [...entries].reverse().map((entry) => entry.registrationId),
    );
    expect(readdirSync(join(root, '.devkit'))).toEqual(['agent-hook-registrations-manifest.json']);
    expect(readFileSync(join(root, HOOK_REGISTRATION_LEDGER_REL), 'utf8').endsWith('\n')).toBe(
      true,
    );
  });

  it('rejects oversized, invalid UTF-8, symlinked leaves, and symlinked storage directories', () => {
    const root = tempRoot();
    const path = join(root, HOOK_REGISTRATION_LEDGER_REL);
    mkdirSync(join(root, '.devkit'));
    writeFileSync(path, Buffer.alloc(1024 * 1024 + 1));
    expect(() => readHookRegistrationLedger(root)).toThrow(/1 MiB/);
    writeFileSync(path, Buffer.from([0xff]));
    expect(() => readHookRegistrationLedger(root)).toThrow(/UTF-8/);

    const target = join(root, 'target.json');
    writeFileSync(target, '{}');
    rmSync(path);
    symlinkSync(target, path);
    expect(() => readHookRegistrationLedger(root)).toThrow(/symlink/);
    expect(() =>
      writeHookRegistrationLedger(
        root,
        ledger(providerEntries(projectHookRegistrations([], [], 'shared'), 'claude')),
      ),
    ).toThrow(/regular file/);
    expect(readFileSync(target, 'utf8')).toBe('{}');

    const symlinkRoot = tempRoot();
    const outside = tempRoot();
    symlinkSync(outside, join(symlinkRoot, '.devkit'));
    expect(() => writeHookRegistrationLedger(symlinkRoot, ledger([]))).toThrow(/directory/);
    expect(readdirSync(outside)).toEqual([]);
  });
});
