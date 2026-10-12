#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { loadExtraGates } from './command-gates.mjs';

/** Runs each gate without a shell; any non-zero exit blocks the commit. */
let blocked = false;
for (const gate of loadExtraGates(process.argv[2])) {
  if (gate.unrunnable) {
    console.error(`BLOCK ${gate.label}: unrunnable — ${gate.unrunnable}`);
    blocked = true;
    continue;
  }
  const run = spawnSync(gate.argv[0], gate.argv.slice(1), { stdio: 'ignore' });
  if (run.status !== 0) {
    console.error(`BLOCK ${gate.label}: exit ${run.status}`);
    blocked = true;
  } else console.log(`ok ${gate.label}`);
}
process.exit(blocked ? 1 : 0);
