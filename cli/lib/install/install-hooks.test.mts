/**
 * install-hooks tests — the agent-hook registration installer (Claude settings.json +
 * Cursor hooks.json). All IO runs against a real tmp repo (à la install-fallow.test.mjs).
 * console.log is silenced. Covers: merge shape, both surfaces, idempotency (re-run does not
 * duplicate), preservation of a foreign hook, the Cursor event mapping, and removal.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  projectHookRegistrations,
  writeHookRegistrationLedger,
} from './hook-registration-ledger/lifecycle.mts';
import {
  checkHookRegistrations,
  installHookRegistrations,
  removeHookRegistrations,
  syncHookScripts,
} from './install-hooks.mts';

let roots = [];
function tmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'hooks-'));
  roots.push(root);
  return root;
}
const claude = (root) => JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
const codex = (root) => JSON.parse(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8'));
const cursor = (root) => JSON.parse(readFileSync(join(root, '.cursor', 'hooks.json'), 'utf8'));
const ledgerPath = (root) => join(root, '.devkit', 'agent-hook-registrations-manifest.json');
const ledger = (root) => JSON.parse(readFileSync(ledgerPath(root), 'utf8'));
// Every command across every Claude event/matcher group, flattened.
function claudeCommands(root) {
  return Object.values(claude(root).hooks).flatMap((gs) =>
    gs.flatMap((g) => g.hooks.map((h) => h.command)),
  );
}
function writeRetiredFallowHooks(root) {
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, '.cursor'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-gate.sh"',
              },
              { type: 'command', command: 'echo mine' },
            ],
          },
        ],
      },
    }),
  );
  writeFileSync(
    join(root, '.cursor', 'hooks.json'),
    JSON.stringify({
      version: 1,
      hooks: {
        beforeShellExecution: [
          { command: '.cursor/hooks/fallow-gate.sh' },
          { command: 'echo mine' },
        ],
      },
    }),
  );
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

describe('installHookRegistrations', () => {
  it('registers the decisions guard on native pre-edit events for both surfaces', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['decisions']);

    const preToolUse = claude(root).hooks.PreToolUse[0];
    expect(preToolUse.matcher).toBe('Edit|Write|MultiEdit|Delete');
    expect(preToolUse.hooks[0].command).toContain('decision-edit-guard.mjs');

    expect(cursor(root).hooks.preToolUse).toEqual([
      {
        command: '.cursor/hooks/decision-edit-guard.mjs',
        matcher: 'Write|Delete',
        failClosed: false,
      },
      {
        command: '.cursor/hooks/decision-scope-brief.mjs',
        matcher: 'Write',
        failClosed: false,
      },
    ]);
  });

  it('checks a Cursor-only decisions registration without requiring Claude settings', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['decisions'], { targets: ['cursor'] });
    expect(existsSync(join(root, '.claude/settings.json'))).toBe(false);
    expect(checkHookRegistrations(root, ['decisions'], { targets: ['cursor'] }).ok).toBe(true);
  });

  it('doctor check rejects a decisions command wired to the wrong Claude matcher', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['decisions'], { targets: ['claude'] });
    const settings = claude(root);
    settings.hooks.PreToolUse[0].matcher = 'Bash';
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify(settings));
    expect(checkHookRegistrations(root, ['decisions'], { targets: ['claude'] }).ok).toBe(false);
  });

  it('writes native Claude, Codex, and Cursor registrations plus exact ownership', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['searchSteering']);
    const cmds = claudeCommands(root);
    expect(cmds).toHaveLength(2);
    // dist/, unconditionally: this string is handed to the CONSUMER's shell, where only the built
    // .mjs exists (package.json files: ["dist"]) and where Node refuses to type-strip a .mts at all.
    expect(cmds).toContain(
      'node "$CLAUDE_PROJECT_DIR"/node_modules/@norvalbv/devkit/dist/gate-engine/search-tool/search-tool-guard.mjs',
    );
    expect(cmds).toContain(
      'node "$CLAUDE_PROJECT_DIR"/node_modules/@norvalbv/devkit/dist/gate-engine/search-tool/search-tool-counter.mjs',
    );
    // Cursor mirror maps Bash PreToolUse→beforeShellExecution, PostToolUse→afterShellExecution.
    const cur = cursor(root).hooks;
    expect(cur.beforeShellExecution).toHaveLength(1);
    expect(cur.afterShellExecution).toHaveLength(1);
    const codexHooks = codex(root).hooks;
    expect(codexHooks.PreToolUse[0].matcher).toBe('Bash');
    expect(codexHooks.PreToolUse[0].hooks[0].command).toContain('$(git rev-parse --show-toplevel)');
    expect(ledger(root).entries).toHaveLength(6);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('trust it with /hooks'));
  });

  it('registers all six agentHooks across the correct Claude events', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['agentHooks']);
    const h = claude(root).hooks;
    expect(h.UserPromptSubmit).toHaveLength(1);
    expect(h.Stop[0].hooks).toHaveLength(3); // decision + lint + knip
    expect(h.PreCompact).toHaveLength(1);
    // Cursor: Stop→stop (3), Edit|Write→afterFileEdit (1), PreCompact→preCompact (1); UserPromptSubmit dropped.
    const cur = cursor(root).hooks;
    expect(cur.stop).toHaveLength(3);
    expect(cur.afterFileEdit).toHaveLength(1);
    expect(cur.preCompact).toHaveLength(1);
    expect(cur.UserPromptSubmit).toBeUndefined();
    expect(codex(root).hooks.Stop[0]).not.toHaveProperty('matcher');
  });

  it('is byte-idempotent across provider configs and the ledger', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['searchSteering', 'agentHooks']);
    const first = claudeCommands(root).length;
    const paths = [
      join(root, '.claude', 'settings.json'),
      join(root, '.codex', 'hooks.json'),
      join(root, '.cursor', 'hooks.json'),
      ledgerPath(root),
    ];
    const bytes = paths.map((path) => readFileSync(path, 'utf8'));
    installHookRegistrations(root, ['searchSteering', 'agentHooks']);
    expect(claudeCommands(root).length).toBe(first);
    expect(first).toBe(8);
    expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(bytes);
  });

  it.each(['codex', 'cursor'])(
    'transfers same-destination ownership across %s mode changes',
    (provider) => {
      const root = tmpRepo();
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      installHookRegistrations(root, ['agentHooks'], { targets: [provider] });
      installHookRegistrations(root, ['agentHooks'], { targets: [provider], overlay: true });
      expect(
        checkHookRegistrations(root, ['agentHooks'], { targets: [provider], overlay: true }).ok,
      ).toBe(true);
      expect(ledger(root).entries.every((entry) => entry.installScope === 'overlay')).toBe(true);

      installHookRegistrations(root, ['agentHooks'], { targets: [provider] });
      expect(checkHookRegistrations(root, ['agentHooks'], { targets: [provider] }).ok).toBe(true);
      expect(ledger(root).entries.every((entry) => entry.installScope === 'shared')).toBe(true);
    },
  );

  it('recovers when added ownership was published before its provider config', () => {
    const root = tmpRepo();
    const projected = projectHookRegistrations(['agentHooks'], ['codex'], 'shared');
    writeHookRegistrationLedger(root, {
      schemaVersion: 1,
      kind: 'agent_hook_registration_ownership',
      entries: [...projected.entries],
    });

    installHookRegistrations(root, ['agentHooks'], { targets: ['codex'] });
    expect(checkHookRegistrations(root, ['agentHooks'], { targets: ['codex'] }).ok).toBe(true);
  });

  it('recovers when removed config was published before final ownership', () => {
    const root = tmpRepo();
    const finalRoot = tmpRepo();
    installHookRegistrations(root, ['searchSteering', 'agentHooks'], { targets: ['codex'] });
    installHookRegistrations(finalRoot, ['agentHooks'], { targets: ['codex'] });
    writeFileSync(
      join(root, '.codex', 'hooks.json'),
      readFileSync(join(finalRoot, '.codex', 'hooks.json')),
    );

    installHookRegistrations(root, ['agentHooks'], { targets: ['codex'] });
    expect(checkHookRegistrations(root, ['agentHooks'], { targets: ['codex'] }).ok).toBe(true);
    expect(ledger(root).entries.every((entry) => entry.ownerId === 'agentHooks')).toBe(true);
  });

  it('preserves a foreign (non-devkit) hook command on merge', () => {
    const root = tmpRepo();
    // Install once (creates the dir + file), inject a foreign command, then re-run.
    installHookRegistrations(root, ['agentHooks']);
    const s = claude(root);
    s.hooks.Stop[0].hooks.push({ type: 'command', command: 'echo mine' });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(s));
    installHookRegistrations(root, ['agentHooks']);
    expect(claudeCommands(root)).toContain('echo mine');
  });

  it('preserves consumer-owned commands stored under conventional hook directories', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['decisions']);
    const claudeSettings = claude(root);
    claudeSettings.hooks.PreToolUse[0].hooks.push({
      type: 'command',
      command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/my-own-guard.mjs"',
    });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(claudeSettings));
    const cursorSettings = cursor(root);
    cursorSettings.hooks.preToolUse.push({
      command: '.cursor/hooks/my-own-guard.mjs',
      matcher: 'Write',
      failClosed: true,
    });
    writeFileSync(join(root, '.cursor', 'hooks.json'), JSON.stringify(cursorSettings));

    installHookRegistrations(root, ['decisions']);

    expect(claudeCommands(root)).toContain(
      'node "$CLAUDE_PROJECT_DIR/.claude/hooks/my-own-guard.mjs"',
    );
    expect(cursor(root).hooks.preToolUse).toContainEqual({
      command: '.cursor/hooks/my-own-guard.mjs',
      matcher: 'Write',
      failClosed: true,
    });
  });

  it('reclaims retired pre-ledger commands while preserving consumer hooks', () => {
    const root = tmpRepo();
    writeRetiredFallowHooks(root);

    installHookRegistrations(root, ['fallow'], {
      targets: ['claude', 'cursor'],
      legacyOwnedComponentIds: ['fallow'],
    });

    expect(claudeCommands(root)).toContain('echo mine');
    expect(claudeCommands(root)).toContain(
      'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-staged-gate.sh"',
    );
    expect(claudeCommands(root)).not.toContain(
      'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-gate.sh"',
    );
    const cursorCommands = Object.values(cursor(root).hooks)
      .flat()
      .map((entry) => entry.command);
    expect(cursorCommands).toContain('echo mine');
    expect(cursorCommands).toContain('.cursor/hooks/fallow-staged-gate.sh');
    expect(cursorCommands).not.toContain('.cursor/hooks/fallow-gate.sh');
  });

  it('reclaims a retired fallow command after fallow was deselected', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['agentHooks'], { targets: ['claude'] });
    const settings = claude(root);
    settings.hooks.PreToolUse = [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command:
              'FALLOW_GATE_COMMIT_ONLY=1 bash "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-gate.sh"',
          },
        ],
      },
    ];
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(settings));

    const stale = checkHookRegistrations(root, ['agentHooks'], { targets: ['claude'] });
    expect(stale.ok).toBe(false);
    expect(stale.missing).toContain('claude:retired-registration');

    installHookRegistrations(root, ['agentHooks'], {
      targets: ['claude'],
      legacyOwnedComponentIds: ['agentHooks'],
    });

    expect(claudeCommands(root)).not.toContain(
      'FALLOW_GATE_COMMIT_ONLY=1 bash "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-gate.sh"',
    );
    expect(checkHookRegistrations(root, ['agentHooks'], { targets: ['claude'] }).ok).toBe(true);
  });

  it('reclaims a retired fallow command when no hook component remains selected', () => {
    const root = tmpRepo();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command',
                  command:
                    'FALLOW_GATE_COMMIT_ONLY=1 bash "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-gate.sh"',
                },
              ],
            },
          ],
        },
      }),
    );

    expect(checkHookRegistrations(root, [], { targets: ['claude'] }).missing).toContain(
      'claude:retired-registration',
    );

    installHookRegistrations(root, [], { targets: ['claude'] });

    expect(checkHookRegistrations(root, [], { targets: ['claude'] }).ok).toBe(true);
  });

  it('does not infer exact unledgered registrations without explicit legacy authority', () => {
    const root = tmpRepo();
    const targets = ['claude', 'cursor'];
    installHookRegistrations(root, ['searchSteering'], { targets });
    rmSync(ledgerPath(root));
    expect(() => installHookRegistrations(root, ['searchSteering'], { targets })).toThrow(
      /hook registration conflicts require resolution/,
    );
    expect(existsSync(ledgerPath(root))).toBe(false);

    installHookRegistrations(root, ['searchSteering'], {
      targets,
      legacyOwnedComponentIds: ['searchSteering'],
    });
    expect(
      ledger(root)
        .entries.map((entry) => entry.provider)
        .sort(),
    ).toEqual(['claude', 'claude', 'cursor', 'cursor']);
  });

  it('surfaces an exact unledgered Codex collision without claiming it', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['searchSteering'], { targets: ['codex'] });
    const before = readFileSync(join(root, '.codex', 'hooks.json'), 'utf8');
    rmSync(ledgerPath(root));

    expect(() =>
      installHookRegistrations(root, ['searchSteering'], { targets: ['codex'] }),
    ).toThrow(/hook registration conflicts require resolution/);
    expect(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8')).toBe(before);
    expect(existsSync(ledgerPath(root))).toBe(false);
  });

  it('skips tracked Codex and Cursor overlay configs', () => {
    const root = tmpRepo();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    for (const provider of ['codex', 'cursor']) {
      mkdirSync(join(root, `.${provider}`));
      writeFileSync(join(root, `.${provider}`, 'hooks.json'), '{"foreign":true}\n');
    }
    execFileSync('git', ['add', '.codex/hooks.json', '.cursor/hooks.json'], { cwd: root });
    const result = installHookRegistrations(root, ['searchSteering'], {
      overlay: true,
      targets: ['codex', 'cursor'],
    });
    expect(result.wrote).toEqual([]);
    expect(codex(root)).toEqual({ foreign: true });
    expect(cursor(root)).toEqual({ foreign: true });
    expect(existsSync(ledgerPath(root))).toBe(false);
  });

  it('rejects a JSON-null provider config without replacing it or publishing ownership', () => {
    const root = tmpRepo();
    mkdirSync(join(root, '.codex'));
    writeFileSync(join(root, '.codex', 'hooks.json'), 'null\n');
    expect(() =>
      installHookRegistrations(root, ['searchSteering'], { targets: ['codex'] }),
    ).toThrow(/must contain a provider hook object/);
    expect(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8')).toBe('null\n');
    expect(existsSync(ledgerPath(root))).toBe(false);
  });
});

describe('checkHookRegistrations', () => {
  it('reports ok when present, missing after removal', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['searchSteering']);
    expect(checkHookRegistrations(root, ['searchSteering']).ok).toBe(true);
    removeHookRegistrations(root);
    const after = checkHookRegistrations(root, ['searchSteering']);
    expect(after.ok).toBe(false);
    expect(after.missing).toHaveLength(6);
  });

  it('checks every requested provider', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['searchSteering']);
    rmSync(join(root, '.codex', 'hooks.json'));
    expect(checkHookRegistrations(root, ['searchSteering'], { targets: ['claude'] }).ok).toBe(true);
    const all = checkHookRegistrations(root, ['searchSteering']);
    expect(all.ok).toBe(false);
    expect(all.missing.every((item) => item.startsWith('codex:'))).toBe(true);
  });

  it('recognizes exact legacy registrations only with explicit legacy authority', () => {
    const root = tmpRepo();
    const targets = ['claude', 'cursor'];
    installHookRegistrations(root, ['searchSteering'], { targets });
    rmSync(ledgerPath(root));

    expect(checkHookRegistrations(root, ['searchSteering'], { targets }).ok).toBe(false);
    expect(
      checkHookRegistrations(root, ['searchSteering'], {
        targets,
        legacyOwnedComponentIds: ['searchSteering'],
      }).ok,
    ).toBe(true);
  });
});

describe('removeHookRegistrations', () => {
  it('strips devkit hooks but leaves a foreign one', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['agentHooks']);
    const s = claude(root);
    s.hooks.Stop[0].hooks.push({ type: 'command', command: 'echo .claude/hooks/mine.sh' });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(s));
    removeHookRegistrations(root);
    const cmds = claudeCommands(root);
    expect(cmds).toEqual(['echo .claude/hooks/mine.sh']);
  });

  it('preserves pre-ledger configs unless exact legacy ownership is explicitly supplied', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['searchSteering']);
    rmSync(ledgerPath(root));
    removeHookRegistrations(root);
    expect(claudeCommands(root)).toHaveLength(2);

    removeHookRegistrations(root, { legacyOwnedComponentIds: ['searchSteering'] });
    expect(claudeCommands(root)).toEqual([]);
    expect(Object.keys(cursor(root).hooks)).toEqual([]);
    expect(Object.keys(codex(root).hooks)).toHaveLength(2);
    expect(existsSync(ledgerPath(root))).toBe(false);
  });

  it('reclaims retired pre-ledger commands during explicitly authorized removal', () => {
    const root = tmpRepo();
    writeRetiredFallowHooks(root);

    removeHookRegistrations(root, {
      targets: ['claude', 'cursor'],
      legacyOwnedComponentIds: ['fallow'],
    });

    expect(claudeCommands(root)).toEqual(['echo mine']);
    expect(cursor(root).hooks.beforeShellExecution).toEqual([{ command: 'echo mine' }]);
    expect(existsSync(ledgerPath(root))).toBe(false);
  });

  it('does not strip consumer commands merely because they live in agent hook directories', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['decisions']);
    const claudeSettings = claude(root);
    claudeSettings.hooks.PreToolUse[0].hooks.push({
      type: 'command',
      command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/my-own-guard.mjs"',
    });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(claudeSettings));
    const cursorSettings = cursor(root);
    cursorSettings.hooks.preToolUse.push({ command: '.cursor/hooks/my-own-guard.mjs' });
    writeFileSync(join(root, '.cursor', 'hooks.json'), JSON.stringify(cursorSettings));

    removeHookRegistrations(root);

    expect(claudeCommands(root)).toContain(
      'node "$CLAUDE_PROJECT_DIR/.claude/hooks/my-own-guard.mjs"',
    );
    expect(cursor(root).hooks.preToolUse).toContainEqual({
      command: '.cursor/hooks/my-own-guard.mjs',
    });
  });

  it('no-ops cleanly when no settings exist', () => {
    const root = tmpRepo();
    expect(() => removeHookRegistrations(root)).not.toThrow();
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false);
  });

  it('preserves an unsafe provider-config symlink and publishes no ownership', () => {
    const root = tmpRepo();
    const foreign = join(root, 'foreign-hooks.json');
    writeFileSync(foreign, '{"foreign":true}\n');
    mkdirSync(join(root, '.cursor'));
    symlinkSync(foreign, join(root, '.cursor', 'hooks.json'));
    installHookRegistrations(root, ['searchSteering'], { targets: ['cursor'] });
    expect(readFileSync(foreign, 'utf8')).toBe('{"foreign":true}\n');
    expect(existsSync(ledgerPath(root))).toBe(false);
  });
});

// syncHookScripts copies the bundled hook FILES + writes .devkit/agent-hooks-manifest.json (sha256),
// registration-free. `--only` is the incremental per-hook adoption path (add one devkit-owned hook at a
// time); `--targets` limits which surfaces get a hooks dir. Source = the real agents-hooks/ bundle.
describe('syncHookScripts --only / --targets', () => {
  const manifest = (root) =>
    JSON.parse(readFileSync(join(root, '.devkit', 'agent-hooks-manifest.json'), 'utf8'));
  const hookExists = (root, name, surface = 'claude') =>
    existsSync(join(root, `.${surface}`, 'hooks', name));

  it('--only syncs just the named hook + a 1-entry manifest, leaving the rest unsynced', () => {
    const root = tmpRepo();
    syncHookScripts(root, { only: ['decision-stop-check.sh'], targets: ['claude'] });
    expect(hookExists(root, 'decision-stop-check.sh')).toBe(true);
    expect(hookExists(root, 'lint-check.sh')).toBe(false);
    expect(hookExists(root, 'knip-check.sh')).toBe(false);
    expect(Object.keys(manifest(root).files)).toEqual(['decision-stop-check.sh']);
  });

  it('--targets claude does NOT create a .cursor/hooks tree', () => {
    const root = tmpRepo();
    syncHookScripts(root, { only: ['decision-stop-check.sh'], targets: ['claude'] });
    expect(existsSync(join(root, '.cursor', 'hooks'))).toBe(false);
    expect(manifest(root).targets).toEqual(['claude']);
  });

  it('throws on an --only name devkit does not ship (typo guard)', () => {
    const root = tmpRepo();
    expect(() => syncHookScripts(root, { only: ['no-such-hook.sh'], targets: ['claude'] })).toThrow(
      /no hook named/,
    );
  });

  it('--dry-run writes nothing (no files, no manifest)', () => {
    const root = tmpRepo();
    syncHookScripts(root, { only: ['decision-stop-check.sh'], targets: ['claude'], dryRun: true });
    expect(hookExists(root, 'decision-stop-check.sh')).toBe(false);
    expect(existsSync(join(root, '.devkit', 'agent-hooks-manifest.json'))).toBe(false);
  });

  it('--only is additive: a second --only ADDS to the manifest, not replaces it', () => {
    const root = tmpRepo();
    syncHookScripts(root, { only: ['decision-stop-check.sh'], targets: ['claude'] });
    syncHookScripts(root, { only: ['strategic-compactor.sh'], targets: ['claude'] });
    expect(Object.keys(manifest(root).files).sort()).toEqual([
      'decision-stop-check.sh',
      'strategic-compactor.sh',
    ]);
    expect(hookExists(root, 'decision-stop-check.sh')).toBe(true);
    expect(hookExists(root, 'strategic-compactor.sh')).toBe(true);
  });

  it('a full sync (no --only) writes all bundled hooks + a full manifest', () => {
    const root = tmpRepo();
    syncHookScripts(root, { targets: ['claude'] });
    const keys = Object.keys(manifest(root).files);
    expect(keys).toContain('decision-stop-check.sh');
    expect(keys.length).toBeGreaterThanOrEqual(6);
  });

  it('exact desired reconciliation prunes a previously Devkit-owned decisions hook', () => {
    const root = tmpRepo();
    syncHookScripts(root, {
      desired: ['decision-edit-guard.mjs'],
      targets: ['claude'],
    });
    expect(hookExists(root, 'decision-edit-guard.mjs')).toBe(true);

    syncHookScripts(root, { desired: ['lint-check.sh'], targets: ['claude'] });
    expect(hookExists(root, 'decision-edit-guard.mjs')).toBe(false);
    expect(hookExists(root, 'lint-check.sh')).toBe(true);
    expect(Object.keys(manifest(root).files)).toEqual(['lint-check.sh']);
  });

  it('preserves a tracked hook when exact desired reconciliation drops it', () => {
    const root = tmpRepo();
    const oldHook = '.claude/hooks/decision-edit-guard.mjs';
    syncHookScripts(root, { desired: ['decision-edit-guard.mjs'], targets: ['claude'] });

    syncHookScripts(root, {
      desired: ['lint-check.sh'],
      targets: ['claude'],
      skipTracked: (rel) => rel === oldHook,
    });

    expect(existsSync(join(root, oldHook))).toBe(true);
  });

  it('preserves a modified hook when exact desired reconciliation drops it', () => {
    const root = tmpRepo();
    const oldHook = join(root, '.claude/hooks/decision-edit-guard.mjs');
    syncHookScripts(root, { desired: ['decision-edit-guard.mjs'], targets: ['claude'] });
    writeFileSync(oldHook, 'consumer edit');

    syncHookScripts(root, { desired: ['lint-check.sh'], targets: ['claude'] });

    expect(readFileSync(oldHook, 'utf8')).toBe('consumer edit');
  });

  it.each(['directory', 'symlink'])('preserves a stale hook %s collision', (kind) => {
    const root = tmpRepo();
    const oldHook = join(root, '.claude/hooks/decision-edit-guard.mjs');
    syncHookScripts(root, { desired: ['decision-edit-guard.mjs'], targets: ['claude'] });
    rmSync(oldHook);
    if (kind === 'directory') mkdirSync(oldHook);
    else {
      const foreign = join(root, 'foreign-hook.mjs');
      writeFileSync(foreign, 'foreign');
      symlinkSync(foreign, oldHook);
    }

    expect(() =>
      syncHookScripts(root, { desired: ['lint-check.sh'], targets: ['claude'] }),
    ).not.toThrow();
    expect(
      kind === 'directory' ? lstatSync(oldHook).isDirectory() : lstatSync(oldHook).isSymbolicLink(),
    ).toBe(true);
  });
});

/** A bare command change is not a no-op for existing consumers — the stale ledger row goes
 * `untrusted` and installHookRegistrations THROWS. These cover the pipeline slot, not the function. */
