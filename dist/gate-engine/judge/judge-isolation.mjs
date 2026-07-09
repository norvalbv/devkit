// Flags that isolate a `claude -p` gate judge from the host repo. Shared across every claude-p gate
// (the judge-gate factory and any thin caller: vision / sentry / critique / decisions). Each gate
// splices these into its OWN execFileSync (keeping its own model/timeout/tools/cascade) — only the
// isolation flags are shared, the divergent parts stay local.
//
//   JUDGE_ISOLATION — apply to EVERY judge call:
//     · --settings {"disableAllHooks":true}  → the host repo's hooks never fire in the judge
//       subprocess. Without this, an auto-fix Stop hook (which `--write`s files) corrupts the
//       run, and Pre/PostToolUse hooks leak the host session's context into the judgement.
//     · --no-session-persistence             → the judge leaves NO transcript in the session store.
//       Without this, every gate call clogged the session picker ("You judge…", "You are judging…").
//   JUDGE_READ_ONLY — add ONLY to PURE TEXT judges (no tool use). Removes all tools from context.
//     Do NOT add to a judge that must investigate (an align/escalate pass that reads files and runs
//     `git diff` via --allowedTools) — read-only would strip the tools it needs.
//
// Ordering note: `--disallowedTools` / `--allowedTools` are VARIADIC. Splice JUDGE_READ_ONLY BEFORE
// JUDGE_ISOLATION (so `--no-session-persistence`, a boolean flag, sits right before the positional
// prompt and the variadic `--disallowedTools *` is bounded by the following `--settings`). For an
// allowedTools gate, keep `--allowedTools <tools>` LAST so its variadic consumes only the tool list.
export const JUDGE_ISOLATION = [
    '--settings',
    '{"disableAllHooks":true}',
    '--no-session-persistence',
];
export const JUDGE_READ_ONLY = ['--disallowedTools', '*'];
