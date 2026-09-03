/** Resolve anti-slop for an OVERLAY install: refuse-or-install, then grandfather existing debt. */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAntiSlopBaseline } from '../../../../commands/oxc/anti-slop.mts';
import { trackedPathPredicate } from '../../../git-tracked.mts';
import { addToGitExclude } from '../../overlay-excludes.mts';
import { OVERLAY_ENTRY_REL, OXLINT_CONFIGS } from '../../oxc/lifecycle.mts';
import { ANTI_SLOP_BASELINE_REL, ANTI_SLOP_MANIFEST_REL } from '../constants.mts';
import { removeAntiSlopCapability, syncAntiSlopCapability } from '../lifecycle.mts';

/**
 * Paths an overlay anti-slop install owns; git must track NONE, since `.git/info/exclude` cannot
 * hide a tracked file. Dirs not files: a partly tracked capability is refused, not half-projected.
 */
const OVERLAY_ANTI_SLOP_OWNED = [
  OVERLAY_ENTRY_REL,
  ANTI_SLOP_BASELINE_REL,
  '.devkit/oxc',
  '.devkit/anti-slop',
] as const;

/** What `installOverlay` needs back: whether to render the gate, and what to hide from git. */
interface OverlayAntiSlopWiring {
  wired: boolean;
  excludes: string[];
}

/** Reclaim a half-installed capability so no stranded managed tree outlives its gate. */
function abandon(cwd: string, reason: string): false {
  console.log(`  ! anti-slop ${reason} — skipping the gate.`);
  try {
    removeAntiSlopCapability(cwd, false);
  } catch {
    // Preserve the original failure; doctor reports and repairs any residual managed state.
  }
  return false;
}

/**
 * Install-or-reclaim plus the exclude entries the caller must add, in one step: excluded before the
 * install writes them, and deselection handled here since `applyOverlay` precedes `applyRemovals`.
 */
export function wireOverlayAntiSlop(
  cwd: string,
  gitRoot: string,
  pfx: string,
  sel: { antiSlop?: boolean },
  dryRun: boolean,
): OverlayAntiSlopWiring {
  let wired = false;
  if (sel.antiSlop) {
    console.log('  anti-slop (vendored Oxlint rules + per-clone baseline)');
    addToGitExclude(
      gitRoot,
      [`${pfx}${OVERLAY_ENTRY_REL}`, `${pfx}${ANTI_SLOP_BASELINE_REL}`],
      dryRun,
    );
    wired = resolveOverlayAntiSlop(cwd, gitRoot, pfx, dryRun);
  } else if (existsSync(join(cwd, ANTI_SLOP_MANIFEST_REL))) {
    console.log('  anti-slop (deselected — reclaiming)');
    removeAntiSlopCapability(cwd, dryRun);
  }
  const excludes = [OVERLAY_ENTRY_REL, ANTI_SLOP_BASELINE_REL]
    .filter((rel) => wired || existsSync(join(cwd, rel)))
    .map((rel) => `${pfx}${rel}`);
  return { wired, excludes };
}

/**
 * Returns whether to wire the gate; the hook renders from `selection.antiSlop`, so this comes first.
 * A missing baseline BLOCKS, so create it here — if absent, never `--force` (overlay-self-heal).
 */
export function resolveOverlayAntiSlop(
  cwd: string,
  gitRoot: string,
  pfx: string,
  dryRun: boolean,
): boolean {
  if (dryRun) {
    console.log('  [dry-run] anti-slop: sync capability → baseline-if-absent → gate in hook');
    return true;
  }
  const isTracked = trackedPathPredicate(gitRoot);
  const tracked = OVERLAY_ANTI_SLOP_OWNED.filter((rel) => isTracked(`${pfx}${rel}`));
  if (tracked.length > 0) {
    console.log(
      `  ! anti-slop skipped — git already TRACKS ${tracked.join(', ')}; an overlay cannot hide a tracked path.`,
    );
    console.log(
      '    Remove the package-mode install first (`devkit clean`, or `git rm -r --cached <paths>` and commit).',
    );
    return false;
  }
  // `-c` replaces discovery outright, so a consumer's own Oxlint config would stop being read;
  // refusing beats silently overriding a linter config in a repo devkit does not own.
  const consumerConfig = OXLINT_CONFIGS.find((name) => existsSync(join(cwd, name)));
  if (consumerConfig) {
    console.log(
      `  ! anti-slop skipped — this repo has its own ${consumerConfig}, which an overlay install cannot compose with yet.`,
    );
    console.log(
      '    Overlay passes `-c oxlint.devkit.json`, and that replaces config discovery rather than extending it.',
    );
    return false;
  }
  try {
    syncAntiSlopCapability(cwd, { overlay: true });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return abandon(cwd, `could not be installed (${detail})`);
  }
  if (existsSync(join(cwd, ANTI_SLOP_BASELINE_REL))) {
    console.log(`  ✓ anti-slop baseline present (${ANTI_SLOP_BASELINE_REL}) — not re-snapshotted`);
    return true;
  }
  console.log('  adopting existing debt into a per-clone baseline (whole repository)...');
  if (createAntiSlopBaseline(cwd, [], false, false) !== 0) {
    return abandon(cwd, 'baseline could not be created');
  }
  return true;
}
