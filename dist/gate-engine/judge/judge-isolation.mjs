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
// Git's per-repository environment. Git EXPORTS these into a hook's environment, and for a hook run
// in a LINKED WORKTREE (which is exactly how `devkit ship` commits) the values are ABSOLUTE:
//   GIT_DIR=<repo>/.git/worktrees/<name>   GIT_INDEX_FILE=<repo>/.git/worktrees/<name>/index
// Every descendant inherits them — the gate chain, and the `claude` judges it spawns. A judge is an
// agent with Bash + file tools that touches OTHER repositories (Claude Code refreshes its plugin
// marketplace clones with git), and any git command it runs then reads/writes the SHIP WORKTREE's
// index instead of its own. That is not hypothetical: it replaced a ship's staged diff with a
// foreign 216-entry index, turning the pending commit into a whole-repo deletion.
//
// So a judge is spawned with these stripped. Nothing is lost: judges run with `cwd` inside the
// worktree, where ordinary git discovery resolves the same repository and the same index through the
// worktree's `.git` file — the env vars only ever override that resolution WRONGLY once the judge
// steps outside.
//
// MUST stay identical to `_review_worktree_clear_git_env` in cli/lib/ship/review/worktrees.sh (the
// same scrub, applied to `devkit review`'s worktree primitives). A test asserts the two lists match.
export const GIT_ENV_VARS = [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CONFIG',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
    'GIT_OBJECT_DIRECTORY',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_IMPLICIT_WORK_TREE',
    'GIT_GRAFT_FILE',
    'GIT_INDEX_FILE',
    'GIT_NO_REPLACE_OBJECTS',
    'GIT_REPLACE_REF_BASE',
    'GIT_PREFIX',
    'GIT_SHALLOW_FILE',
    'GIT_COMMON_DIR',
    'GIT_GLOB_PATHSPECS',
    'GIT_NOGLOB_PATHSPECS',
    'GIT_LITERAL_PATHSPECS',
    'GIT_ICASE_PATHSPECS',
];
/** A copy of `env` with every GIT_ENV_VARS name removed. Everything else is preserved verbatim. */
export function withoutGitEnv(env = process.env) {
    const clean = { ...env };
    for (const name of GIT_ENV_VARS)
        delete clean[name];
    return clean;
}
