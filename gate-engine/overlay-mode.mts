/**
 * Is this root a local-only overlay install? Two signals, because init freezes ratchet baselines
 * before `.devkit/config.json` exists; a WRITER of managed state must use an explicit flag instead.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { primaryCheckout } from './co-occurrence/index-refresh.mts';
import { gitPrefix } from './ratchets/git-index.mts';

/** The root's own overlay flag; undefined only when this checkout has no config.json at all. */
function configuredOverlay(root: string): boolean | undefined {
  let text: string;
  try {
    text = readFileSync(join(root, '.devkit/config.json'), 'utf8');
  } catch (error) {
    // SAFETY: Node filesystem failures carry ErrnoException.code.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : false;
  }
  try {
    // SAFETY: init owns this local JSON marker; strict equality treats absent values as false.
    return (JSON.parse(text) as { overlay?: boolean }).overlay === true;
  } catch {
    return false;
  }
}

export function overlayInstall(root: string): boolean {
  if (process.env.DEVKIT_OVERLAY === '1') return true;
  const own = configuredOverlay(root);
  if (own !== undefined) return own;
  // Overlay is a repository property: a ship gate worktree is projected its baselines but not
  // config.json, so it answers from the primary checkout (as gate_overlay_root does in shell).
  const primary = primaryCheckout(root);
  return primary !== null && configuredOverlay(join(primary, gitPrefix(root))) === true;
}
