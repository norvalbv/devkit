#!/usr/bin/env node
/** Print ship's overlay root for `<root>` (see shipOverlayRoot); nothing when the repo is not overlay. */
import { shipOverlayRoot } from './overlay-home.mts';

try {
  const root = shipOverlayRoot(process.argv[2] ?? process.cwd());
  if (root) process.stdout.write(`${root}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
