/** Who owns a root Oxc config: an adopted consumer file, or a starter devkit wrote and may update. */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { overlayInstall } from '../../../../gate-engine/overlay-mode.mts';
import { writeFileAtomic } from '../../atomic-write.mts';
import { digest } from '../../fs-helpers.mts';
import { OVERLAY_ENTRY_REL } from './overlay-entry.mts';

export interface ConfigOwnership {
  path: string;
  createdDigest: string | null;
}

/** Where a root config should come from, and which untouched older starter it may replace. */
export interface StarterPlan {
  starterPath: string;
  /** Computed only when a file is actually written, so an adopted config costs nothing. */
  starter: () => string;
  /** A starter an older devkit wrote; still byte-identical on disk, it is replaced by `starter`. */
  replaces?: string;
}

/** The names from `names` that exist in `cwd`. */
export function candidates(cwd: string, names: string[]): string[] {
  return names.filter((name) => existsSync(join(cwd, name)));
}

/** Adopt the one existing config, refresh an untouched older starter, or write a fresh starter. */
export function ownershipFor(
  cwd: string,
  names: string[],
  plan: StarterPlan,
  previous: ConfigOwnership | undefined,
  dryRun: boolean,
): ConfigOwnership {
  const found = candidates(cwd, names);
  if (found.length === 1) {
    const path = found[0];
    const kept = previous?.path === path ? previous : { path, createdDigest: null };
    const stale = () =>
      plan.replaces !== undefined &&
      kept.createdDigest === digest(plan.replaces) &&
      digestOrNull(join(cwd, path)) === kept.createdDigest;
    if (!stale()) return kept;
    const text = plan.starter();
    // Deriving a starter takes long enough for the consumer to edit the file meanwhile: re-check.
    return stale() ? write(cwd, path, text, dryRun) : kept;
  }
  // Last line of defence: makes a visible root config UNREACHABLE while the repo is still overlaid,
  // even with every mode signal lost. Both remedies are named — the caller's intent is ambiguous.
  if (overlayInstall(cwd)) {
    throw new Error(
      `refusing to create ${plan.starterPath} in an overlay install: overlay writes no tracked root config. To stay on overlay, run \`devkit init --overlay\` (restores ${OVERLAY_ENTRY_REL}). To convert this repo to a package install, run \`devkit clean\` first.`,
    );
  }
  const text = plan.starter();
  // A config the consumer created while the starter was derived is theirs, as one found above is.
  const appeared = candidates(cwd, names);
  if (appeared.length > 0) return { path: appeared[0], createdDigest: null };
  return write(cwd, plan.starterPath, text, dryRun);
}

/** A file's digest, or null once it is gone: a consumer may delete it between any two reads. */
function digestOrNull(path: string): string | null {
  try {
    return digest(readFileSync(path));
  } catch {
    return null;
  }
}

function write(cwd: string, path: string, text: string, dryRun: boolean): ConfigOwnership {
  if (!dryRun) writeFileAtomic(join(cwd, path), text);
  return { path, createdDigest: digest(text) };
}
