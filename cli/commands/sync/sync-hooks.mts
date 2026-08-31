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
import { AGENT_TARGETS } from '../../lib/components.mts';
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
  hookScriptsFor,
} from '../../lib/install/hook-registration-ledger/selection.mts';
import { syncHookScripts } from '../../lib/install/install-hooks.mts';

// The relevant slice of `.devkit/config.json` this command reads.
interface DevkitConfig {
  components?: {
    agentTargets?: string[];
    agentHooks?: boolean;
    fallow?: boolean;
    adhd?: boolean;
    priorArtGate?: boolean;
    baseDrift?: boolean;
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
  const cfg: DevkitConfig | null = readJson(join(cwd, '.devkit', 'config.json'));
  const only = listFlag(args, '--only');
  const decisions = cfg?.components?.guards?.includes('decisions') ?? false;
  // The fallow staged gate belongs to the FALLOW component, so a full sync must read the recorded
  // selection: omitting it makes `desired` exclude an installed gate, and exact reconciliation then
  // prunes it as deselected — silently disabling the gate on every `devkit sync-hooks`.
  const fallow = cfg?.components?.fallow ?? false;
  // Same reason as fallow above: the adhd SessionStart hook is owned by the ADHD component, so a
  // full sync that ignored the recorded selection would prune an installed hook as deselected.
  const adhd = cfg?.components?.adhd ?? false;
  // Same again: the prior-art gate hook is owned by the priorArtGate component.
  const priorArtGate = cfg?.components?.priorArtGate ?? false;
  // And again for base-drift: reading it here is what stops a full sync PRUNING an installed
  // hook as though the component had been deselected.
  const baseDrift = cfg?.components?.baseDrift ?? false;
  const explicitTargets = listFlag(args, '--targets');
  const targets =
    explicitTargets ??
    (cfg
      ? resolveExistingAgentProviders(gitRoot, cfg.components?.agentTargets, ['hooks'])
      : AGENT_TARGETS);
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
  const desired = only
    ? undefined
    : hookScriptsFor({ agentHooks: true, decisions, fallow, adhd, priorArtGate, baseDrift });
  syncHookScripts(gitRoot, {
    dryRun: args.includes('--dry-run'),
    targets,
    only,
    desired,
    override,
  });
  return 0;
}
