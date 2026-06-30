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

import { chmodSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_TARGETS } from '../components.mjs';
import { packageDir, readJson, sha256, writeIfAbsent } from '../fs-helpers.mjs';
import { isTracked } from '../git-tracked.mjs';
import { bundledNames, findConflicts, removeManifested } from '../sync-manifest.mjs';
import { registrationsFor } from './hook-registrations.mjs';

// Claude's settings file by mode: overlay registers into the LOCAL-override `settings.local.json`
// (gitignored by default, never tracked → invisible, never needs the tracked-skip), every other
// mode into the shared `settings.json`. The Claude install/remove/check paths all resolve through
// here so they target the SAME file.
const claudeSettingsFile = (overlay) => (overlay ? 'settings.local.json' : 'settings.json');

// Surface `<name>` (claude|cursor) → its hook-scripts dir (.claude/hooks | .cursor/hooks).
const hookDirs = (targets) => targets.map((t) => `.${t}/hooks`);

// Copy the bundled agent-hook scripts (agents-hooks/*.mjs|.sh) into the consumer's hook dirs and
// write .devkit/agent-hooks-manifest.json (per-file sha256, like skills/agents). The registrations
// reference these by path, so the scripts must be present for the hooks to resolve. Scripts are
// kept executable (chmod +x) — the .sh/.mjs are invoked directly by the agent harness.
/**
 * @param {string} root the git root
 * @param {{ dryRun?: boolean, targets?: string[], skipTracked?: (relPath: string) => boolean, override?: (kind: string, name: string) => boolean }} [opts]
 *   `skipTracked` (overlay-only): leaves a git-tracked hook script untouched (C2). `override(kind, name)`
 *   (default never): a hook script colliding with the consumer's OWN same-named file (on disk,
 *   unmanifested, divergent) is PRESERVED unless `override('agent-hook', name)` is true.
 */
export function syncHookScripts(
  root,
  { dryRun = false, targets = AGENT_TARGETS, skipTracked, override = () => false } = {},
) {
  const src = join(packageDir(), 'agents-hooks');
  const dirs = hookDirs(targets);
  const rels = readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  const manifestPath = join(root, '.devkit', 'agent-hooks-manifest.json');
  const prev = readJson(manifestPath);
  const conflicts = new Set(findConflicts(root, src, rels, dirs, prev));
  /** @type {Record<string,string>} */
  const files = {};
  for (const rel of rels) {
    // Overlay: a hook script git already tracks can't be hidden by .git/info/exclude → skip it (C2).
    if (skipTracked && dirs.some((d) => skipTracked(`${d}/${rel}`))) {
      console.log(`  ! skipping agent-hook "${rel}" — git-tracked (left untouched)`);
      continue;
    }
    // Non-devkit collision: leave the consumer's own hook script untouched (+ out of the manifest).
    if (conflicts.has(rel) && !override('agent-hook', rel)) {
      console.log(
        `  ! preserving non-devkit agent-hook "${rel}" (left untouched — re-run with --force or select it to overwrite)`,
      );
      continue;
    }
    const content = readFileSync(join(src, rel));
    files[rel] = sha256(join(src, rel));
    if (dryRun) continue;
    for (const dir of dirs) {
      const dest = join(root, dir, rel);
      writeIfAbsent(dest, content, { force: true });
      chmodSync(dest, 0o755);
    }
  }
  const devkitPkg = readJson(join(packageDir(), 'package.json'));
  const devkitRef = devkitPkg ? `v${devkitPkg.version}` : null;
  const unchanged =
    prev && prev.devkitRef === devkitRef && JSON.stringify(prev.files) === JSON.stringify(files);
  const manifest = {
    devkitRef,
    generatedAt: unchanged ? prev.generatedAt : new Date().toISOString(),
    files,
  };
  if (dryRun) {
    console.log(`  [dry-run] sync ${rels.length} agent-hook script(s) → ${dirs.join(' + ')}`);
    return manifest;
  }
  writeIfAbsent(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { force: true });
  console.log(`  ✓ synced ${rels.length} agent-hook script(s) → ${dirs.join(' + ')}`);
  return manifest;
}

/**
 * The consumer's OWN agent-hook scripts that collide with a devkit-bundled name (on disk,
 * unmanifested, divergent) — what an interactive `devkit init` lists for the user to pick from.
 * @param {string} root git root
 * @param {string[]} [targets] surfaces to check (default both)
 * @returns {string[]} colliding hook-script filenames
 */
export function detectHookConflicts(root, targets = AGENT_TARGETS) {
  const src = join(packageDir(), 'agents-hooks');
  const rels = readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  return findConflicts(
    root,
    src,
    rels,
    hookDirs(targets),
    readJson(join(root, '.devkit', 'agent-hooks-manifest.json')),
  );
}

/**
 * Remove the synced agent-hook scripts (per manifest) from the given surfaces' hook dirs.
 * `dropManifest` (default true) also deletes the manifest — pass false when pruning ONE surface
 * while the other still holds tracked scripts (a both → single-surface switch).
 *
 * @param {string} root the git root
 * @param {{ dryRun?: boolean, targets?: string[], dropManifest?: boolean }} [opts]
 */
export function removeHookScripts(
  root,
  { dryRun = false, targets = AGENT_TARGETS, dropManifest = true } = {},
) {
  // Hook scripts are flat files in <surface>/hooks — the same teardown removeManifested does for
  // skills/agents (manifest names, or the bundled set as fallback, tracked-safe on the fallback).
  removeManifested(
    root,
    'agent-hooks-manifest.json',
    hookDirs(targets),
    'agent-hook script',
    dryRun,
    dropManifest,
    bundledNames('agents-hooks', (e) => e.isFile()),
    join(packageDir(), 'agents-hooks'),
  );
}

