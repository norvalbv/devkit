/**
 * The devkit hook REGISTRY — the single source of truth for which hook commands each
 * selectable component contributes to the consumer's agent settings. `devkit init` reads
 * this to write/merge `.claude/settings.json` (Claude) and `.cursor/hooks.json` (Cursor);
 * `doctor` reads it to verify the registrations are present; `clean`/removal reads it to
 * strip exactly the commands a component added.
 *
 * Each registration:
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
/** Registrations grouped by the selectable component id (components.mjs) that owns them. */
export const HOOK_REGISTRATIONS = {
    // story 15 — search-code steering: PreToolUse guard + PostToolUse counter (engine bins).
    searchSteering: [
        {
            event: 'PreToolUse',
            matcher: 'Bash',
            command: `node "$CLAUDE_PROJECT_DIR"/${PKG}/gate-engine/search-tool/search-tool-guard${SELF_EXT}`,
        },
        {
            event: 'PostToolUse',
            matcher: 'Bash',
            command: `node "$CLAUDE_PROJECT_DIR"/${PKG}/gate-engine/search-tool/search-tool-counter${SELF_EXT}`,
        },
    ],
    // story 17 — agent-hooks: synced scripts under the consumer's .claude/hooks/ (self-skip when
    // their tool/config is absent). UserPromptSubmit nudge, Stop QA trio, format-after-edit, compactor.
    agentHooks: [
        {
            event: 'UserPromptSubmit',
            matcher: '',
            command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/claude-rules-reminder.mjs"',
        },
        {
            event: 'Stop',
            matcher: '',
            command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/decision-stop-check.sh"',
        },
        {
            event: 'Stop',
            matcher: '',
            command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/lint-check.sh"',
        },
        {
            event: 'Stop',
            matcher: '',
            command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/knip-check.sh"',
        },
        {
            event: 'PostToolUse',
            matcher: 'Edit|Write|MultiEdit',
            command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/format-after-edit.sh"',
        },
        {
            event: 'PreCompact',
            matcher: '',
            command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/strategic-compactor.sh"',
        },
    ],
};
/** Flatten the registrations for the given selected component ids into one ordered list. */
export function registrationsFor(componentIds) {
    return componentIds.flatMap((id) => HOOK_REGISTRATIONS[id] ?? []);
}
