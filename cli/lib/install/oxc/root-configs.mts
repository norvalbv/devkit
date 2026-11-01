/** Consumer-owned Oxc root configs: discovery names, devkit's starters, and who owns which file. */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { overlayInstall } from '../../../../gate-engine/overlay-mode.mts';
import { writeFileAtomic } from '../../atomic-write.mts';
import { digest, packageDir } from '../../fs-helpers.mts';
import { OVERLAY_ENTRY_REL } from './overlay-entry.mts';

// Exactly the names Oxlint discovers (measured on 1.78 and 1.85): `oxlint.config.{js,mjs,cjs,cts}` is
// never read as a config, so it carries no ignores to honour.
export const OXLINT_CONFIGS = [
  '.oxlintrc.json',
  '.oxlintrc.jsonc',
  'oxlint.config.ts',
  'oxlint.config.mts',
];
// Package assets so devkit's own format:check holds them byte-stable under the hook's Oxfmt.
const starter = (name: string) => readFileSync(join(packageDir(), 'oxc', name), 'utf8');
export const OXLINT_STARTER = starter('oxlintrc.starter.json');
export const OXFMT_STARTER = starter('oxfmtrc.starter.json');
/** Retired consumer formatter configs: while one remains, its intent is not yet in .oxfmtrc.json. */
export const BIOME_CONFIGS = ['biome.json', 'biome.jsonc'];

export interface ConfigOwnership {
  path: string;
  createdDigest: string | null;
}

export const fileDigest = (path: string): string => digest(readFileSync(path));

export function candidates(cwd: string, names: string[]): string[] {
  return names.filter((name) => existsSync(join(cwd, name)));
}

/** A root config the refresh rewrote (or a dry run would): path, prior bytes, and the new starter. */
export type RefreshedConfig = [path: string, before: string, written: string];

/** A config devkit created and nobody edited takes the current starter; any edit keeps it as is. */
function refreshedStarter(
  cwd: string,
  previous: ConfigOwnership,
  starter: string,
  dryRun: boolean,
  rewrites: RefreshedConfig[],
): ConfigOwnership {
  const created = previous.createdDigest;
  const path = join(cwd, previous.path);
  if (created === digest(starter) || created !== fileDigest(path)) return previous;
  rewrites.push([previous.path, readFileSync(path, 'utf8'), starter]);
  if (!dryRun) writeFileAtomic(path, starter);
  return { path: previous.path, createdDigest: digest(starter) };
}

export function ownershipFor(
  cwd: string,
  names: string[],
  starterPath: string,
  starter: string,
  previous: ConfigOwnership | undefined,
  dryRun: boolean,
  /** Present = refresh unedited starters, recording each rewrite so a failed sync can undo it. */
  rewrites?: RefreshedConfig[],
): ConfigOwnership {
  const found = candidates(cwd, names);
  if (found.length === 1) {
    const path = found[0];
    if (previous?.path !== path) return { path, createdDigest: null };
    return rewrites ? refreshedStarter(cwd, previous, starter, dryRun, rewrites) : previous;
  }
  // Last line of defence: makes a visible root config UNREACHABLE while the repo is still overlaid,
  // even with every mode signal lost. Both remedies are named — the caller's intent is ambiguous.
  if (overlayInstall(cwd)) {
    throw new Error(
      `refusing to create ${starterPath} in an overlay install: overlay writes no tracked root config. To stay on overlay, run \`devkit init --overlay\` (restores ${OVERLAY_ENTRY_REL}). To convert this repo to a package install, run \`devkit clean\` first.`,
    );
  }
  if (!dryRun) writeFileAtomic(join(cwd, starterPath), starter);
  return { path: starterPath, createdDigest: digest(starter) };
}

const DEVKIT_BIOME_STATE = ['biome.devkit.jsonc', '.devkit/biome'];

/** Upgrade's notice for retired Biome state, or null. Overlay never owned the repo's Biome config. */
export function retiredBiomeNotice(cwd: string, recorded: boolean, overlay = false): string | null {
  const found = candidates(
    cwd,
    overlay ? DEVKIT_BIOME_STATE : [...BIOME_CONFIGS, ...DEVKIT_BIOME_STATE],
  );
  if (recorded && !overlay) found.unshift('components.biome');
  if (!found.length) return null;
  const lead = `  • devkit no longer ships Biome (found ${found.join(', ')}):`;
  if (overlay) return `${lead} delete those devkit leftovers`;
  return `${lead} carry its formatter options into .oxfmtrc.json ({"ignorePatterns":["**"]} opts out), delete those files, @biomejs/biome and its lint/format scripts, re-run \`devkit upgrade\`, then commit one \`bun run format\` pass on its own`;
}