// A command is devkit-owned iff it references one of these path fragments. Used to dedupe on
// re-install and to strip on removal without touching the consumer's own hook commands. The hook-dir
// markers carry NO leading slash so they match BOTH the Claude form (`$CLAUDE_PROJECT_DIR/.claude/
// hooks/…`) and the Cursor form (`toCursorCommand` strips the `$CLAUDE_PROJECT_DIR/` prefix →
// `.cursor/hooks/…`) — a leading-slash marker silently failed to strip the Cursor commands.
const DEVKIT_MARKERS = ['@norvalbv/devkit/gate-engine', '.claude/hooks/', '.cursor/hooks/'];

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
 * Install (merge) the hook registrations for the selected components into the selected agent
 * surfaces (default both).
 *
 * @param {string} root the git root (hooks are repo-wide, like skills/agents)
 * @param {string[]} componentIds selected components that own hook registrations
 * @param {{ dryRun?: boolean, targets?: string[], overlay?: boolean }} [opts] overlay → Claude
 *   registers into the git-ignored `settings.local.json`, and a git-TRACKED `.cursor/hooks.json`
 *   is skipped+warned (its edit can't be hidden by .git/info/exclude).
 * @returns {{ wrote: string[] }} the git-root-relative files written (for overlay's exclude list)
 */
export function installHookRegistrations(
  root,
  componentIds,
  { dryRun = false, targets = AGENT_TARGETS, overlay = false } = {},
) {
  const regs = registrationsFor(componentIds);
  if (!regs.length) return { wrote: [] };
  const wrote = [];

  // Claude — merge into a freshly devkit-stripped block so a re-run replaces, never duplicates.
  // Overlay targets settings.local.json (local-override; Claude merges hooks additively across it
  // and settings.json, so the team's own hooks still fire). It's gitignored-by-default → never
  // tracked → no tracked-skip needed.
  if (targets.includes('claude')) {
    const claudeRel = `.claude/${claudeSettingsFile(overlay)}`;
    const claudePath = join(root, claudeRel);
    const claude = readJson(claudePath) ?? {};
    let claudeHooks = stripClaude(claude.hooks);
    for (const reg of regs) claudeHooks = addClaude(claudeHooks, reg);
    claude.hooks = claudeHooks;
    if (!dryRun) writeIfAbsent(claudePath, `${JSON.stringify(claude, null, 2)}\n`, { force: true });
    wrote.push(claudeRel);
  }

  // Cursor — same idempotent strip-then-add into the differently-shaped hooks.json. Cursor has no
  // `.local` variant, so in overlay a git-TRACKED hooks.json is left untouched (we can't hide the edit).
  if (targets.includes('cursor')) {
    const cursorRel = '.cursor/hooks.json';
    if (overlay && isTracked(root, cursorRel)) {
      console.log(
        `  ! ${cursorRel} is git-tracked — skipping (can't hide a tracked edit). Add devkit Cursor hooks manually if wanted.`,
      );
    } else {
      const cursorPath = join(root, cursorRel);
      const cursor = readJson(cursorPath) ?? { version: 1, hooks: {} };
      let cursorHooks = stripCursor(cursor.hooks);
      for (const reg of regs) cursorHooks = addCursor(cursorHooks, reg);
      cursor.hooks = cursorHooks;
      if (!dryRun)
        writeIfAbsent(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, { force: true });
      wrote.push(cursorRel);
    }
  }

  if (dryRun) {
    console.log(`  [dry-run] merge hook registrations → ${wrote.join(' + ')}`);
    return { wrote };
  }
  console.log(`  ✓ registered ${regs.length} hook(s) → ${wrote.join(' + ')}`);
  return { wrote };
}

/**
 * Remove every devkit-owned hook command from the given surfaces (consumer commands untouched).
 *
 * @param {string} root the git root
 * @param {{ dryRun?: boolean, targets?: string[], overlay?: boolean }} [opts] overlay → strip from
 *   the git-ignored `settings.local.json` (where overlay registered them), not the shared settings.json.
 */
export function removeHookRegistrations(
  root,
  { dryRun = false, targets = AGENT_TARGETS, overlay = false } = {},
) {
  const claudePath = join(root, '.claude', claudeSettingsFile(overlay));
  const claude = targets.includes('claude') ? readJson(claudePath) : null;
  const cursorPath = join(root, '.cursor', 'hooks.json');
  const cursor = targets.includes('cursor') ? readJson(cursorPath) : null;
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
  console.log('  ✓ removed devkit hook registrations');
}

/**
 * Doctor helper: are all expected devkit commands present in the Claude settings for the
 * selected hook-owning components? Returns { ok, missing } (read-only).
 *
 * @param {string} root the git root
 * @param {string[]} componentIds
 * @param {{ overlay?: boolean }} [opts] overlay → read the git-ignored `settings.local.json`.
 */
export function checkHookRegistrations(root, componentIds, { overlay = false } = {}) {
  const regs = registrationsFor(componentIds);
  if (!regs.length) return { ok: true, missing: [] };
  const claude = readJson(join(root, '.claude', claudeSettingsFile(overlay)));
  const present = new Set();
  for (const groups of Object.values(claude?.hooks ?? {})) {
    for (const group of groups) {
      for (const h of group.hooks ?? []) if (h.command) present.add(h.command);
    }
  }
  const missing = regs.filter((r) => !present.has(r.command)).map((r) => r.command);
  return { ok: missing.length === 0, missing };
}
