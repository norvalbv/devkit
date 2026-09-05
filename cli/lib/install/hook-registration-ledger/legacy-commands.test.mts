/** Prior spellings are HARDCODED, never derived from SUPERSEDED_HOOK_COMMANDS: a test that
 * recomputes the table only proves the table equals itself. sc-2563 was a string changing shape. */
import { describe, expect, it } from 'vitest';
import { stripReclaimedCommands } from './install-support.mts';
import {
  projectSupersededHookRegistrations,
  reconcileLegacyHookCommands,
} from './legacy-commands.mts';
import { HOOK_REGISTRATIONS, SUPERSEDED_HOOK_COMMANDS } from './registrations.mts';

const PKG = 'node_modules/@norvalbv/devkit';
const bins = ['search-tool-guard', 'search-tool-counter'];
const exts = ['.mjs', '.mts'];
const legacyRel = (bin, ext) => `${PKG}/gate-engine/search-tool/${bin}${ext}`;

// The 4 source-form prior spellings, in each provider's native projection.
const EXPECTED = {
  claude: exts.flatMap((e) => bins.map((b) => `node "$CLAUDE_PROJECT_DIR"/${legacyRel(b, e)}`)),
  codex: exts.flatMap((e) =>
    bins.map((b) => `node "$(git rev-parse --show-toplevel)"/${legacyRel(b, e)}`),
  ),
  cursor: exts.flatMap((e) => bins.map((b) => legacyRel(b, e))),
};

const claudeDoc = (command) => ({
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          { type: 'command', command },
          { type: 'command', command: 'mine' },
        ],
      },
    ],
  },
});
const entryFor = (command) => ({
  registrationId: 'search-steering:pre-bash',
  ownerId: 'searchSteering',
  provider: 'claude',
  installScope: 'shared',
  destinationRel: '.claude/settings.json',
  native: { event: 'PreToolUse', matcher: 'Bash', command },
});
const LEGACY = EXPECTED.claude[0];
const CURRENT = HOOK_REGISTRATIONS.searchSteering[0].command;
/** One hook event's list, read back off a reconciled document without asserting its shape. */
const eventOf = (document, event) => {
  const hooks = JSON.parse(JSON.stringify(document)).hooks;
  return Object.hasOwn(hooks, event) ? hooks[event] : undefined;
};
const occurrences = (document, needle) =>
  JSON.stringify(document).split(JSON.stringify(needle).slice(1, -1)).length - 1;
/** Reconcile the ledger, then apply the strip its rows authorise — what an install does in order. */
const reconcile = (document, entries, provider = 'claude', rel = '.claude/settings.json') => {
  const legacy = reconcileLegacyHookCommands(entries, provider, rel);
  const retired = stripReclaimedCommands(document, provider, legacy.stripped);
  return { ...legacy, document: retired.document, documentChanged: retired.changed };
};

describe('projectSupersededHookRegistrations', () => {
  for (const [provider, expected] of Object.entries(EXPECTED)) {
    it(`projects every prior ${provider} spelling`, () => {
      const commands = projectSupersededHookRegistrations(provider).map((p) => p.legacyCommand);
      expect(commands.sort()).toEqual([...expected].sort());
    });
  }

  it('pairs each prior spelling with the CURRENT one, which carries dist/', () => {
    for (const projection of projectSupersededHookRegistrations('claude')) {
      expect(projection.legacyCommand).not.toContain('/dist/gate-engine/');
      expect(projection.native.command).toContain('/dist/gate-engine/');
      expect(projection.ownerId).toBe('searchSteering');
    }
  });

  it('every row names a live registration, for every provider', () => {
    const live = new Set(
      Object.values(HOOK_REGISTRATIONS).flatMap((rs) => rs.map((r) => r.registrationId)),
    );
    for (const row of SUPERSEDED_HOOK_COMMANDS) expect(live.has(row.registrationId)).toBe(true);
    for (const provider of ['claude', 'codex', 'cursor'])
      expect(() => projectSupersededHookRegistrations(provider)).not.toThrow();
  });

  it('never claims a prior spelling twice, and never one equal to the current command', () => {
    for (const provider of ['claude', 'codex', 'cursor']) {
      const commands = projectSupersededHookRegistrations(provider).map((p) => p.legacyCommand);
      expect(new Set(commands).size).toBe(commands.length);
      for (const p of projectSupersededHookRegistrations(provider))
        expect(p.legacyCommand).not.toBe(p.native.command);
    }
  });
});

