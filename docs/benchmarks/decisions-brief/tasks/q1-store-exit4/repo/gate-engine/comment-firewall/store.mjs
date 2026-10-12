import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Where sightings live. One empty file per paragraph anchor. */
export function storeDir() {
  return process.env.COMMENT_SHOWN_DIR ?? path.join('.git', 'devkit', 'comment-shown');
}

/** Has this paragraph been shown before? */
export function seen(anchor) {
  return existsSync(path.join(storeDir(), anchor));
}

/** Records that this paragraph was shown. */
export function record(anchor) {
  mkdirSync(storeDir(), { recursive: true });
  writeFileSync(path.join(storeDir(), anchor), '', { flag: 'wx' });
}
