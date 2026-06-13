#!/usr/bin/env node

/**
 * guard-decisions — unified CLI for the decision-log engine.
 *
 * Dispatches to the three sub-engines, all of which resolve their paths/knobs from
 * resolveGuardConfig(process.cwd()) — i.e. against the CONSUMER repo, never the package dir (W-3):
 *
 *   guard-decisions add <slug> --target …| --note …   record a Target / append a note
 *   guard-decisions query "<text>" [--top K]          rank axes (semantic → lexical floor)
 *   guard-decisions reindex | list | show <slug> | check <slug>
 *   guard-decisions detect --gate | scan [--working]  architectural-smell gate (capture B)
 *   guard-decisions check-alignment --gate | scan     scope-matched alignment + depth gate (capture C)
 *
 * `detect` and `check-alignment` are thin re-dispatches into detect.mjs / check-alignment.mjs by
 * re-importing them with a synthesised argv (so their own run-as-main dispatch fires); everything
 * else routes to decisions.mjs `main`.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { main as decisionsMain } from './decisions.mjs';

const SUB_ENGINES = {
  detect: new URL('./detect.mjs', import.meta.url),
  'check-alignment': new URL('./check-alignment.mjs', import.meta.url),
};

async function run(argv) {
  const [cmd, ...rest] = argv;
  const sub = SUB_ENGINES[cmd];
  if (sub) {
    // Re-enter the sub-engine as if invoked directly: it inspects process.argv and self-dispatches
    // (--gate / scan). process.argv[1] must equal the sub-engine path so its run-as-main guard fires.
    process.argv = [process.argv[0], realpathSync(sub), ...rest];
    await import(sub.href);
    return;
  }
  await decisionsMain(argv);
}

run(process.argv.slice(2)).catch((e) => {
  console.error(`guard-decisions: ${e?.message ?? e}`);
  process.exit(1);
});
