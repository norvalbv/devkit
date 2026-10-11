#!/usr/bin/env node
/** SessionStart hook: warn when the base branch moved under files this branch changed. */
import { spawnSync } from 'node:child_process';

function main() {
  const run = spawnSync('devkit', ['base-status', '--json'], { encoding: 'utf8' });
  if (run.error || !run.stdout) return;
  const { overlap } = JSON.parse(run.stdout);
  if (overlap.length) console.log(`Base moved under: ${overlap.join(', ')}`);
}

try {
  main();
} catch {
  // A hook must never fail the session.
}
