#!/usr/bin/env node

/**
 * guard-ui-evidence — the ship-time screenshot reminder (see check.mts). Always exits 0: a crash
 * in a reminder must never block a commit or a ship.
 */

import { runUiEvidence } from './check.mts';

if (process.argv[2] === '--help') {
  console.log(
    'Usage: guard-ui-evidence   (run by the pre-commit hook; speaks only during devkit ship)',
  );
  process.exit(0);
}

try {
  process.exit(runUiEvidence());
} catch (e) {
  console.error(`guard-ui-evidence: ${e instanceof Error ? e.message : e}`);
  process.exit(0);
}
