/**
 * Agent-hook INSTALLER — writes/merges the consumer's `.claude/settings.json` hooks block
 * (Claude) and mirrors to `.cursor/hooks.json` (Cursor) from the devkit hook registry
 * (hook-registrations.mjs), for the components the consumer selected.
 *
 * Idempotent + non-destructive:
 *  - merges INTO an existing settings.json, preserving the consumer's own hooks/keys;
 *  - a devkit-owned command is recognised by a marker substring, so a re-run REPLACES the
 *    devkit set (never duplicates it) and leaves foreign commands untouched;
 *  - removal strips exactly the devkit commands, leaving the consumer's intact.
 *
 * "Ship the generator, never the data": the registry is the mechanism; the consumer's
 * settings.json (their data) is merged, never clobbered.
 */

import { chmodSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { packageDir, readJson, sha256, writeIfAbsent } from './fs-helpers.mjs';
import { registrationsFor } from './hook-registrations.mjs';

const HOOK_SCRIPT_DIRS = ['.claude/hooks', '.cursor/hooks'];

// Copy the bundled agent-hook scripts (agents-hooks/*.mjs|.sh) into the consumer's hook dirs and
// write .devkit/agent-hooks-manifest.json (per-file sha256, like skills/agents). The registrations
// reference these by path, so the scripts must be present for the hooks to resolve. Scripts are
// kept executable (chmod +x) — the .sh/.mjs are invoked directly by the agent harness.
export function syncHookScripts(root, { dryRun = false } = {}) {
  const src = join(packageDir(), 'agents-hooks');
  const rels = readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  /** @type {Record<string,string>} */
  const files = {};
  for (const rel of rels) {
    const content = readFileSync(join(src, rel));
    files[rel] = sha256(join(src, rel));
    if (dryRun) continue;
    for (const dir of HOOK_SCRIPT_DIRS) {
      const dest = join(root, dir, rel);
      writeIfAbsent(dest, content, { force: true });
      chmodSync(dest, 0o755);
    }
  }
  const manifestPath = join(root, '.devkit', 'agent-hooks-manifest.json');
  const devkitPkg = readJson(join(packageDir(), 'package.json'));
  const devkitRef = devkitPkg ? `v${devkitPkg.version}` : null;
  const prev = readJson(manifestPath);
  const unchanged =
    prev && prev.devkitRef === devkitRef && JSON.stringify(prev.files) === JSON.stringify(files);
  const manifest = {
    devkitRef,
    generatedAt: unchanged ? prev.generatedAt : new Date().toISOString(),
    files,
  };
  if (dryRun) {
    console.log(
      `  [dry-run] sync ${rels.length} agent-hook script(s) → .claude/hooks + .cursor/hooks`,
    );
    return manifest;
  }
  writeIfAbsent(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { force: true });
  console.log(`  ✓ synced ${rels.length} agent-hook script(s) → .claude/hooks + .cursor/hooks`);
  return manifest;
}

// Remove the synced agent-hook scripts (per manifest) from both hook dirs + drop the manifest.
export function removeHookScripts(root, { dryRun = false } = {}) {
  const manifestPath = join(root, '.devkit', 'agent-hooks-manifest.json');
  const manifest = readJson(manifestPath);
  if (!manifest) return;
  for (const rel of Object.keys(manifest.files)) {
    for (const dir of HOOK_SCRIPT_DIRS) {
      const p = join(root, dir, rel);
      if (existsSync(p) && !dryRun) rmSync(p);
    }
  }
  if (!dryRun) rmSync(manifestPath, { force: true });
  console.log(
    `  ${dryRun ? '[dry-run] remove' : '✓ removed'} synced agent-hook scripts + manifest`,
  );
}

// A command is devkit-owned iff it references one of these path fragments. Used to dedupe on
// re-install and to strip on removal without touching the consumer's own hook commands.
const DEVKIT_MARKERS = ['@norvalbv/devkit/gate-engine', '/.claude/hooks/', '/.cursor/hooks/'];

const isDevkit = (cmd) => DEVKIT_MARKERS.some((m) => cmd.includes(m));

// ── Claude (.claude/settings.json) — { hooks: { <Event>: [{ matcher, hooks: [{type,command}] }] } }
// Strip every devkit-owned command from a Claude hooks block, dropping now-empty matcher/event groups.
function stripClaude(hooks) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    const kept = [];
    for (const group of groups) {
      const cmds = (group.hooks ?? []).filter((h) => !(h.command && isDevkit(h.command)));
      if (cmds.length) kept.push({ ...group, hooks: cmds });
    }
    if (kept.length) out[event] = kept;
  }
  return out;
}

// Merge one registration into a Claude hooks block (append to the matching event+matcher group,
// or create it). Mutates + returns `hooks`.
function addClaude(hooks, { event, matcher, command }) {
  if (!hooks[event]) hooks[event] = [];
  const groups = hooks[event];
  let group = groups.find((g) => (g.matcher ?? '') === matcher);
  if (!group) {
    group = { matcher, hooks: [] };
    groups.push(group);
  }
  group.hooks.push({ type: 'command', command });
  return hooks;
}

// ── Cursor (.cursor/hooks.json) — { version, hooks: { <lowercaseEvent>: [{ command, … }] } }
// Cursor's event vocabulary differs from Claude's; map only the events that translate cleanly.
const CURSOR_EVENT = {
  PreToolUse: { Bash: 'beforeShellExecution' },
  PostToolUse: { Bash: 'afterShellExecution', 'Edit|Write|MultiEdit': 'afterFileEdit' },
  Stop: { '': 'stop' },
  PreCompact: { '': 'preCompact' },
  // UserPromptSubmit has no Cursor analogue → omitted from the Cursor mirror.
};

