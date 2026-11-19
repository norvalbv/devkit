// A registry entry in one provider's native hook shape. Overlay scripts live only in the overlay
// home, so overlay Claude and Codex commands carry its path: $CLAUDE_PROJECT_DIR may name a worktree.

import { isAbsolute } from 'node:path';
import type { AgentProvider } from '../agent-assets/agent-providers.mts';
import { CONTROL_RE, type HookInstallScope, type HookRegistrationOwnershipV1 } from './codec.mts';

const PROJECT_DIR = '$CLAUDE_PROJECT_DIR';
const RUNNER_RE = /^(node|bash)\s+/;
const CLAUDE_PROJECT_DIR_RE = /"\$CLAUDE_PROJECT_DIR"?\/?/g;
const DOUBLE_QUOTE_SPECIAL_RE = /[\\"$`]/g;
const ESCAPED_RE = /\\(.)/g;
const CURSOR_EVENT: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  PreToolUse: { Bash: 'beforeShellExecution' },
  PostToolUse: { Bash: 'afterShellExecution', 'Edit|Write|MultiEdit': 'afterFileEdit' },
  Stop: { '': 'stop' },
  PreCompact: { '': 'preCompact' },
};

interface ProjectableRegistration {
  event: string;
  matcher: string;
  command: string;
  cursorEvent?: string | null;
  cursorMatcher?: string;
  providers?: readonly AgentProvider[];
}

/** The anchor a scope's commands carry: only overlay scripts are absent from a linked worktree. A
 * home whose path holds a control character cannot be written into a command, so it stays unanchored. */
export const scopeAnchor = (scope: HookInstallScope, home: string | null): string | null =>
  scope === 'overlay' && home && !CONTROL_RE.test(home) ? home : null;

const escapeForDoubleQuotes = (value: string) => value.replace(DOUBLE_QUOTE_SPECIAL_RE, '\\$&');

/** Every source command holds $CLAUDE_PROJECT_DIR exactly once, inside double quotes. */
export function anchorHookCommand(command: string, home: string): string {
  return command.replace(PROJECT_DIR, () => escapeForDoubleQuotes(home));
}

function recoverAnchoredHome(source: string, command: string): string | null {
  const [prefix, suffix, ...rest] = source.split(PROJECT_DIR);
  if (suffix === undefined || rest.length) return null;
  if (command.length <= prefix.length + suffix.length) return null;
  if (!command.startsWith(prefix) || !command.endsWith(suffix)) return null;
  const middle = command.slice(prefix.length, command.length - suffix.length);
  const home = middle.replace(ESCAPED_RE, '$1');
  return isAbsolute(home) && escapeForDoubleQuotes(home) === middle ? home : null;
}

const codexSource = (command: string) => command.replaceAll('.claude/hooks/', '.codex/hooks/');

function codexCommand(command: string, home: string | null): string {
  const codex = codexSource(command);
  return home
    ? anchorHookCommand(codex, home)
    : codex.replaceAll(PROJECT_DIR, '$(git rev-parse --show-toplevel)');
}

function cursorCommand(command: string): string {
  return command
    .replace(RUNNER_RE, '')
    .replace(CLAUDE_PROJECT_DIR_RE, '')
    .replaceAll('.claude/hooks/', '.cursor/hooks/')
    .replaceAll('"', '')
    .trim();
}

/** `home` is the overlay home's realpath, or null where the scripts are tracked in every worktree.
 * Cursor is never anchored: its worktree behaviour is unverified and its command strips quotes. */
export function nativeProjection(
  provider: AgentProvider,
  registration: ProjectableRegistration,
  home: string | null,
): HookRegistrationOwnershipV1['native'] | null {
  if (registration.providers && !registration.providers.includes(provider)) return null;
  const { event, matcher, command } = registration;
  if (provider === 'claude')
    return { event, matcher, command: home ? anchorHookCommand(command, home) : command };
  if (provider === 'codex')
    return {
      event,
      matcher: matcher || null,
      command: codexCommand(command, home),
    };
  if (registration.cursorEvent === null) return null;
  if (registration.cursorEvent)
    return {
      event: registration.cursorEvent,
      matcher: registration.cursorMatcher || null,
      command: cursorCommand(command),
    };
  const cursorEvent = CURSOR_EVENT[event]?.[matcher];
  return cursorEvent
    ? { event: cursorEvent, matcher: null, command: cursorCommand(command) }
    : null;
}

/** The home a provider `command` was anchored at, proved by re-rendering `registration` with it. */
export function recoverProjectionHome(
  provider: AgentProvider,
  registration: ProjectableRegistration,
  command: string,
): string | null {
  if (provider === 'cursor') return null;
  const source = provider === 'codex' ? codexSource(registration.command) : registration.command;
  const home = recoverAnchoredHome(source, command);
  return home && nativeProjection(provider, registration, home)?.command === command ? home : null;
}
