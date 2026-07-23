/**
 * The devkit hook REGISTRY — the single source of truth for which hook commands each
 * selectable component contributes to the consumer's agent settings. `devkit init` reads
 * this to write/merge `.claude/settings.json` (Claude) and `.cursor/hooks.json` (Cursor);
 * `doctor` reads it to verify the registrations are present; `clean`/removal reads it to
 * strip exactly the commands a component added.
 *
 * Each registration:
 *   registrationId — stable identity shared by future provider-native projections
 *   event    — a Claude hook event (UserPromptSubmit | PreToolUse | PostToolUse | Stop | PreCompact)
 *   matcher  — the Claude matcher string ('' = all)
 *   command  — the shell command (uses $CLAUDE_PROJECT_DIR; the consumer's repo root)
 *
 * Commands point either at the installed package (node_modules/@norvalbv/devkit/…) for engine
 * gates, or at the consumer's .claude/hooks/… for the synced agent-hook scripts.
 *
 * "Ship the generator, never the data": this is the MECHANISM list (which devkit hook runs on
 * which event). It carries no consumer-specific paths beyond $CLAUDE_PROJECT_DIR.
 */

const PKG = 'node_modules/@norvalbv/devkit';
// devkit's own engine bins are compiled .mjs in an installed consumer (dist) but .mts in devkit's
// own repo (dev/tests, Node strips types). Derive the extension from THIS module so the generated
// hook commands point at the file that actually exists in each context.
const SELF_EXT = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';

// One registry entry: a Claude hook event + matcher + the shell command it wires (see the header).
interface HookRegistration {
  registrationId: string;
  event: string;
  matcher: string;
  command: string;
  /** Cursor can expose the same capability under a different native event/matcher pair. */
  cursorEvent?: string;
  cursorMatcher?: string;
}

/** Registrations grouped by the selectable component id (components.mjs) that owns them. */
export const HOOK_REGISTRATIONS: Record<string, HookRegistration[]> = {
  // The decisions guard owns its authoring boundary. This is deliberately independent of the
  // optional general agentHooks component: selecting the guard is sufficient to install it.
  decisions: [
    {
      registrationId: 'decisions:pre-edit',
      event: 'PreToolUse',
      matcher: 'Edit|Write|MultiEdit|Delete',
      command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/decision-edit-guard.mjs"',
      cursorEvent: 'preToolUse',
      cursorMatcher: 'Write|Delete',
    },
  ],
  // story 15 — search-code steering: PreToolUse guard + PostToolUse counter (engine bins).
  searchSteering: [
    {
      registrationId: 'search-steering:pre-bash',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: `node "$CLAUDE_PROJECT_DIR"/${PKG}/gate-engine/search-tool/search-tool-guard${SELF_EXT}`,
    },
    {
      registrationId: 'search-steering:post-bash',
      event: 'PostToolUse',
      matcher: 'Bash',
      command: `node "$CLAUDE_PROJECT_DIR"/${PKG}/gate-engine/search-tool/search-tool-counter${SELF_EXT}`,
    },
  ],
  // story 17 — agent-hooks: synced scripts under the consumer's .claude/hooks/ (self-skip when
  // their tool/config is absent). UserPromptSubmit nudge, Stop QA trio, format-after-edit, compactor.
  agentHooks: [
    {
      registrationId: 'agent-hooks:prompt-reminder',
      event: 'UserPromptSubmit',
      matcher: '',
      command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/claude-rules-reminder.mjs"',
    },
    {
      registrationId: 'agent-hooks:decision-stop',
      event: 'Stop',
      matcher: '',
      command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/decision-stop-check.sh"',
    },
    {
      registrationId: 'agent-hooks:lint-stop',
      event: 'Stop',
      matcher: '',
      command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/lint-check.sh"',
    },
    {
      registrationId: 'agent-hooks:knip-stop',
      event: 'Stop',
      matcher: '',
      command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/knip-check.sh"',
    },
    {
      registrationId: 'agent-hooks:format-after-edit',
      event: 'PostToolUse',
      matcher: 'Edit|Write|MultiEdit',
      command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/format-after-edit.sh"',
    },
    {
      registrationId: 'agent-hooks:strategic-compactor',
      event: 'PreCompact',
      matcher: '',
      command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/strategic-compactor.sh"',
    },
  ],
};

/** Flatten the registrations for the given selected component ids into one ordered list. */
export function registrationsFor(componentIds: string[]): HookRegistration[] {
  return componentIds.flatMap((id) => HOOK_REGISTRATIONS[id] ?? []);
}
