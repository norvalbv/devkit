import { join } from 'node:path';
import { AGENT_TARGETS } from '../components.mts';
import { readJson, writeIfAbsent } from '../fs-helpers.mts';
import { isTracked } from '../git-tracked.mts';
import { registrationsFor } from './hook-registrations.mts';

const settingsFile = (overlay: boolean) => (overlay ? 'settings.local.json' : 'settings.json');
const DEVKIT_MARKERS = ['@norvalbv/devkit/gate-engine', '.claude/hooks/', '.cursor/hooks/'];
const isDevkit = (command: string) => DEVKIT_MARKERS.some((marker) => command.includes(marker));

interface HookRegistration {
  event: string;
  matcher: string;
  command: string;
  cursorEvent?: string;
  cursorMatcher?: string;
}

interface HookRegistrationOptions {
  dryRun?: boolean;
  targets?: string[];
  overlay?: boolean;
}

interface ClaudeSettings {
  hooks?: ClaudeHooksBlock;
  [key: string]: unknown;
}

interface CursorSettings {
  version?: number;
  hooks?: CursorHooksBlock;
  [key: string]: unknown;
}

interface ClaudeHook {
  type?: string;
  command?: string;
}
interface ClaudeHookGroup {
  matcher?: string;
  hooks?: ClaudeHook[];
}
type ClaudeHooksBlock = Record<string, ClaudeHookGroup[]>;

interface CursorHook {
  command?: string;
  matcher?: string;
  failClosed?: boolean;
}
type CursorHooksBlock = Record<string, CursorHook[]>;

function stripClaude(hooks?: ClaudeHooksBlock): ClaudeHooksBlock {
  const out: ClaudeHooksBlock = {};
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    const kept: ClaudeHookGroup[] = [];
    for (const group of groups) {
      const commands = (group.hooks ?? []).filter(
        (hook) => !(hook.command && isDevkit(hook.command)),
      );
      if (commands.length) kept.push({ ...group, hooks: commands });
    }
    if (kept.length) out[event] = kept;
  }
  return out;
}

function addClaude(
  hooks: ClaudeHooksBlock,
  { event, matcher, command }: HookRegistration,
): ClaudeHooksBlock {
  if (!hooks[event]) hooks[event] = [];
  const groups = hooks[event];
  let group = groups.find((candidate) => (candidate.matcher ?? '') === matcher);
  if (!group) {
    group = { matcher, hooks: [] };
    groups.push(group);
  }
  if (!group.hooks) group.hooks = [];
  group.hooks.push({ type: 'command', command });
  return hooks;
}

const CURSOR_EVENT: Record<string, Record<string, string>> = {
  PreToolUse: { Bash: 'beforeShellExecution' },
  PostToolUse: {
    Bash: 'afterShellExecution',
    'Edit|Write|MultiEdit': 'afterFileEdit',
  },
  Stop: { '': 'stop' },
  PreCompact: { '': 'preCompact' },
};

const RUNNER_RE = /^(node|bash)\s+/;
const PROJECT_DIR_RE = /"\$CLAUDE_PROJECT_DIR"?\/?/g;
const CLAUDE_HOOKS_RE = /\.claude\/hooks\//g;
const QUOTE_RE = /"/g;

function toCursorCommand(command: string): string {
  return command
    .replace(RUNNER_RE, '')
    .replace(PROJECT_DIR_RE, '')
    .replace(CLAUDE_HOOKS_RE, '.cursor/hooks/')
    .replace(QUOTE_RE, '')
    .trim();
}

function stripCursor(hooks?: CursorHooksBlock): CursorHooksBlock {
  const out: CursorHooksBlock = {};
  for (const [event, list] of Object.entries(hooks ?? {})) {
    const kept = (list ?? []).filter((hook) => !(hook.command && isDevkit(hook.command)));
    if (kept.length) out[event] = kept;
  }
  return out;
}

function addCursor(
  hooks: CursorHooksBlock,
  { event, matcher, command, cursorEvent, cursorMatcher }: HookRegistration,
): CursorHooksBlock {
  const mappedEvent = cursorEvent ?? CURSOR_EVENT[event]?.[matcher];
  if (!mappedEvent) return hooks;
  if (!hooks[mappedEvent]) hooks[mappedEvent] = [];
  hooks[mappedEvent].push({
    command: toCursorCommand(command),
    ...(cursorMatcher ? { matcher: cursorMatcher, failClosed: false } : {}),
  });
  return hooks;
}

