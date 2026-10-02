/**
 * Is this root a local-only overlay install? Two signals, because init freezes ratchet baselines
 * before `.devkit/config.json` exists; a WRITER of managed state must use an explicit flag instead.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { primaryCheckout } from './co-occurrence/index-refresh.mts';
import { gitPrefix } from './ratchets/git-index.mts';

/** `.devkit/config.json` sets `overlay: true`; a missing or unparseable config throws. */
export function overlayConfigured(root: string): boolean {
  // SAFETY: init owns this local JSON marker; strict equality treats any other shape as false.
  const config = JSON.parse(readFileSync(join(root, '.devkit/config.json'), 'utf8')) as {
    overlay?: unknown;
  };
  return config.overlay === true;
}

/** The root's own overlay flag; undefined only when this checkout has no config.json at all. */
function configuredOverlay(root: string): boolean | undefined {
  try {
    return overlayConfigured(root);
  } catch (error) {
    // SAFETY: Node filesystem failures carry ErrnoException.code; a parse error carries none.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : false;
  }
}

export function overlayInstall(root: string): boolean {
  if (process.env.DEVKIT_OVERLAY === '1') return true;
  const own = configuredOverlay(root);
  if (own !== undefined) return own;
  // Overlay is a repository property: a ship gate worktree is projected its baselines but not
  // config.json, so it answers from the primary checkout.
  const primary = primaryCheckout(root);
  return primary !== null && configuredOverlay(join(primary, gitPrefix(root))) === true;
}
