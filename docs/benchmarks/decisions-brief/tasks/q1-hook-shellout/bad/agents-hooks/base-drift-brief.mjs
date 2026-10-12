#!/usr/bin/env node
/** SessionStart hook: warn when the base branch moved under files this branch changed. */
import { baseStatus, branchPaths } from '../cli/lib/ship/base-drift/core.mjs';

function main() {
  const { overlap } = baseStatus(branchPaths());
  if (overlap.length) console.log(`Base moved under: ${overlap.join(', ')}`);
}

try {
  main();
} catch {
  // A hook must never fail the session.
}
