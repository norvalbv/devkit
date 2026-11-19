// A registry entry in one provider's native hook shape. Overlay scripts live only in the overlay
// home, so overlay Claude and Codex commands carry its path: $CLAUDE_PROJECT_DIR may name a worktree.
import { isAbsolute } from 'node:path';
import { CONTROL_RE } from './codec.mjs';
const PROJECT_DIR = '$CLAUDE_PROJECT_DIR';
const RUNNER_RE = /^(node|bash)\s+/;
const CLAUDE_PROJECT_DIR_RE = /"\$CLAUDE_PROJECT_DIR"?\/?/g;
const DOUBLE_QUOTE_SPECIAL_RE = /[\\"$`]/g;
const ESCAPED_RE = /\\(.)/g;
const CURSOR_EVENT = {
    PreToolUse: { Bash: 'beforeShellExecution' },
    PostToolUse: { Bash: 'afterShellExecution', 'Edit|Write|MultiEdit': 'afterFileEdit' },
    Stop: { '': 'stop' },
    PreCompact: { '': 'preCompact' },
};
/** The anchor a scope's commands carry: only overlay scripts are absent from a linked worktree. A
 * home whose path holds a control character cannot be written into a command, so it stays unanchored. */
export const scopeAnchor = (scope, home) => scope === 'overlay' && home && !CONTROL_RE.test(home) ? home : null;
const escapeForDoubleQuotes = (value) => value.replace(DOUBLE_QUOTE_SPECIAL_RE, '\\$&');
/** Every source command holds $CLAUDE_PROJECT_DIR exactly once, inside double quotes. */
export function anchorHookCommand(command, home) {
    return command.replace(PROJECT_DIR, () => escapeForDoubleQuotes(home));
}
function recoverAnchoredHome(source, command) {
    const [prefix, suffix, ...rest] = source.split(PROJECT_DIR);
    if (suffix === undefined || rest.length)
        return null;
    if (command.length <= prefix.length + suffix.length)
        return null;
    if (!command.startsWith(prefix) || !command.endsWith(suffix))
        return null;
    const middle = command.slice(prefix.length, command.length - suffix.length);
    const home = middle.replace(ESCAPED_RE, '$1');
    return isAbsolute(home) && escapeForDoubleQuotes(home) === middle ? home : null;
}
const codexSource = (command) => command.replaceAll('.claude/hooks/', '.codex/hooks/');
function codexCommand(command, home) {
    const codex = codexSource(command);
    return home
        ? anchorHookCommand(codex, home)
        : codex.replaceAll(PROJECT_DIR, '$(git rev-parse --show-toplevel)');
}
function cursorCommand(command) {
    return command
        .replace(RUNNER_RE, '')
        .replace(CLAUDE_PROJECT_DIR_RE, '')
        .replaceAll('.claude/hooks/', '.cursor/hooks/')
        .replaceAll('"', '')
        .trim();
}
/** `home` is the overlay home's realpath, or null where the scripts are tracked in every worktree.
 * Cursor is never anchored: its worktree behaviour is unverified and its command strips quotes. */
export function nativeProjection(provider, registration, home) {
    if (registration.providers && !registration.providers.includes(provider))
        return null;
    const { event, matcher, command } = registration;
    if (provider === 'claude')
        return { event, matcher, command: home ? anchorHookCommand(command, home) : command };
    if (provider === 'codex')
        return {
            event,
            matcher: matcher || null,
            command: codexCommand(command, home),
        };
    if (registration.cursorEvent === null)
        return null;
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
export function recoverProjectionHome(provider, registration, command) {
    if (provider === 'cursor')
        return null;
    const source = provider === 'codex' ? codexSource(registration.command) : registration.command;
    const home = recoverAnchoredHome(source, command);
    return home && nativeProjection(provider, registration, home)?.command === command ? home : null;
}
