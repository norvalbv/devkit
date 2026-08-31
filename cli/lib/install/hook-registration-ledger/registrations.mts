/**
 * The devkit hook REGISTRY — the single source of truth for which hook commands each
 * selectable component contributes to the consumer's agent settings. `devkit init` reads
 * this to write/merge `.claude/settings.json` (Claude) and `.cursor/hooks.json` (Cursor);
 * `doctor` reads it to verify the registrations are present; `clean`/removal reads it to
 * strip exactly the commands a component added.
 *
 * Each registration:
 *   registrationId — stable identity shared by future provider-native projections
 *   event    — a Claude hook event (SessionStart | UserPromptSubmit | PreToolUse | PostToolUse | Stop | PreCompact)
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
    // The brief is the guard's only INFORMING surface. Every other decision hook enforces after the
    // fact — edit-guard denies a hand-write, stop-check nudges at turn end — which is too late to
    // stop an agent re-solving a settled problem from the code alone. Matches Scope globs, never text
    // similarity, so it needs no threshold and no model. Advisory only: it can neither block a write
    // nor auto-approve one.
    {
      registrationId: 'decisions:scope-brief',
      event: 'PreToolUse',
      matcher: 'Edit|Write|MultiEdit',
      command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/decision-scope-brief.mjs"',
      cursorEvent: 'preToolUse',
      cursorMatcher: 'Write',
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
  // The i-have-adhd output style is ALWAYS-ON by selection: the skill sets
  // disable-model-invocation, so nothing but this hook can start it. `compact` is in the matcher
  // deliberately — the style's "rest of the session" persistence is instruction text, not
  // enforcement, so it has to be re-asserted after a compaction or it silently decays.
  adhd: [
    {
      registrationId: 'adhd:session-start',
      event: 'SessionStart',
      matcher: 'startup|resume|clear|compact',
      command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/adhd-session-start.mjs"',
    },
    // The body above enters context once, then sits at a fixed early position while the conversation
    // grows — adherence falls with that distance, and proximity to the point of generation is what
    // recovers it. This re-states only the rules that decay first, immediately before each response.
    {
      registrationId: 'adhd:prompt-anchor',
      event: 'UserPromptSubmit',
      matcher: '',
      command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/adhd-prompt-anchor.mjs"',
    },
  ],
  // Deny-once step-0 ordering gate: the first ExitPlanMode or feature-critique dispatch in a
  // session with no recorded prior-art run is denied once (the denial writes a session snooze);
  // the PostToolUse half records prior-art runs. Carve-out ruled in
  // docs/decisions/devkit-gates-repo-not-harness.md (2026-08-09): it orders devkit's OWN shipped
  // workflow stages and reads only tool identity + subagent_type. Run detection is deliberately
  // PostToolUse-on-Task, NOT SubagentStop — that capture path stays dead code per
  // docs/decisions/prior-art-before-plan.md. No cursorEvent: Cursor has no ExitPlanMode/Task, so
  // nativeProjection skips Cursor entirely.
  // Base-drift advisories (sc-2297). SessionStart carries the whole-repo picture at the moment an
  // agent forms its mental model — the loss this prevents is booked at READ time, hours before any
  // gate runs. PreToolUse narrows to the exact file being written. Both are advisory: they emit
  // additionalContext and never a permissionDecision.
  //
  // Only the pre-edit half projects to Cursor: Cursor has no SessionStart equivalent, and
  // nativeProjection returns null per-registration, so the session hook is simply skipped there.
  baseDrift: [
    {
      registrationId: 'base-drift:session-start',
      event: 'SessionStart',
      matcher: 'startup|resume|clear|compact',
      command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/base-drift-session.mjs"',
    },
    {
      registrationId: 'base-drift:pre-edit',
      event: 'PreToolUse',
      matcher: 'Edit|Write|MultiEdit',
      command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/base-drift-brief.mjs"',
      cursorEvent: 'preToolUse',
      cursorMatcher: 'Write',
    },
  ],
  priorArtGate: [
    {
      registrationId: 'prior-art-gate:pre-plan',
      event: 'PreToolUse',
      matcher: 'ExitPlanMode|Task|Agent',
      command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/prior-art-gate.mjs"',
    },
    {
      registrationId: 'prior-art-gate:post-task',
      event: 'PostToolUse',
      matcher: 'Task|Agent',
      command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/prior-art-gate.mjs"',
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
  // fallow: devkit's staged-scope wrapper. Bound to the FALLOW component, not agentHooks — a repo
  // can adopt fallow without opting into the agent-hook bundle (the primary consumer does exactly
  // that). Bare runner + path so the Cursor mirror reduces cleanly.
  fallow: [
    {
      registrationId: 'fallow:pre-bash',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-staged-gate.sh"',
    },
  ],
};

/** Flatten the registrations for the given selected component ids into one ordered list. */
export function registrationsFor(componentIds: string[]): HookRegistration[] {
  return componentIds.flatMap((id) => HOOK_REGISTRATIONS[id] ?? []);
}
