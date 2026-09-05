/**
 * Is this root a local-only overlay install? Two signals, because init freezes ratchet baselines
 * before `.devkit/config.json` exists; a WRITER of managed state must use an explicit flag instead.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function overlayInstall(root: string): boolean {
  if (process.env.DEVKIT_OVERLAY === '1') return true;
  try {
    // SAFETY: init owns this local JSON marker; strict equality treats absent values as false.
    const config = JSON.parse(readFileSync(join(root, '.devkit/config.json'), 'utf8')) as {
      overlay?: boolean;
    };
    return config.overlay === true;
  } catch {
    return false;
  }
}
