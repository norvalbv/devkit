#!/usr/bin/env node
import { baseStatus, branchPaths } from './lib/ship/base-drift/core.mjs';

const [command, ...flags] = process.argv.slice(2);
if (command === 'base-status') {
  const status = baseStatus(branchPaths());
  if (flags.includes('--json')) console.log(JSON.stringify(status));
  else console.log(status.overlap.length ? `base moved under: ${status.overlap.join(', ')}` : 'base clean');
  process.exit(status.overlap.length ? 3 : 0);
}
console.error('usage: devkit base-status [--json]');
process.exit(2);
