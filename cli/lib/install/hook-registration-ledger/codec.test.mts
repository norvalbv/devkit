import { describe, expect, it } from 'vitest';
import {
  decodeHookRegistrationLedger,
  encodeHookRegistrationLedger,
  HOOK_REGISTRATION_LEDGER_REL,
  type HookRegistrationOwnershipV1,
  hookRegistrationDestination,
} from './codec.mts';
import { HOOK_REGISTRATIONS } from './registrations.mts';

function entry(overrides: Partial<HookRegistrationOwnershipV1> = {}): HookRegistrationOwnershipV1 {
  return {
    registrationId: 'agent-hooks:decision-stop',
    ownerId: 'agentHooks',
    provider: 'claude',
    installScope: 'shared',
    destinationRel: '.claude/settings.json',
    native: {
      event: 'Stop',
      matcher: '',
      command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/decision-stop-check.sh"',
    },
    ...overrides,
  };
}

function ledger(entries: unknown[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: 'agent_hook_registration_ownership',
    entries,
  });
}

describe('hook registration ownership ledger decoding', () => {
  it('decodes an empty v1 ledger at the dormant canonical path', () => {
    expect(HOOK_REGISTRATION_LEDGER_REL).toBe('.devkit/agent-hook-registrations-manifest.json');
    expect(decodeHookRegistrationLedger(ledger([]))).toEqual({
      schemaVersion: 1,
      kind: 'agent_hook_registration_ownership',
      entries: [],
    });
  });

  it('canonicalizes provider/scope entries while allowing one stable id across projections', () => {
    const cursor = entry({
      provider: 'cursor',
      destinationRel: '.cursor/hooks.json',
      native: { event: 'stop', matcher: null, command: '.cursor/hooks/decision-stop-check.sh' },
    });
    const overlay = entry({
      installScope: 'overlay',
      destinationRel: '.claude/settings.local.json',
    });
    const codex = entry({
      provider: 'codex',
      destinationRel: '.codex/hooks.json',
      native: {
        event: 'SubagentStop',
        matcher: null,
        command: '.codex/hooks/feature-critique-subagent-stop.mjs',
      },
    });
    const decoded = decodeHookRegistrationLedger(ledger([cursor, codex, overlay, entry()]));
    expect(decoded.entries).toEqual([entry(), overlay, codex, cursor]);
  });

  it('encodes the same canonical, newline-terminated document regardless of entry order', () => {
    const cursor = entry({
      provider: 'cursor',
      destinationRel: '.cursor/hooks.json',
      native: { event: 'stop', matcher: null, command: '.cursor/hooks/decision-stop-check.sh' },
    });
    const encoded = encodeHookRegistrationLedger({
      schemaVersion: 1,
      kind: 'agent_hook_registration_ownership',
      entries: [cursor, entry()],
    });
    expect(encoded.endsWith('\n')).toBe(true);
    expect(JSON.parse(encoded).entries).toEqual([entry(), cursor]);
    expect(encodeHookRegistrationLedger(JSON.parse(encoded))).toBe(encoded);
  });

  it('resolves only the closed provider/scope destination table', () => {
    expect(hookRegistrationDestination('claude', 'overlay')).toBe('.claude/settings.local.json');
    expect(hookRegistrationDestination('codex', 'shared')).toBe('.codex/hooks.json');
    expect(() => hookRegistrationDestination('other' as 'claude', 'shared')).toThrow(/provider/);
    expect(() => hookRegistrationDestination('claude', 'other' as 'shared')).toThrow(/scope/);
  });
});

describe('hook registration ownership ledger contract', () => {
  it.each([
    [
      'future version',
      { schemaVersion: 2, kind: 'agent_hook_registration_ownership', entries: [] },
    ],
    ['wrong kind', { schemaVersion: 1, kind: 'asset_ownership', entries: [] }],
    [
      'unknown provider',
      {
        schemaVersion: 1,
        kind: 'agent_hook_registration_ownership',
        entries: [entry({ provider: 'other' as 'claude' })],
      },
    ],
    [
      'cross-provider destination',
      {
        schemaVersion: 1,
        kind: 'agent_hook_registration_ownership',
        entries: [entry({ destinationRel: '.cursor/hooks.json' })],
      },
    ],
    [
      'traversal destination',
      {
        schemaVersion: 1,
        kind: 'agent_hook_registration_ownership',
        entries: [entry({ destinationRel: '.claude/../settings.json' })],
      },
    ],
    [
      'extra ownership field',
      {
        schemaVersion: 1,
        kind: 'agent_hook_registration_ownership',
        entries: [{ ...entry(), ownsFile: true }],
      },
    ],
    [
      'control-bearing command',
      {
        schemaVersion: 1,
        kind: 'agent_hook_registration_ownership',
        entries: [entry({ native: { event: 'Stop', matcher: '', command: 'echo ok\nrm -rf .' } })],
      },
    ],
    [
      'unpaired Unicode command',
      {
        schemaVersion: 1,
        kind: 'agent_hook_registration_ownership',
        entries: [entry({ native: { event: 'Stop', matcher: '', command: 'echo \ud800' } })],
      },
    ],
  ])('rejects %s', (_case, value) => {
    expect(() => decodeHookRegistrationLedger(JSON.stringify(value))).toThrow();
  });
});

