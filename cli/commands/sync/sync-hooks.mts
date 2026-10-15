/**
 * `devkit sync-hooks` — copy devkit's bundled agent-hook scripts (agents-hooks/*) into the consumer's
 * provider-native hook directories and write .devkit/agent-hooks-manifest.json, so a hook like
 * decision-stop-check.sh is SOURCED from devkit + drift-tracked (like skills/agents) instead of
 * authored per-repo. Parallel to `sync-skills`/`sync-agents`, with two additions they don't need:
 *
 *   - `--only a.sh,b.mjs` : sync JUST the named hooks — incremental per-hook adoption. The manifest is
 *     carried forward (adds to the owned set), so a consumer can move hooks under devkit one at a time
 *     as each is verified behaviour-equivalent, without pulling the whole set.
 *   - `--targets claude,codex,cursor` : which surfaces to write. Defaults to recorded agentTargets.
 *
 * REGISTRATION-FREE: writes the hook FILES + manifest only. Unlike `devkit init`, it does NOT touch
 * settings.json hook wiring — the consumer owns their registrations (e.g. keeps knip off the Stop event).
 *
 *   devkit sync-hooks [--only <a.sh,b.mjs>] [--targets <claude,codex,cursor>] [--dry-run] [--force]
 */

import { join } from 'node:path';
import type { Selection } from '../../lib/components.mts';
import { detectGitRoot } from '../../lib/detect-git-root.mts';
import { readJson } from '../../lib/fs-helpers.mts';
import {
  isAgentProvider,
  resolveExistingAgentProviders,
  SUPPORTED_AGENT_PROVIDERS,
} from '../../lib/install/agent-assets/agent-providers.mts';
import {
  DECISION_EDIT_HOOK,
  DECISION_SCOPE_BRIEF_HOOK,
  selectedHookAssets,
} from '../../lib/install/hook-registration-ledger/selection.mts';
import { syncHookScripts } from '../../lib/install/install-hooks.mts';

// The relevant slice of `.devkit/config.json` this command reads.
interface DevkitConfig {
  components?: Partial<Selection>;
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
  agentFacing: false,
  notRoutedBecause:
    'A slice devkit upgrade composes from the recorded component selection, and devkit doctor ' +
    '--fix repairs. Both are routed; reaching for the slice by hand re-adds surfaces the ' +
    'consumer deselected.',
  summary: 'Copy devkit agent-hook scripts into selected providers (registration-free).',
  help: `devkit sync-hooks — copy devkit's agent-hook scripts into Claude, Codex, and Cursor and
write .devkit/agent-hooks-manifest.json (sha256 per file) so doctor can tell which side drifted.

Usage:
  devkit sync-hooks [--only <a.sh,b.mjs>] [--targets <claude,codex,cursor>] [--dry-run] [--force]

--only     sync just the named hooks (incremental per-hook adoption; ADDS to the owned set).
--targets  surfaces to write (claude|codex|cursor); default = the recorded agentTargets.
--force    overwrite a hook you diverged from devkit's (default PRESERVES yours).

Registration-free: writes the hook FILES + manifest only; your settings.json hook wiring stays yours.`,
};

export default function run(args: string[], cwd: string): number {
  const { gitRoot } = detectGitRoot(cwd);
  // Config is package-local in a monorepo even though hook assets are repo-wide.
  const configPath = join(cwd, '.devkit', 'config.json');
  const cfg: DevkitConfig | null = readJson(configPath);
  // With no recorded selection a full sync would select nothing and prune every devkit-owned hook.
  if (!cfg) {
    console.error(`sync-hooks: no ${configPath} — run devkit init first`);
    return 1;
  }
  const components = cfg.components ?? {};
  const only = listFlag(args, '--only');
  const decisions = components.guards?.includes('decisions') ?? false;
  const targets =
    listFlag(args, '--targets') ??
    resolveExistingAgentProviders(gitRoot, components.agentTargets, ['hooks']);
  const bad = targets.filter((target) => !isAgentProvider(target));
  if (bad.length) {
    console.error(
      `sync-hooks --targets: unknown surface ${bad.join(', ')} (use ${SUPPORTED_AGENT_PROVIDERS.join('|')})`,
    );
    return 1;
  }
  // Both decisions-owned scripts are registered ONLY by the decisions component, so installing one
  // without that guard leaves a script no registration ever invokes.
  const decisionsOnly = [DECISION_EDIT_HOOK, DECISION_SCOPE_BRIEF_HOOK].filter((hook) =>
    only?.includes(hook),
  );
  if (decisionsOnly.length && !decisions) {
    console.error(`sync-hooks: ${decisionsOnly.join(', ')} requires the decisions guard`);
    return 1;
  }
  const override = args.includes('--force') ? () => true : undefined;
  // The selection-to-scripts derivation init, upgrade and doctor share, so no component is missed.
  const desired = only ? undefined : selectedHookAssets(components).scripts;
  syncHookScripts(gitRoot, {
    dryRun: args.includes('--dry-run'),
    targets,
    only,
    desired,
    override,
  });
  return 0;
}