// Hoisted (perf: avoid recompiling per call) — the transforms toCursorCommand applies.
const RUNNER_RE = /^(node|bash)\s+/;
const PROJECT_DIR_RE = /"\$CLAUDE_PROJECT_DIR"?\/?/g;
const CLAUDE_HOOKS_RE = /\.claude\/hooks\//g;
const QUOTE_RE = /"/g;

// Convert a $CLAUDE_PROJECT_DIR command to a repo-relative Cursor command (Cursor runs from the
// repo root and uses no env prefix; .claude/hooks scripts are mirrored to .cursor/hooks).
function toCursorCommand(command) {
  return command
    .replace(RUNNER_RE, '')
    .replace(PROJECT_DIR_RE, '')
    .replace(CLAUDE_HOOKS_RE, '.cursor/hooks/')
    .replace(QUOTE_RE, '')
    .trim();
}

function stripCursor(hooks) {
  const out = {};
  for (const [event, list] of Object.entries(hooks ?? {})) {
    const kept = (list ?? []).filter((h) => !(h.command && isDevkit(h.command)));
    if (kept.length) out[event] = kept;
  }
  return out;
}

function addCursor(hooks, { event, matcher, command }) {
  const cursorEvent = CURSOR_EVENT[event]?.[matcher];
  if (!cursorEvent) return hooks; // no clean Cursor mapping → skip
  if (!hooks[cursorEvent]) hooks[cursorEvent] = [];
  hooks[cursorEvent].push({ command: toCursorCommand(command) });
  return hooks;
}

/**
 * Install (merge) the hook registrations for the selected components into both agent surfaces.
 *
 * @param {string} root the git root (hooks are repo-wide, like skills/agents)
 * @param {string[]} componentIds selected components that own hook registrations
 * @param {{ dryRun?: boolean }} [opts]
 */
export function installHookRegistrations(root, componentIds, { dryRun = false } = {}) {
  const regs = registrationsFor(componentIds);
  if (!regs.length) return;

  // Claude — merge into a freshly devkit-stripped block so a re-run replaces, never duplicates.
  const claudePath = join(root, '.claude', 'settings.json');
  const claude = readJson(claudePath) ?? {};
  let claudeHooks = stripClaude(claude.hooks);
  for (const reg of regs) claudeHooks = addClaude(claudeHooks, reg);
  claude.hooks = claudeHooks;

  // Cursor — same idempotent strip-then-add into the differently-shaped hooks.json.
  const cursorPath = join(root, '.cursor', 'hooks.json');
  const cursor = readJson(cursorPath) ?? { version: 1, hooks: {} };
  let cursorHooks = stripCursor(cursor.hooks);
  for (const reg of regs) cursorHooks = addCursor(cursorHooks, reg);
  cursor.hooks = cursorHooks;

  if (dryRun) {
    console.log(
      '  [dry-run] merge hook registrations → .claude/settings.json + .cursor/hooks.json',
    );
    return;
  }
  writeIfAbsent(claudePath, `${JSON.stringify(claude, null, 2)}\n`, { force: true });
  writeIfAbsent(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, { force: true });
  console.log(`  ✓ registered ${regs.length} hook(s) → .claude/settings.json + .cursor/hooks.json`);
}

/**
 * Remove every devkit-owned hook command from both surfaces (consumer commands untouched).
 *
 * @param {string} root the git root
 * @param {{ dryRun?: boolean }} [opts]
 */
export function removeHookRegistrations(root, { dryRun = false } = {}) {
  const claudePath = join(root, '.claude', 'settings.json');
  const claude = readJson(claudePath);
  const cursorPath = join(root, '.cursor', 'hooks.json');
  const cursor = readJson(cursorPath);
  if (!claude && !cursor) {
    console.log('  • no agent settings — no hook registrations to remove');
    return;
  }
  if (dryRun) {
    console.log('  [dry-run] strip devkit hook registrations from settings.json + hooks.json');
    return;
  }
  if (claude) {
    claude.hooks = stripClaude(claude.hooks);
    writeIfAbsent(claudePath, `${JSON.stringify(claude, null, 2)}\n`, { force: true });
  }
  if (cursor) {
    cursor.hooks = stripCursor(cursor.hooks);
    writeIfAbsent(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, { force: true });
  }
  console.log(
    '  ✓ removed devkit hook registrations from .claude/settings.json + .cursor/hooks.json',
  );
}

/**
 * Doctor helper: are all expected devkit commands present in the Claude settings for the
 * selected hook-owning components? Returns { ok, missing } (read-only).
 *
 * @param {string} root the git root
 * @param {string[]} componentIds
 */
export function checkHookRegistrations(root, componentIds) {
  const regs = registrationsFor(componentIds);
  if (!regs.length) return { ok: true, missing: [] };
  const claude = readJson(join(root, '.claude', 'settings.json'));
  const present = new Set();
  for (const groups of Object.values(claude?.hooks ?? {})) {
    for (const group of groups) {
      for (const h of group.hooks ?? []) if (h.command) present.add(h.command);
    }
  }
  const missing = regs.filter((r) => !present.has(r.command)).map((r) => r.command);
  return { ok: missing.length === 0, missing };
}