describe('hook registration ownership ledger collisions', () => {
  it('rejects duplicate ownership, native aliases, and conflicting owners', () => {
    expect(() => decodeHookRegistrationLedger(ledger([entry(), entry()]))).toThrow(/ownership/);
    expect(() =>
      decodeHookRegistrationLedger(
        ledger([entry(), entry({ registrationId: 'agent-hooks:decision-stop-alias' })]),
      ),
    ).toThrow(/native/);
    expect(() =>
      decodeHookRegistrationLedger(
        ledger([
          entry(),
          entry({
            ownerId: 'otherOwner',
            provider: 'cursor',
            destinationRel: '.cursor/hooks.json',
            native: { event: 'stop', matcher: null, command: 'decision-stop-check.sh' },
          }),
        ]),
      ),
    ).toThrow(/conflicting owners/);
  });

  it('rejects physical aliases when provider scopes share one destination', () => {
    const codex = entry({
      provider: 'codex',
      destinationRel: '.codex/hooks.json',
      native: { event: 'Stop', matcher: null, command: '.codex/hooks/decision-stop-check.mjs' },
    });
    expect(() =>
      decodeHookRegistrationLedger(ledger([codex, { ...codex, installScope: 'overlay' }])),
    ).toThrow(/ownership/);
    expect(() =>
      decodeHookRegistrationLedger(
        ledger([
          codex,
          {
            ...codex,
            registrationId: 'agent-hooks:decision-stop-alias',
            installScope: 'overlay',
          },
        ]),
      ),
    ).toThrow(/native/);
  });
});

describe('hook registration ownership ledger parser limits', () => {
  it('rejects duplicate decoded JSON keys at every object depth', () => {
    expect(() =>
      decodeHookRegistrationLedger(
        '{"schemaVersion":2,"schemaVersion":1,"kind":"agent_hook_registration_ownership","entries":[]}',
      ),
    ).toThrow(/duplicate object field "schemaVersion"/);
    expect(() =>
      decodeHookRegistrationLedger(
        '{"schemaVersion":1,"kind":"wrong","k\\u0069nd":"agent_hook_registration_ownership","entries":[]}',
      ),
    ).toThrow(/duplicate object field "kind"/);

    const nestedDuplicate = ledger([entry()]).replace(
      '"event":"Stop"',
      '"event":"Other","ev\\u0065nt":"Stop"',
    );
    expect(() => decodeHookRegistrationLedger(nestedDuplicate)).toThrow(
      /duplicate object field "event"/,
    );
  });

  it('bounds bytes and entry count before accepting ownership', () => {
    expect(() => decodeHookRegistrationLedger(' '.repeat(1024 * 1024 + 1))).toThrow(/limit/);
    expect(() =>
      decodeHookRegistrationLedger(
        ledger(
          Array.from({ length: 4097 }, (_, index) =>
            entry({
              registrationId: `agent-hooks:item-${index}`,
              native: { event: 'Stop', matcher: '', command: 'x' },
            }),
          ),
        ),
      ),
    ).toThrow();
  });

  it('gives every current registration a stable globally unique id', () => {
    const ids = Object.values(HOOK_REGISTRATIONS)
      .flat()
      .map(({ registrationId }) => registrationId);
    expect(ids).toHaveLength(9);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9._:-]*$/);
  });

  it('rejects malformed, fenced, and non-object JSON', () => {
    expect(() => decodeHookRegistrationLedger('{')).toThrow(/valid JSON/);
    expect(() => decodeHookRegistrationLedger('```json\n{}\n```')).toThrow(/valid JSON/);
    expect(() => decodeHookRegistrationLedger('null')).toThrow(/object/);
    expect(() => decodeHookRegistrationLedger('[]')).toThrow(/object/);
  });
});