describe('superseded hook commands', () => {
  const DISTLESS = ['/dist/gate-engine/', '/gate-engine/'];
  const RELS = ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json'];
  const downgrade = (text) => text.replaceAll(DISTLESS[0], DISTLESS[1]);

  /** Install the CURRENT registrations, then rewind the document and/or ledger to the prior form. */
  function seed(root, { document = 'legacy', manifest = 'legacy' } = {}) {
    installHookRegistrations(root, ['searchSteering']);
    if (document === 'legacy')
      for (const rel of RELS)
        writeFileSync(join(root, rel), downgrade(readFileSync(join(root, rel), 'utf8')));
    if (manifest === 'legacy')
      writeFileSync(ledgerPath(root), downgrade(readFileSync(ledgerPath(root), 'utf8')));
  }
  const allCommands = (root) => RELS.map((rel) => readFileSync(join(root, rel), 'utf8')).join('\n');
  const ledgerCommands = (root) => ledger(root).entries.map((e) => e.native.command);

  it('state A — converges when the ledger and all three documents hold the prior spelling', () => {
    const root = tmpRepo();
    seed(root);
    expect(allCommands(root)).toContain('/gate-engine/search-tool/');
    expect(allCommands(root)).not.toContain('/dist/gate-engine/');

    expect(() => installHookRegistrations(root, ['searchSteering'])).not.toThrow();

    const text = allCommands(root);
    expect(text).not.toMatch(/devkit\/gate-engine\/search-tool/);
    expect(claudeCommands(root).filter((c) => c.includes('search-tool-guard.mjs'))).toHaveLength(1);
    for (const command of ledgerCommands(root)) expect(command).toContain('/dist/gate-engine/');
    expect(checkHookRegistrations(root, ['searchSteering']).ok).toBe(true);
  });

  it('is the guard on the migration itself: emptying the table reinstates the throw', () => {
    // A stale row the table does not name is exactly what an emptied table produces, so this needs
    // no mocking: delete SUPERSEDED_HOOK_COMMANDS and state A goes red instead of shipping green.
    const root = tmpRepo();
    seed(root);
    const stored = ledger(root);
    stored.entries = stored.entries.map((e) => ({
      ...e,
      native: { ...e.native, command: `${e.native.command}--unknown` },
    }));
    writeFileSync(ledgerPath(root), JSON.stringify(stored, null, 2));
    expect(() => installHookRegistrations(root, ['searchSteering'])).toThrow(
      /hook registration conflicts require resolution/,
    );
  });

  it('state B — a hand-patched document converges without being rewritten', () => {
    const fresh = tmpRepo();
    installHookRegistrations(fresh, ['searchSteering']);
    const expected = RELS.map((rel) => readFileSync(join(fresh, rel), 'utf8'));

    const root = tmpRepo();
    seed(root, { document: 'current' });
    expect(() => installHookRegistrations(root, ['searchSteering'])).not.toThrow();

    // Byte-identical: collapsing documentChanged into ledgerChanged would reformat these for nothing.
    RELS.forEach((rel, i) => expect(readFileSync(join(root, rel), 'utf8')).toBe(expected[i]));
    for (const command of ledgerCommands(root)) expect(command).toContain('/dist/gate-engine/');
  });

  it('leaves a consumer-owned look-alike command alone when no ledger vouches for it', () => {
    const root = tmpRepo();
    seed(root);
    rmSync(ledgerPath(root));
    installHookRegistrations(root, ['searchSteering'], { targets: ['claude'] });
    const cmds = claudeCommands(root);
    expect(cmds.some((c) => c.includes('/gate-engine/search-tool/search-tool-guard.mjs'))).toBe(
      true,
    );
    expect(
      cmds.some((c) => c.includes('/dist/gate-engine/search-tool/search-tool-guard.mjs')),
    ).toBe(true);
  });

  it('migrates before the scope transfer, so an overlay switch still converges', () => {
    const root = tmpRepo();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    seed(root);
    expect(() =>
      installHookRegistrations(root, ['searchSteering'], { targets: ['codex'], overlay: true }),
    ).not.toThrow();
    for (const entry of ledger(root).entries.filter((e) => e.provider === 'codex')) {
      expect(entry.installScope).toBe('overlay');
      expect(entry.native.command).toContain('/dist/gate-engine/');
    }
  });

  it('migrates before the removal pass, so deselecting searchSteering strands nothing', () => {
    const root = tmpRepo();
    seed(root);
    expect(() => installHookRegistrations(root, ['agentHooks'])).not.toThrow();
    expect(allCommands(root)).not.toContain('gate-engine/search-tool');
    expect(ledger(root).entries.some((e) => e.ownerId === 'searchSteering')).toBe(false);
  });

  it('removeHookRegistrations strips the prior spelling from every document', () => {
    // In this path removed.changed is false (the migration already took the string out), so the
    // write only happens if legacy.documentChanged is threaded into the plan.
    const root = tmpRepo();
    seed(root);
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      (() => {
        const doc = claude(root);
        doc.hooks.PreToolUse[0].hooks.push({ type: 'command', command: 'echo mine' });
        return JSON.stringify(doc, null, 2);
      })(),
    );

    removeHookRegistrations(root);

    expect(allCommands(root)).not.toContain('gate-engine/search-tool');
    expect(claudeCommands(root)).toContain('echo mine');
    expect(existsSync(ledgerPath(root))).toBe(false);
  });

  it('migrates the .mts prior spelling a source-context devkit wrote', () => {
    // The fleet holds TWO prior spellings, and downgrade() only produces .mjs — without this the
    // .mts half of SUPERSEDED_HOOK_COMMANDS is unit-projected but never actually migrated.
    const root = tmpRepo();
    seed(root);
    const toMts = (text) =>
      text.replaceAll(
        /gate-engine\/search-tool\/(search-tool-(?:guard|counter))\.mjs/g,
        'gate-engine/search-tool/$1.mts',
      );
    for (const rel of RELS)
      writeFileSync(join(root, rel), toMts(readFileSync(join(root, rel), 'utf8')));
    writeFileSync(ledgerPath(root), toMts(readFileSync(ledgerPath(root), 'utf8')));
    expect(allCommands(root)).toContain('search-tool-guard.mts');

    expect(() => installHookRegistrations(root, ['searchSteering'])).not.toThrow();

    expect(allCommands(root)).not.toContain('.mts');
    expect(claudeCommands(root).filter((c) => c.includes('search-tool-guard'))).toHaveLength(1);
    for (const command of ledgerCommands(root)) expect(command).toContain('/dist/gate-engine/');
  });

  it('migrates only the targeted provider, leaving the others reconcilable later', () => {
    // `devkit init --targets claude` is an ordinary shape. The untargeted providers keep their prior
    // spelling in BOTH document and ledger, and that mixed ledger must not make the next pass throw.
    const root = tmpRepo();
    seed(root);
    expect(() =>
      installHookRegistrations(root, ['searchSteering'], { targets: ['claude'] }),
    ).not.toThrow();
    expect(readFileSync(join(root, '.claude/settings.json'), 'utf8')).toContain(
      '/dist/gate-engine/',
    );
    for (const rel of ['.codex/hooks.json', '.cursor/hooks.json'])
      expect(readFileSync(join(root, rel), 'utf8')).not.toContain('/dist/gate-engine/');
    expect(ledgerCommands(root).filter((c) => c.includes('/dist/'))).toHaveLength(2);

    expect(() => installHookRegistrations(root, ['searchSteering'])).not.toThrow();
    for (const command of ledgerCommands(root)) expect(command).toContain('/dist/gate-engine/');
  });

  it('converges a codex row recorded under the other install scope', () => {
    // codex/cursor share ONE destinationRel across scopes, so an overlay-recorded row surfaces in a
    // shared pass. Migration must precede transferHookRegistrationScope, which is blind to it.
    const root = tmpRepo();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    installHookRegistrations(root, ['searchSteering'], { targets: ['codex'], overlay: true });
    const rel = '.codex/hooks.json';
    writeFileSync(join(root, rel), downgrade(readFileSync(join(root, rel), 'utf8')));
    writeFileSync(ledgerPath(root), downgrade(readFileSync(ledgerPath(root), 'utf8')));

    expect(() =>
      installHookRegistrations(root, ['searchSteering'], { targets: ['codex'] }),
    ).not.toThrow();

    expect(readFileSync(join(root, rel), 'utf8')).not.toContain('devkit/gate-engine');
    for (const entry of ledger(root).entries) {
      expect(entry.installScope).toBe('shared');
      expect(entry.native.command).toContain('/dist/gate-engine/');
    }
  });

  it('converges the Claude overlay surface, which is a different destination file', () => {
    // Claude alone splits by scope: .claude/settings.local.json, its own destinationRel and so its
    // own ledger row. A shared-only migration would leave every overlay consumer throwing.
    const root = tmpRepo();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    installHookRegistrations(root, ['searchSteering'], { targets: ['claude'], overlay: true });
    const rel = '.claude/settings.local.json';
    writeFileSync(join(root, rel), downgrade(readFileSync(join(root, rel), 'utf8')));
    writeFileSync(ledgerPath(root), downgrade(readFileSync(ledgerPath(root), 'utf8')));

    expect(() =>
      installHookRegistrations(root, ['searchSteering'], { targets: ['claude'], overlay: true }),
    ).not.toThrow();

    const text = readFileSync(join(root, rel), 'utf8');
    expect(text).not.toContain('devkit/gate-engine/search-tool');
    expect(text).toContain('/dist/gate-engine/search-tool/search-tool-guard.mjs');
    expect(
      checkHookRegistrations(root, ['searchSteering'], { targets: ['claude'], overlay: true }).ok,
    ).toBe(true);
  });

  it('converges a document holding the prior spelling twice', () => {
    // A merge resolution can leave devkit's own command duplicated. Both are devkit's and one row
    // owns them, so the pass must land on exactly one — not strip one and re-add beside the other.
    const root = tmpRepo();
    seed(root);
    const doc = claude(root);
    const group = doc.hooks.PreToolUse.find((g) => g.matcher === 'Bash');
    group.hooks.push({ ...group.hooks[0] });
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify(doc, null, 2));

    expect(() => installHookRegistrations(root, ['searchSteering'])).not.toThrow();

    expect(claudeCommands(root).filter((c) => c.includes('search-tool-guard'))).toHaveLength(1);
  });

  it('reports without a ledger file at all, rather than throwing', () => {
    // check used to pass a possibly-null ledger and now passes reconciled entries; the empty case
    // must stay equivalent, and an absent ledger is normal for a never-registered repo.
    const root = tmpRepo();
    seed(root);
    rmSync(ledgerPath(root));
    const result = checkHookRegistrations(root, ['searchSteering']);
    expect(result.ok).toBe(false);
    expect(result.missing.some((m) => m.endsWith(':superseded-registration'))).toBe(false);
    expect(existsSync(ledgerPath(root))).toBe(false);
  });

  it('doctor names the supersession instead of crying tampering', () => {
    const root = tmpRepo();
    seed(root);
    const stateA = checkHookRegistrations(root, ['searchSteering']);
    expect(stateA.ok).toBe(false);
    expect(stateA.missing).toContain('claude:superseded-registration');
    expect(stateA.missing.some((m) => m.endsWith(':untrusted-ledger'))).toBe(false);

    const patched = tmpRepo();
    seed(patched, { document: 'current' });
    const stateB = checkHookRegistrations(patched, ['searchSteering']);
    expect(stateB.ok).toBe(false);
    expect(stateB.missing).toEqual(
      expect.arrayContaining(['claude:superseded-registration', 'codex:superseded-registration']),
    );

    installHookRegistrations(root, ['searchSteering']);
    expect(checkHookRegistrations(root, ['searchSteering']).ok).toBe(true);
  });
});
