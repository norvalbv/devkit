/**
 * install-hooks tests — the agent-hook registration installer (Claude settings.json +
 * Cursor hooks.json). All IO runs against a real tmp repo (à la install-fallow.test.mjs).
 * console.log is silenced. Covers: merge shape, both surfaces, idempotency (re-run does not
 * duplicate), preservation of a foreign hook, the Cursor event mapping, and removal.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
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
    expect(cmds.some((c) => c.includes('search-tool-guard.mts'))).toBe(true);
    expect(cmds.some((c) => c.includes('search-tool-counter.mts'))).toBe(true);
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

  it.each([
    'codex',
    'cursor',
  ])('transfers same-destination ownership across %s mode changes', (provider) => {
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
  });

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
});
