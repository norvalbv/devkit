/**
 * `devkit sync-hooks` — copy devkit's bundled agent-hook scripts (agents-hooks/*) into the consumer's
 * .claude/hooks (+ .cursor/hooks, opt-in .codex/hooks) and write
 * .devkit/agent-hooks-manifest.json, so a hook like
 * decision-stop-check.sh is SOURCED from devkit + drift-tracked (like skills/agents) instead of
 * authored per-repo. Parallel to `sync-skills`/`sync-agents`, with two additions they don't need:
 *
 *   - `--only a.sh,b.mjs` : sync JUST the named hooks — incremental per-hook adoption. The manifest is
 *     carried forward (adds to the owned set), so a consumer can move hooks under devkit one at a time
 *     as each is verified behaviour-equivalent, without pulling the whole set.
 *   - `--targets claude,cursor,codex` : which surfaces to write. Defaults to the recorded agentTargets so a
 *     consumer that never took `.cursor/hooks` won't grow one.
 *
 * REGISTRATION-FREE: writes the hook FILES + manifest only. Unlike `devkit init`, it does NOT touch
 * settings.json hook wiring — the consumer owns their registrations (e.g. keeps knip off the Stop event).
 *
 *   devkit sync-hooks [--only <a.sh,b.mjs>] [--targets <claude,cursor>] [--dry-run] [--force]
 */
import { join } from 'node:path';
import { AGENT_TARGETS, DEFAULT_AGENT_TARGETS } from "../../lib/components.mjs";
import { detectGitRoot } from "../../lib/detect-git-root.mjs";
import { readJson } from "../../lib/fs-helpers.mjs";
import { syncHookScripts } from "../../lib/install/install-hooks.mjs";
// `--flag a,b` → ['a','b']; undefined when the flag is absent (so a caller-default can apply).
function listFlag(args, name) {
    const i = args.indexOf(name);
    if (i === -1)
        return undefined;
    return (args[i + 1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}
export const meta = {
    name: 'sync-hooks',
    summary: 'Copy devkit agent-hook scripts into .claude/hooks + write the manifest (registration-free).',
    help: `devkit sync-hooks — copy devkit's agent-hook scripts into .claude/hooks (+ .cursor/hooks;
opt-in .codex/hooks) and
write .devkit/agent-hooks-manifest.json (sha256 per file) so doctor can tell which side drifted.

Usage:
  devkit sync-hooks [--only <a.sh,b.mjs>] [--targets <claude,cursor,codex>] [--dry-run] [--force]

--only     sync just the named hooks (incremental per-hook adoption; ADDS to the owned set).
--targets  surfaces to write (claude|cursor|codex); default = recorded targets or claude,cursor.
--force    overwrite a hook you diverged from devkit's (default PRESERVES yours).

Registration-free: writes the hook FILES + manifest only; your settings.json hook wiring stays yours.`,
};
export default function run(args, cwd) {
    const { gitRoot } = detectGitRoot(cwd);
    const cfg = readJson(join(gitRoot, '.devkit', 'config.json'));
    const only = listFlag(args, '--only');
    const targets = listFlag(args, '--targets') ?? cfg?.components?.agentTargets ?? DEFAULT_AGENT_TARGETS;
    const bad = targets.filter((t) => !AGENT_TARGETS.includes(t));
    if (bad.length) {
        console.error(`sync-hooks --targets: unknown surface ${bad.join(', ')} (use ${AGENT_TARGETS.join('|')})`);
        return 1;
    }
    const override = args.includes('--force') ? () => true : undefined;
    syncHookScripts(gitRoot, { dryRun: args.includes('--dry-run'), targets, only, override });
    return 0;
}
