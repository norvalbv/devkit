/**
 * `devkit sync-hooks` — copy devkit's bundled agent-hook scripts (agents-hooks/*) into the consumer's
 * .claude/hooks (+ .cursor/hooks) and write .devkit/agent-hooks-manifest.json, so a hook like
 * decision-stop-check.sh is SOURCED from devkit + drift-tracked (like skills/agents) instead of
 * authored per-repo. Parallel to `sync-skills`/`sync-agents`, with two additions they don't need:
 *
 *   - `--only a.sh,b.mjs` : sync JUST the named hooks — incremental per-hook adoption. The manifest is
 *     carried forward (adds to the owned set), so a consumer can move hooks under devkit one at a time
 *     as each is verified behaviour-equivalent, without pulling the whole set.
 *   - `--targets claude,cursor` : which surfaces to write. Defaults to the recorded agentTargets so a
 *     consumer that never took `.cursor/hooks` won't grow one.
 *
 * REGISTRATION-FREE: writes the hook FILES + manifest only. Unlike `devkit init`, it does NOT touch
 * settings.json hook wiring — the consumer owns their registrations (e.g. keeps knip off the Stop event).
 *
 *   devkit sync-hooks [--only <a.sh,b.mjs>] [--targets <claude,cursor>] [--dry-run] [--force]
 */

import { join } from 'node:path';
import { AGENT_TARGETS } from '../../lib/components.mts';
import { detectGitRoot } from '../../lib/detect-git-root.mts';
import { readJson } from '../../lib/fs-helpers.mts';
import {
  DECISION_EDIT_HOOK,
  hookScriptsFor,
  syncHookScripts,
} from '../../lib/install/install-hooks.mts';

// The relevant slice of `.devkit/config.json` this command reads.
interface DevkitConfig {
  components?: {
    agentTargets?: string[];
    agentHooks?: boolean;
    guards?: string[];
  };
}

// `--flag a,b` → ['a','b']; undefined when the flag is absent (so a caller-default can apply).
function listFlag(args: string[], name: string): string[] | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return (args[i + 1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const meta = {
  name: 'sync-hooks',
  summary:
    'Copy devkit agent-hook scripts into .claude/hooks + write the manifest (registration-free).',
  help: `devkit sync-hooks — copy devkit's agent-hook scripts into .claude/hooks (+ .cursor/hooks) and
write .devkit/agent-hooks-manifest.json (sha256 per file) so doctor can tell which side drifted.

Usage:
  devkit sync-hooks [--only <a.sh,b.mjs>] [--targets <claude,cursor>] [--dry-run] [--force]

--only     sync just the named hooks (incremental per-hook adoption; ADDS to the owned set).
--targets  surfaces to write (claude|cursor); default = the recorded agentTargets.
--force    overwrite a hook you diverged from devkit's (default PRESERVES yours).

Registration-free: writes the hook FILES + manifest only; your settings.json hook wiring stays yours.`,
};

export default function run(args: string[], cwd: string): number {
  const { gitRoot } = detectGitRoot(cwd);
  const cfg: DevkitConfig | null = readJson(join(gitRoot, '.devkit', 'config.json'));
  const only = listFlag(args, '--only');
  const decisions = cfg?.components?.guards?.includes('decisions') ?? false;
  const targets = listFlag(args, '--targets') ?? cfg?.components?.agentTargets ?? AGENT_TARGETS;
  const bad = targets.filter((t) => !AGENT_TARGETS.includes(t));
  if (bad.length) {
    console.error(
      `sync-hooks --targets: unknown surface ${bad.join(', ')} (use ${AGENT_TARGETS.join('|')})`,
    );
    return 1;
  }
  if (only?.includes(DECISION_EDIT_HOOK) && !decisions) {
    console.error('sync-hooks: decision-edit-guard.mjs requires the decisions guard');
    return 1;
  }
  const override = args.includes('--force') ? () => true : undefined;
  const desired = only ? undefined : hookScriptsFor({ agentHooks: true, decisions });
  syncHookScripts(gitRoot, {
    dryRun: args.includes('--dry-run'),
    targets,
    only,
    desired,
    override,
  });
  return 0;
}
