/** Message-judge invocation + Sentry judge fragments, shared by the commit-msg and pre-commit
 *  builders as a leaf module so neither builder imports the other. */

import { BIN_DIRS, type BinDir } from './gate-policy/block-helpers.mts';
import { DK_NO_GIT_ENV_INLINE } from './review-fragments.mts';

// `msg` is git's "$1" at commit-msg or ship's temp file at pre-commit. Git env is always scrubbed:
// both runs read the index via DEVKIT_COMMIT_INDEX_FILE (gates-judge-commit-index).
export function invokeJudge(binDir: BinDir, cmd: string, rcVar: string, msg = '"$1"'): string {
  const [bin, ...args] = cmd.split(' ');
  const path = `"$__dk_package_bin_dir/${bin}"`;
  return `[ -x ${path} ] || { echo "devkit: ${BIN_DIRS[binDir].missing(bin)}." >&2; exit 1; }
${DK_NO_GIT_ENV_INLINE} ${path}${args.length ? ` ${args.join(' ')}` : ''} --gate ${msg} || ${rcVar}=$?`;
}

const SENTRY_ARMS = `if [ "$src" -eq 1 ]; then
    echo "   Commit describes an un-monitored runtime error-class (sentry gate, hard mode)."
    echo "   Add a Sentry capture on the named surface (backlog: docs/sentry-watchlist.md)."
    echo "   Verdict wrong? Do not bypass on your own judgement — surface it to the user; with"
    echo "   their approval:  GUARD_NO_SENTRY_JUDGE=1 git commit ..."
    exit 1
elif [ "$src" -eq 4 ]; then
    echo "   NOT a gate rejection — no defect was named; the staged content itself is unreadable."
    exit 1
fi
# src 0 = pass / warn-only / skipped, src 2 = fail-open → continue; 4 = object-database fault.`;

// guard-sentry (gate-engine/sentry/check-sentry.mts), hard-by-default: a confident MONITOR on a
// silent runtime error-class with no capture in the diff exits 1.
export const sentryFragment = (binDir: BinDir) => `# devkit:guard-sentry
echo "🛰️ Sentry gate (commit-msg judge)..."
src=0
${invokeJudge(binDir, 'guard-sentry', 'src')}
${SENTRY_ARMS}
# /devkit:guard-sentry`;

// sc-3012: on a ship, judge sentry BEFORE the qavis advisory (a later fix voids a QA receipt);
// commit-msg replays the verdict from the diff-tier cache.
export const sentryShipPrewarmFragment = (binDir: BinDir) => `# devkit:guard-sentry-prewarm
if [ "\${DEVKIT_RUN_MODE:-}" != "review" ] && [ -n "\${DEVKIT_COMMIT_MSG_FILE:-}" ] && [ -f "\${DEVKIT_COMMIT_MSG_FILE:-}" ]; then
echo "🛰️ Sentry gate (ship: judged before the qavis advisory; commit-msg replays the verdict)..."
src=0
${invokeJudge(binDir, 'guard-sentry', 'src', '"$DEVKIT_COMMIT_MSG_FILE"')}
${SENTRY_ARMS}
# Pre-commit policy, prewarm only: a code this contract does not define means no verdict was
# reached, so block rather than fall through to the advisory. commit-msg keeps its continue default.
if [ "$src" -ne 0 ] && [ "$src" -ne 2 ]; then
    echo "   guard-sentry: unexpected exit $src — blocking (this step reached no verdict)."
    exit 1
fi
fi
# /devkit:guard-sentry-prewarm`;
