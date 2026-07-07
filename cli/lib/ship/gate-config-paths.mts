#!/usr/bin/env node
/**
 * Emit the CONFIG-DRIVEN gate-input paths for `link-gate-configs.sh`, one relative path per line.
 *
 * A `devkit ship` commits inside an ephemeral worktree checked out clean at $BASE, so it holds only
 * TRACKED files. link-gate-configs.sh symlinks gate inputs that live in the repo but aren't in that
 * checkout (an untracked config, a gitignored index) so the worktree gates match a plain commit. The
 * gate inputs whose LOCATION is configurable — `indexPath` (default null, no universal default),
 * `allowlistPath`, and `decisionsDir` — must be READ from guard.config.json, not hardcoded: decision
 * synced-assets-layout-agnostic mandates resolving roots from the consumer's config, never a fixed
 * layout (a custom decisionsDir that isn't committed would otherwise never reach the worktree). The rest
 * (guard.config.json itself, the fallow files, the caches) are devkit's own fixed artifact names and
 * stay hardcoded in the shell.
 *
 * Usage:  gate-config-paths.mjs [<root>]   # root defaults to cwd; prints e.g. ".search-code/index.db"
 * Emits nothing (exit 0) when a field is unset/opted-out or resolves outside the repo. A throw from
 * resolveGuardConfig (an unparseable guard.config.json) surfaces as a non-zero exit; the shell caller
 * falls back to its hardcoded set and lets the worktree gate fail loud on the same bad config.
 */
import { relative } from 'node:path';
import { resolveFromCwd, resolveGuardConfig } from '../../../gate-engine/config.mts';

const root = process.argv[2] ?? process.cwd();
const cfg = resolveGuardConfig(root);

for (const field of ['indexPath', 'allowlistPath', 'decisionsDir'] as const) {
  const abs = resolveFromCwd(cfg, field);
  if (!abs) continue; // opted-out (indexPath null) → nothing to link
  const rel = relative(root, abs);
  // A path inside the repo is what we can symlink into the worktree by the same relative name; an
  // absolute path elsewhere (rel starts with `..`) is the consumer's own business — skip it.
  if (rel && !rel.startsWith('..')) process.stdout.write(`${rel}\n`);
}
