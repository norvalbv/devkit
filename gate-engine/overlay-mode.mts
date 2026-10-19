/**
 * Is this root a local-only overlay install? Two signals, because init freezes ratchet baselines
 * before `.devkit/config.json` exists; a WRITER of managed state must use an explicit flag instead.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { primaryCheckout } from './co-occurrence/index-refresh.mts';
import { cmpSemver, devkitVersion } from './devkit-version.mts';
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

const RELEASE = /^\d+\.\d+\.\d+$/;
/** The overlay pin init writes: `devkitRef: "v<semver>"`; a branch or SHA ref does not parse. */
const OverlayPin = z.object({
  overlay: z.literal(true),
  devkitRef: z.string().regex(/^v\d+\.\d+\.\d+$/),
});

/**
 * An overlay's gates run the global devkit, not the `devkitRef` it pins. When that global is OLDER,
 * print why and return true; a newer global, a branch/SHA pin or an unreadable config proceed.
 */
export function reportOlderOverlayRunner(root: string, running = devkitVersion()): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, '.devkit', 'config.json'), 'utf8'));
  } catch {
    return false; // no or malformed config: selectedIds already decides what that run means
  }
  const parsed = OverlayPin.safeParse(raw);
  if (!parsed.success || !RELEASE.test(running)) return false;
  const pinned = parsed.data.devkitRef.slice(1);
  if (cmpSemver(running, pinned) >= 0) return false;
  console.error(
    `✗ devkit: global devkit ${running} is running these gates, but this overlay pins v${pinned} (devkitRef in .devkit/config.json) — older gate code would judge this commit.`,
  );
  console.error(`   Run: bun add -g @norvalbv/devkit#v${pinned}, then devkit doctor --fix`);
  return true;
}
