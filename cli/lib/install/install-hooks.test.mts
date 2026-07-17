/**
 * install-hooks tests — the agent-hook registration installer (Claude settings.json +
 * Cursor/Codex hooks.json). All IO runs against a real tmp repo (à la install-fallow.test.mjs).
 * console.log is silenced. Covers: merge shape, default surfaces, idempotency (re-run does not
 * duplicate), preservation of a foreign hook, the Cursor event mapping, and removal.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const cursor = (root) => JSON.parse(readFileSync(join(root, '.cursor', 'hooks.json'), 'utf8'));
const codex = (root) => JSON.parse(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8'));
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
  it('writes all default surfaces and explains Codex trust', () => {
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
    expect(codex(root).hooks.PreToolUse).toHaveLength(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('remain inactive'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('/hooks'));
  });

  it('registers plan evidence plus the existing agent hooks across provider events', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['agentHooks']);
    const h = claude(root).hooks;
    expect(h.UserPromptSubmit).toHaveLength(1);
    expect(h.Stop[0].hooks).toHaveLength(4); // plan observation + decision + lint + knip
    expect(h.SubagentStop[0].hooks).toHaveLength(1);
    expect(h.PreCompact).toHaveLength(1);
    // Cursor has no composer-mode field, but still captures SubagentStop structured results.
    const cur = cursor(root).hooks;
    expect(cur.stop).toHaveLength(4);
    expect(cur.subagentStop).toHaveLength(1);
    expect(cur.afterFileEdit).toHaveLength(1);
    expect(cur.preCompact).toHaveLength(1);
    expect(cur.UserPromptSubmit).toBeUndefined();
  });

  it('is idempotent — a re-run does not duplicate', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['searchSteering', 'agentHooks']);
    const first = claudeCommands(root).length;
    installHookRegistrations(root, ['searchSteering', 'agentHooks']);
    expect(claudeCommands(root).length).toBe(first);
    expect(first).toBe(10);
  });

  it('installs Codex only when selected, preserves user hooks, and uses git-root commands', () => {
    const root = tmpRepo();
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(
      join(root, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }),
    );
    installHookRegistrations(root, ['agentHooks'], { targets: ['codex'] });
    expect(existsSync(join(root, '.claude'))).toBe(false);
    const hooks = codex(root).hooks;
    const commands = Object.values(hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
    );
    expect(
      commands.some(
        (command) => command.includes('plan-critique-evidence.mjs') && command.includes('codex'),
      ),
    ).toBe(true);
    expect(commands.some((command) => command.includes('git rev-parse --show-toplevel'))).toBe(
      true,
    );
    expect(commands).toContain('echo mine');
    expect(checkHookRegistrations(root, ['agentHooks'], { targets: ['codex'] }).ok).toBe(true);
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
});

describe('checkHookRegistrations', () => {
  it('reports ok when present, missing after removal', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['searchSteering']);
    expect(checkHookRegistrations(root, ['searchSteering']).ok).toBe(true);
    removeHookRegistrations(root);
    const after = checkHookRegistrations(root, ['searchSteering']);
    expect(after.ok).toBe(false);
    expect(after.missing).toHaveLength(2);
  });
});

describe('removeHookRegistrations', () => {
  it('strips devkit hooks but leaves a foreign one', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['agentHooks']);
    const s = claude(root);
    s.hooks.Stop[0].hooks.push({ type: 'command', command: 'echo mine' });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(s));
    removeHookRegistrations(root);
    const cmds = claudeCommands(root);
    expect(cmds).toEqual(['echo mine']);
  });

  it('no-ops cleanly when no settings exist', () => {
    const root = tmpRepo();
    expect(() => removeHookRegistrations(root)).not.toThrow();
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false);
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
});
