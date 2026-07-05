#!/usr/bin/env node

/**
 * guard-review — the in-chain reviewer gate CLI.
 *
 *   guard-review --gate                          run the selected domain reviewers (pre-commit)
 *   guard-review completeness --gate <msg-file>  feature-completeness judge (commit-msg, warn-only)
 *   guard-review scan                            reviewer→files mapping + cache status (no judges)
 *   guard-review clear-cache                     drop cached PASS verdicts
 *
 * Everything resolves from resolveGuardConfig(process.cwd()) — the CONSUMER repo, never the
 * package dir (W-3). Exit contract per sub-engine (run-review.mjs / completeness.mjs headers).
 */

import { envFlag } from '../config.mts';
import { clearCache } from './cache.mts';
import { runCompleteness } from './completeness.mts';
import { runReviewGate, scanReview } from './run-review.mts';

async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === '--gate') return runReviewGate();
  if (cmd === 'completeness' && rest[0] === '--gate' && rest[1]) return runCompleteness(rest[1]);
  if (cmd === 'scan') return scanReview();
  if (cmd === 'clear-cache') {
    clearCache(process.cwd());
    return 0;
  }
  console.error('Usage: guard-review --gate | completeness --gate <msg-file> | scan | clear-cache');
  return 2;
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`guard-review: ${e?.message ?? e}`);
    // Fail-open — an engine crash must never hard-block a commit — EXCEPT on a strict ship
    // run (GUARD_AI_STRICT), where a dark gate must block rather than silently skip.
    process.exit(envFlag('AI_STRICT') ? 3 : 2);
  },
);
