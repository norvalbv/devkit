/** Message-judge invocation + Sentry judge fragments, shared by the commit-msg and pre-commit
 *  builders as a leaf module so neither builder imports the other. */

// Package mode runs the pinned local bin; standalone a command -v-guarded global. `msg` names the
// message file: git's "$1" at commit-msg, ship's temp file at pre-commit.
export function invokeJudge(standalone: boolean, cmd: string, rcVar: string, msg = '"$1"'): string {
  if (!standalone) {
    const [bin, ...args] = cmd.split(' ');
    const localBin = `"$__dk_package_bin_dir/${bin}"`;
    return `[ -x ${localBin} ] || { echo "devkit: pinned ${bin} is missing — run bun install." >&2; exit 1; }
${localBin}${args.length ? ` ${args.join(' ')}` : ''} --gate ${msg} || ${rcVar}=$?`;
  }
  const bin = cmd.split(' ')[0];
  return `if command -v ${bin} >/dev/null 2>&1; then ${cmd} --gate ${msg} || ${rcVar}=$?; fi`;
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
export const sentryFragment = (standalone: boolean) => `# devkit:guard-sentry
echo "🛰️ Sentry gate (commit-msg judge)..."
src=0
${invokeJudge(standalone, 'guard-sentry', 'src')}
${SENTRY_ARMS}
# /devkit:guard-sentry`;

// sc-3012: on a ship, judge sentry BEFORE the qavis advisory (a later fix voids a QA receipt);
// commit-msg replays the verdict from the diff-tier cache. Git env kept so both runs key the same index.
export const sentryShipPrewarmFragment = (standalone: boolean) => `# devkit:guard-sentry-prewarm
if [ "\${DEVKIT_RUN_MODE:-}" != "review" ] && [ -n "\${DEVKIT_COMMIT_MSG_FILE:-}" ] && [ -f "\${DEVKIT_COMMIT_MSG_FILE:-}" ]; then
echo "🛰️ Sentry gate (ship: judged before the qavis advisory; commit-msg replays the verdict)..."
src=0
${invokeJudge(standalone, 'guard-sentry', 'src', '"$DEVKIT_COMMIT_MSG_FILE"')}
${SENTRY_ARMS}
fi
# /devkit:guard-sentry-prewarm`;
