import { join } from 'node:path';
import { AGENT_TARGETS } from '../../components.mts';
import { readJson, writeIfAbsent } from '../../fs-helpers.mts';
import { isTracked } from '../../git-tracked.mts';
import { HOOK_REGISTRATIONS, registrationsFor } from './registrations.mts';

const settingsFile = (overlay: boolean) => (overlay ? 'settings.local.json' : 'settings.json');

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

interface InstallHookRegistrationOptions extends HookRegistrationOptions {
  /** Components selected now plus components recorded as devkit-owned by the previous install. */
  ownedComponentIds?: string[];
}

interface RemoveHookRegistrationOptions extends HookRegistrationOptions {
  /** Defaults to every registered component for clean/uninstall. */
  componentIds?: string[];
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

/**
 * Commands devkit ONCE registered and must still reclaim on a reconcile.
 *
 * The strip sets above are derived from the LIVE registry, so a command string vanishes from them
 * the moment its registration is deleted — and with it devkit's ability to remove what it wrote.
 * A consumer that installed the retired hook would keep a dead entry that no `init`, `doctor` or
 * `clean` could ever reach again, contradicting this module's own contract ("removal strips exactly
 * the commands a component added").
 *
 * Concretely: devkit briefly shipped its own `.claude/hooks/fallow-gate.sh` gate
 * ([[fallow-gate-owned-by-fallow]]). It now wires fallow's own hook instead, and fallow's installer
 * writes an entry for a script at that same path — so the orphan would not merely linger, it would
 * fire the gate twice per Bash tool call. These are STRIP-ONLY: never re-added, only cleaned up.
 * Exact command matching keeps unrelated consumer hooks untouched.
 *
 * BOTH surfaces need reclaiming. The Claude registration was mirrored to Cursor as
 * `.cursor/hooks/fallow-gate.sh`, and the script itself is removed by the generic sync (the file no
 * longer exists in agents-hooks/) — so without the Cursor set, a consumer keeps a
 * `beforeShellExecution` entry pointing at a deleted file, forever. devkit's live gate registers a
 * DIFFERENT command (`fallow-staged-gate.sh`), so reclaiming the old string cannot touch it.
 *
 * Retired registrations remain owned by the component that introduced them. Reclaim them only
 * while that component is selected (or during an explicit remove-all): a deselected component's
 * command may now be consumer-owned, and an unrelated component reconcile has no authority over it.
 */
const RETIRED_COMMANDS: Record<string, { claude: string[]; cursor: string[] }> = {
  fallow: {
    claude: [
      // devkit's own short-lived gate.
      'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-gate.sh"',
      // fallow's GENERATED agent gate, which devkit briefly installed via `fallow hooks install
      // --target agent`. It resolves its base as the merge-base against the remote default, so left
      // in place it fires beside devkit's staged-scope wrapper and re-blocks on the very unstaged
      // work the wrapper exists to exclude.
      'FALLOW_GATE_COMMIT_ONLY=1 bash "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-gate.sh"',
    ],
    // The Cursor mirrors of those same retired registrations.
    cursor: ['.cursor/hooks/fallow-gate.sh'],
  },
};

interface RegistrationCommands {
  claude: Set<string>;
  cursor: Set<string>;
}

function registrationCommandsFor(componentIds: string[]): RegistrationCommands {
  const claude = new Set<string>();
  const cursor = new Set<string>();
  for (const registration of registrationsFor(componentIds)) {
    claude.add(registration.command);
    if (registration.cursorEvent ?? CURSOR_EVENT[registration.event]?.[registration.matcher]) {
      cursor.add(toCursorCommand(registration.command));
    }
  }
  for (const id of new Set(componentIds)) {
    const retired = RETIRED_COMMANDS[id];
    for (const command of retired?.claude ?? []) claude.add(command);
    for (const command of retired?.cursor ?? []) cursor.add(command);
  }
  return { claude, cursor };
}

function stripClaude(
  hooks: ClaudeHooksBlock | undefined,
  commandsToStrip: ReadonlySet<string>,
): ClaudeHooksBlock {
  const out: ClaudeHooksBlock = {};
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    const kept: ClaudeHookGroup[] = [];
    for (const group of groups) {
      const commands = (group.hooks ?? []).filter(
        (hook) => !(hook.command && commandsToStrip.has(hook.command)),
      );
      if (commands.length) kept.push({ ...group, hooks: commands });
    }
    if (kept.length) out[event] = kept;
  }
  return out;
}

function stripCursor(
  hooks: CursorHooksBlock | undefined,
  commandsToStrip: ReadonlySet<string>,
): CursorHooksBlock {
  const out: CursorHooksBlock = {};
  for (const [event, list] of Object.entries(hooks ?? {})) {
    const kept = (list ?? []).filter(
      (hook) => !(hook.command && commandsToStrip.has(hook.command)),
    );
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
  {
    dryRun = false,
    targets = AGENT_TARGETS,
    overlay = false,
    ownedComponentIds = componentIds,
  }: InstallHookRegistrationOptions = {},
): { wrote: string[] } {
  const registrations = registrationsFor(componentIds);
  if (!registrations.length) return { wrote: [] };
  const commandsToStrip = registrationCommandsFor(ownedComponentIds);
  const wrote: string[] = [];

  if (targets.includes('claude')) {
    const relative = `.claude/${settingsFile(overlay)}`;
    const file = join(root, relative);
    const settings: ClaudeSettings = (readJson(file) as ClaudeSettings | null) ?? {};
    let hooks = stripClaude(settings.hooks, commandsToStrip.claude);
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
      let hooks = stripCursor(settings.hooks, commandsToStrip.cursor);
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

/** Reconcile selected registrations plus ownership recorded by the previous install. */
export function reconcileHookRegistrations(
  root: string,
  componentIds: string[],
  previouslyOwnedComponentIds: string[],
  options: HookRegistrationOptions = {},
): { wrote: string[] } {
  if (componentIds.length)
    return installHookRegistrations(root, componentIds, {
      ...options,
      ownedComponentIds: [...new Set([...componentIds, ...previouslyOwnedComponentIds])],
    });
  if (previouslyOwnedComponentIds.length)
    removeHookRegistrations(root, {
      ...options,
      componentIds: previouslyOwnedComponentIds,
    });
  return { wrote: [] };
}

/** Strip only Devkit-owned registrations from the selected surfaces. */
export function removeHookRegistrations(
  root: string,
  {
    dryRun = false,
    targets = AGENT_TARGETS,
    overlay = false,
    componentIds = Object.keys(HOOK_REGISTRATIONS),
  }: RemoveHookRegistrationOptions = {},
): void {
  const commandsToStrip = registrationCommandsFor(componentIds);
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
    claude.hooks = stripClaude(claude.hooks, commandsToStrip.claude);
    writeIfAbsent(claudePath, `${JSON.stringify(claude, null, 2)}\n`, { force: true });
  }
  if (cursor) {
    cursor.hooks = stripCursor(cursor.hooks, commandsToStrip.cursor);
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
