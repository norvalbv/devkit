#!/usr/bin/env node

/**
 * guard-prefix — deterministic-prefix pass cache CLI (see prefix-cache.mjs for semantics).
 *
 *   guard-prefix check  [--hook <path>] [--scope <name>]   exit 0 = cached all-green (skip
 *                                                          the deterministic gates), exit 1 =
 *                                                          miss or ANY error (run the gates)
 *   guard-prefix record [--hook <path>] [--scope <name>]   remember the current staged tree
 *                                                          as all-green (best-effort, exit 0)
 *   guard-prefix clear                                     drop cached keys
 *
 * Both check and record are no-ops outside a ship run (DEVKIT_SHIP=1) — check misses,
 * record writes nothing. Resolves from process.cwd() — the consumer repo (W-3).
 */

import { checkPrefix, clearPrefix, recordPrefix } from './prefix-cache.mts';

interface PrefixCliOpts {
  hookPath?: string;
  scope?: string;
}

function parseOpts(rest: string[]): PrefixCliOpts {
  const opts: PrefixCliOpts = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--hook' && rest[i + 1]) opts.hookPath = rest[++i];
    else if (rest[i] === '--scope' && rest[i + 1]) opts.scope = rest[++i];
  }
  return opts;
}

function run(argv: string[]) {
  const [cmd, ...rest] = argv;
  const cwd = process.cwd();
  if (cmd === 'check') {
    if (!checkPrefix(cwd, parseOpts(rest))) return 1;
    console.error(
      'guard-prefix: staged tree identical to a previous all-green run — skipping deterministic gates',
    );
    return 0;
  }
  if (cmd === 'record') {
    recordPrefix(cwd, parseOpts(rest));
    return 0;
  }
  if (cmd === 'clear') {
    clearPrefix(cwd);
    return 0;
  }
  console.error('Usage: guard-prefix check|record [--hook <path>] [--scope <name>] | clear');
  return 1;
}

try {
  process.exit(run(process.argv.slice(2)));
} catch (e) {
  console.error(`guard-prefix: ${e?.message ?? e}`);
  process.exit(1); // any failure means "run the gates", never "skip"
}