/** Merge exact Devkit registrations into the selected surfaces, preserving consumer hooks. */
export function installHookRegistrations(
  root: string,
  componentIds: string[],
  { dryRun = false, targets = AGENT_TARGETS, overlay = false }: HookRegistrationOptions = {},
): { wrote: string[] } {
  const registrations = registrationsFor(componentIds);
  if (!registrations.length) return { wrote: [] };
  const wrote: string[] = [];

  if (targets.includes('claude')) {
    const relative = `.claude/${settingsFile(overlay)}`;
    const file = join(root, relative);
    const settings: ClaudeSettings = (readJson(file) as ClaudeSettings | null) ?? {};
    let hooks = stripClaude(settings.hooks);
    for (const registration of registrations) hooks = addClaude(hooks, registration);
    settings.hooks = hooks;
    if (!dryRun) writeIfAbsent(file, `${JSON.stringify(settings, null, 2)}\n`, { force: true });
    wrote.push(relative);
  }

  if (targets.includes('cursor')) {
    const relative = '.cursor/hooks.json';
    if (overlay && isTracked(root, relative)) {
      console.log(
        `  ! ${relative} is git-tracked — skipping (can't hide a tracked edit). Add devkit Cursor hooks manually if wanted.`,
      );
    } else {
      const file = join(root, relative);
      const settings: CursorSettings = (readJson(file) as CursorSettings | null) ?? {
        version: 1,
        hooks: {},
      };
      let hooks = stripCursor(settings.hooks);
      for (const registration of registrations) hooks = addCursor(hooks, registration);
      settings.hooks = hooks;
      if (!dryRun) writeIfAbsent(file, `${JSON.stringify(settings, null, 2)}\n`, { force: true });
      wrote.push(relative);
    }
  }

  if (dryRun) {
    console.log(`  [dry-run] merge hook registrations → ${wrote.join(' + ')}`);
    return { wrote };
  }
  console.log(`  ✓ registered ${registrations.length} hook(s) → ${wrote.join(' + ')}`);
  return { wrote };
}

/** Strip only Devkit-owned registrations from the selected surfaces. */
export function removeHookRegistrations(
  root: string,
  { dryRun = false, targets = AGENT_TARGETS, overlay = false }: HookRegistrationOptions = {},
): void {
  const claudePath = join(root, '.claude', settingsFile(overlay));
  const claude = targets.includes('claude')
    ? (readJson(claudePath) as ClaudeSettings | null)
    : null;
  const cursorPath = join(root, '.cursor', 'hooks.json');
  const cursor = targets.includes('cursor')
    ? (readJson(cursorPath) as CursorSettings | null)
    : null;
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

/** Verify exact registration event, matcher, command, and Cursor denial settings. */
export function checkHookRegistrations(
  root: string,
  componentIds: string[],
  { overlay = false, targets = AGENT_TARGETS }: { overlay?: boolean; targets?: string[] } = {},
) {
  const registrations = registrationsFor(componentIds);
  if (!registrations.length) return { ok: true, missing: [] };
  const missing: string[] = [];
  if (targets.includes('claude')) {
    const claude = readJson(join(root, '.claude', settingsFile(overlay))) as {
      hooks?: ClaudeHooksBlock;
    } | null;
    for (const registration of registrations) {
      const found = (claude?.hooks?.[registration.event] ?? []).some(
        (group) =>
          (group.matcher ?? '') === registration.matcher &&
          (group.hooks ?? []).some((hook) => hook.command === registration.command),
      );
      if (!found) missing.push(registration.command);
    }
  }
  if (targets.includes('cursor')) {
    const cursor = readJson(join(root, '.cursor', 'hooks.json')) as CursorSettings | null;
    let expected: CursorHooksBlock = {};
    for (const registration of registrations) expected = addCursor(expected, registration);
    for (const [event, entries] of Object.entries(expected)) {
      const actual = cursor?.hooks?.[event] ?? [];
      for (const entry of entries) {
        const found = actual.some(
          (candidate) =>
            candidate.command === entry.command &&
            candidate.matcher === entry.matcher &&
            candidate.failClosed === entry.failClosed,
        );
        if (!found) missing.push(`Cursor ${event}: ${entry.command ?? '(missing command)'}`);
      }
    }
  }
  return { ok: missing.length === 0, missing };
}