describe('reconcileLegacyHookCommands', () => {
  it('state A — ledger and document both stale: repairs the row and strips the string', () => {
    const result = reconcile(claudeDoc(LEGACY), [entryFor(LEGACY)]);
    expect(result.ledgerChanged).toBe(true);
    expect(result.documentChanged).toBe(true);
    expect(result.entries[0].native.command).toBe(CURRENT);
    expect(JSON.stringify(result.document)).not.toContain('search-tool-guard.mjs"');
    expect(JSON.stringify(result.document)).toContain('mine');
    // Both shipped spellings, at the location the row names — see the multi-spelling case below.
    expect(result.stripped).toEqual(
      ['.mjs', '.mts'].map((ext) => ({
        event: 'PreToolUse',
        matcher: 'Bash',
        command: LEGACY.replace('.mjs', ext),
      })),
    );
  });

  it('state B — hand-patched document: repairs the row and leaves the document alone', () => {
    const document = claudeDoc(CURRENT);
    const result = reconcile(document, [entryFor(LEGACY)]);
    expect(result.ledgerChanged).toBe(true);
    expect(result.documentChanged).toBe(false);
    expect(result.document).toBe(document);
    expect(result.entries[0].native.command).toBe(CURRENT);
  });

  it('state C — no ledger: an exact no-op', () => {
    const document = claudeDoc(LEGACY);
    const result = reconcile(document, []);
    expect(result).toMatchObject({ documentChanged: false, ledgerChanged: false });
    expect(result.stripped).toEqual([]);
    expect(result.document).toBe(document);
  });

  it('recovers from a crash between the ledger and document writes', () => {
    // Crash after publishPlan's first ledger write: row repaired, document not. Without the "or the
    // current command" arm nothing strips it and installProjected appends beside a dead, unowned one.
    const result = reconcile(claudeDoc(LEGACY), [entryFor(CURRENT)]);
    expect(result.ledgerChanged).toBe(false);
    expect(result.documentChanged).toBe(true);
    expect(JSON.stringify(result.document)).not.toContain('gate-engine/search-tool');
  });

  it.each(['.mjs', '.mts'])('recovers a crashed %s document from a current ledger row', (ext) => {
    // A registration can have shipped MORE THAN ONE prior spelling. A row already carrying the
    // current command names none of them, so recovery must strip every one at that location.
    const legacy = LEGACY.replace('.mjs', ext);
    const result = reconcile(claudeDoc(legacy), [entryFor(CURRENT)]);
    expect(result.ledgerChanged).toBe(false);
    expect(result.documentChanged).toBe(true);
    expect(occurrences(result.document, legacy)).toBe(0);
  });

  it('leaves a look-alike command with no ledger row untouched', () => {
    const document = claudeDoc(LEGACY);
    const result = reconcile(document, [{ ...entryFor(LEGACY), ownerId: 'someoneElse' }]);
    expect(result.documentChanged).toBe(false);
    expect(result.document).toBe(document);
  });

  it('mutates neither the document nor the entries it is given', () => {
    const document = claudeDoc(LEGACY);
    const snapshot = JSON.stringify(document);
    const entries = [entryFor(LEGACY)];
    reconcile(document, entries);
    expect(JSON.stringify(document)).toBe(snapshot);
    expect(entries[0].native.command).toBe(LEGACY);
  });
});

describe('reconcileLegacyHookCommands — strip blast radius', () => {
  it('strips every copy of a spelling its ledger row owns, converging on one', () => {
    // A merge resolution can leave devkit's own command in the file twice. Both are devkit's, one
    // row owns them, and installProjectedHookRegistrations re-adds exactly one afterwards.
    const document = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: LEGACY }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: LEGACY }] },
        ],
      },
    };
    const result = reconcile(document, [entryFor(LEGACY)]);
    expect(result.documentChanged).toBe(true);
    expect(JSON.stringify(result.document)).not.toContain('search-tool-guard');
  });

  it('does not reach into an event its ledger row does not name', () => {
    // devkit's row vouches for PreToolUse/Bash and nothing else, so the identically-spelled Stop
    // copy is the CONSUMER's — non-devkit-asset-collision-preserve says leave it.
    const document = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: LEGACY }] }],
        Stop: [{ hooks: [{ type: 'command', command: LEGACY }] }],
      },
    };
    const result = reconcile(document, [entryFor(LEGACY)]);
    expect(eventOf(result.document, 'PreToolUse')).toBeUndefined();
    expect(occurrences(eventOf(result.document, 'Stop'), LEGACY)).toBe(1);
    expect(occurrences(result.document, LEGACY)).toBe(1);
  });

  it('does not reach into a matcher group its ledger row does not name', () => {
    const document = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: LEGACY }] },
          { matcher: 'Edit', hooks: [{ type: 'command', command: LEGACY }] },
        ],
      },
    };
    const result = reconcile(document, [entryFor(LEGACY)]);
    expect(eventOf(result.document, 'PreToolUse').map((g) => g.matcher)).toEqual(['Edit']);
    expect(occurrences(result.document, LEGACY)).toBe(1);
  });

  it('strips a cursor entry only under the event its ledger row names', () => {
    // Cursor keeps a FLAT list per event, so the nested matcher-group walk never runs — the event
    // narrowing is the only thing standing between devkit and a consumer's identical command.
    const cursorLegacy =
      'node_modules/@norvalbv/devkit/gate-engine/search-tool/search-tool-guard.mjs';
    const document = {
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: cursorLegacy }],
        afterFileEdit: [{ command: cursorLegacy }],
      },
    };
    const entries = [
      {
        registrationId: 'search-steering:pre-bash',
        ownerId: 'searchSteering',
        provider: 'cursor',
        installScope: 'shared',
        destinationRel: '.cursor/hooks.json',
        native: { event: 'beforeShellExecution', matcher: null, command: cursorLegacy },
      },
    ];
    const result = reconcile(document, entries, 'cursor', '.cursor/hooks.json');
    expect(eventOf(result.document, 'beforeShellExecution')).toBeUndefined();
    expect(occurrences(result.document, cursorLegacy)).toBe(1);
  });
});
