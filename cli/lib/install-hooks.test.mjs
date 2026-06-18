/**
 * install-hooks tests — the agent-hook registration installer (Claude settings.json +
 * Cursor hooks.json). All IO runs against a real tmp repo (à la install-fallow.test.mjs).
 * console.log is silenced. Covers: merge shape, both surfaces, idempotency (re-run does not
 * duplicate), preservation of a foreign hook, the Cursor event mapping, and removal.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkHookRegistrations,
  installHookRegistrations,
  removeHookRegistrations,
} from './install-hooks.mjs';

let roots = [];
function tmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'hooks-'));
  roots.push(root);
  return root;
}
const claude = (root) => JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
const cursor = (root) => JSON.parse(readFileSync(join(root, '.cursor', 'hooks.json'), 'utf8'));
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
  it('writes both surfaces for searchSteering (PreToolUse guard + PostToolUse counter)', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['searchSteering']);
    const cmds = claudeCommands(root);
    expect(cmds).toHaveLength(2);
    expect(cmds.some((c) => c.includes('search-tool-guard.mjs'))).toBe(true);
    expect(cmds.some((c) => c.includes('search-tool-counter.mjs'))).toBe(true);
    // Cursor mirror maps Bash PreToolUse→beforeShellExecution, PostToolUse→afterShellExecution.
    const cur = cursor(root).hooks;
    expect(cur.beforeShellExecution).toHaveLength(1);
    expect(cur.afterShellExecution).toHaveLength(1);
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
  });

  it('is idempotent — a re-run does not duplicate', () => {
    const root = tmpRepo();
    installHookRegistrations(root, ['searchSteering', 'agentHooks']);
    const first = claudeCommands(root).length;
    installHookRegistrations(root, ['searchSteering', 'agentHooks']);
    expect(claudeCommands(root).length).toBe(first);
    expect(first).toBe(8);
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
