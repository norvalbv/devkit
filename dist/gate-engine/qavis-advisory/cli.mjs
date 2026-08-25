#!/usr/bin/env node
/**
 * guard-qavis-advisory — the qavis-advisory gate CLI.
 *
 *   guard-qavis-advisory --gate    nudge to run qavis QA when a staged UI change isn't QA'd (pre-commit/ship)
 *
 * Resolves against the CONSUMER repo (process.cwd()). Exit contract: see check.mts — 0 = continue,
 * 3 = ADVISE under a strict ship. Advisory by design: it never hard-fails a normal commit.
 */
import { runQavisAdvisory } from './check.mjs';
function run(argv) {
    if (argv[0] === '--gate')
        return runQavisAdvisory();
    console.error('Usage: guard-qavis-advisory --gate');
    return 2;
}
try {
    process.exit(run(process.argv.slice(2)));
}
catch (e) {
    // Fail-OPEN even under strict ship: an advisor's own crash must never block a commit/ship.
    console.error(`guard-qavis-advisory: ${e?.message ?? e}`);
    process.exit(0);
}
