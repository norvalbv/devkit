import type { HookRegistration } from './hook-registrations.mts';

export interface ClaudeSettings {
  hooks?: ClaudeHooksBlock;
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

const DEVKIT_MARKERS = [
  '@norvalbv/devkit/gate-engine',
  '.claude/hooks/',
  '.cursor/hooks/',
  '.codex/hooks/',
];

export const isDevkitHookCommand = (command: string): boolean =>
  DEVKIT_MARKERS.some((marker) => command.includes(marker));

/** Remove devkit-owned commands while preserving arbitrary provider and user settings. */
export function stripClaude(hooks?: ClaudeHooksBlock): ClaudeHooksBlock {
  const out: ClaudeHooksBlock = {};
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    const kept: ClaudeHookGroup[] = [];
    for (const group of groups) {
      const commands = (group.hooks ?? []).filter(
        (hook) => !(hook.command && isDevkitHookCommand(hook.command)),
      );
      if (commands.length) kept.push({ ...group, hooks: commands });
    }
    if (kept.length) out[event] = kept;
  }
  return out;
}

/** Add one registration to the Claude-shaped matcher-group schema used by Claude and Codex. */
export function addClaude(
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

export function toClaudeRegistration(registration: HookRegistration): HookRegistration {
  return {
    ...registration,
    command: registration.command.replaceAll('__DEVKIT_PROVIDER__', 'claude'),
  };
}

export function toCodexRegistration(registration: HookRegistration): HookRegistration {
  return {
    ...registration,
    command: registration.command
      .replaceAll('__DEVKIT_PROVIDER__', 'codex')
      .replaceAll('$CLAUDE_PROJECT_DIR', '$(git rev-parse --show-toplevel)')
      .replace(/\.claude\/hooks\//g, '.codex/hooks/'),
  };
}
