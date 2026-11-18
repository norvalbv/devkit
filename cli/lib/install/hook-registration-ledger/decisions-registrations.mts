import type { HookRegistration } from './registrations.mts';

/** HOOK_REGISTRATIONS.decisions, in its own file so the decisions-brief benchmark fingerprints
 * exactly the registrations it runs (docs/benchmarks/catalog.json hashes whole files). */
export const DECISIONS_REGISTRATIONS: HookRegistration[] = [
  {
    registrationId: 'decisions:pre-edit',
    event: 'PreToolUse',
    matcher: 'Edit|Write|MultiEdit|Delete',
    command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/decision-edit-guard.mjs"',
    cursorEvent: 'preToolUse',
    cursorMatcher: 'Write|Delete',
  },
  // The guard's only informing surface: it matches Scope globs (no threshold, no model) before an
  // edit, and is advisory only, so it can neither block a write nor auto-approve one.
  {
    registrationId: 'decisions:scope-brief',
    event: 'PreToolUse',
    matcher: 'Edit|Write|MultiEdit',
    command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/decision-scope-brief.mjs"',
    cursorEvent: 'preToolUse',
    cursorMatcher: 'Write',
  },
];
