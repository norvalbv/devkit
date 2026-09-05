/** Make an inherited base snapshot judgeable by the RUNNING capability, and name it when it is not. */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withLock } from '../../atomic-write.mts';
import { OVERLAY_ENTRY_REL } from '../oxc/lifecycle.mts';
import { ANTI_SLOP_MANAGED_REL } from './constants.mts';
import { withAntiSlopCapabilityLock } from './lifecycle.mts';

/**
 * The paths that must travel together for a tree to be judgeable — git-excluded in overlay, so a
 * snapshot must be handed them, entry config included because the snapshot's manifest names it.
 */
const MANAGED_RELS = ['.devkit/oxc', ANTI_SLOP_MANAGED_REL, OVERLAY_ENTRY_REL];
const OXC_LOCK_REL = '.devkit/oxc.lock';

/**
 * Hold BOTH managed-capability locks, in the order `syncAntiSlopCapability` takes them.
 * The anti-slop lock alone leaves `.devkit/oxc` free for an Oxc-only writer to republish.
 */
export function withManagedCapabilityLock<T>(cwd: string, action: () => T): T {
  return withAntiSlopCapabilityLock(cwd, () => withLock(join(cwd, OXC_LOCK_REL), action));
}

/** Distinguishes "this tree is unjudgeable" from every other lint failure, without matching prose. */
export class AntiSlopCapabilityError extends Error {
  readonly issue: string;

  constructor(issue: string) {
    super(
      `anti-slop capability is not fully integrated (${issue}); refusing an incomplete baseline`,
    );
    this.name = 'AntiSlopCapabilityError';
    this.issue = issue;
  }
}

/**
 * Replace `toCwd`'s managed capability with `fromCwd`'s, so both lint under ONE ruleset (sc-2084).
 * Copies rather than publishes: `fromCwd` was just linted, and a sync would re-run the write guard.
 */
export function adoptManagedCapability(fromCwd: string, toCwd: string): void {
  for (const rel of MANAGED_RELS) {
    const source = join(fromCwd, rel);
    if (!existsSync(source)) continue;
    const target = join(toCwd, rel);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
}
