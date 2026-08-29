import { DK_NO_GIT_ENV_INLINE } from './review-fragments.mts';

export const GUARD_FRAGMENTS = {
  comments: `# devkit:guard-comments
echo "🧯 Changed-comment firewall..."
ccrc=0
__dk_no_git_env "$__dk_package_bin_dir/guard-comments" gate || ccrc=$?
if [ "$ccrc" -eq 1 ]; then
    exit 1
elif [ "$ccrc" -eq 4 ]; then
    echo "   guard-comments: NOT a rejection — staged comment evidence is unreadable or unsupported."
    exit 1
elif [ "$ccrc" -eq 3 ]; then
    echo "   guard-comments: reviewer produced no verdict — strict ship mode failed closed."
    echo "   Follow the remedy printed above, then re-run devkit ship (approved comments are cached)."
    exit 1
elif [ "$ccrc" -ne 0 ] && [ "$ccrc" -ne 2 ]; then
    echo "   guard-comments: unexpected exit $ccrc — blocking the commit."
    exit 1
fi
# ccrc 0 = clean/approved/cached, 1 = unresolved/rejected, 2 = ordinary fail-open outage.
# /devkit:guard-comments`,
  decisions: `# devkit:guard-decisions
echo "🧭 Decision-log gate..."
ddrc=0
__dk_no_git_env "$__dk_package_bin_dir/guard-decisions" detect --gate || ddrc=$?
if [ "$ddrc" -eq 1 ]; then
    echo "   Record the decision target, or bypass a non-decision: GUARD_NO_LOG=1 git commit ..."
    exit 1
elif [ "$ddrc" -eq 3 ]; then
    echo "   guard-decisions: judge unavailable — strict ship mode failed closed."
    echo "   Check \\\`claude\\\` CLI auth/quota, then re-run devkit ship (cleared judgements are cached)."
    exit 1
elif [ "$ddrc" -ne 0 ] && [ "$ddrc" -ne 2 ]; then
    echo "   guard-decisions: unexpected exit $ddrc — blocking the commit."
    exit 1
fi
# ddrc 0 = clean / staged / routine / bypassed, ddrc 2 = fail-open → continue; any other code blocks.
# /devkit:guard-decisions`,
  review: `# devkit:guard-review
echo "🔍 Reviewer gate (headless domain judges)..."
# Ship path only (sc-1442 message file present): start the completeness judge NOW, in parallel
# with the reviewer fleet, instead of serially at commit-msg. Its confident PASS lands in the
# shared verdict store, so the commit-msg gate re-judges it as a cache hit — the serial ~4min of
# opus overlaps the fleet instead of following it. Interactive commits (no message yet) are
# unchanged. Lifetime is scoped to this hook: the judge is either wait'ed on or killed AND reaped
# below — nothing outlives the hook to hold git's output pipe open. Review mode is excluded — it
# exports the SAME env as its reviewer intent file (review-target.sh), but completeness is a
# commit gate, not part of a range review.
#
# DK_NO_GIT_ENV_INLINE, not the __dk_no_git_env function: backgrounding a function forks a
# subshell, which would make $! a wrapper whose death leaves the judge orphaned and running. See
# review-fragments.mts.
comp_pid=""
if [ "\${DEVKIT_RUN_MODE:-}" != "review" ] && [ -n "\${DEVKIT_COMMIT_MSG_FILE:-}" ] && [ -f "\${DEVKIT_COMMIT_MSG_FILE:-}" ]; then
    echo "🧩 Completeness judge started in parallel (ship message known)..."
    ${DK_NO_GIT_ENV_INLINE} "$__dk_package_bin_dir/guard-review" completeness --gate "$DEVKIT_COMMIT_MSG_FILE" & comp_pid=$!
fi
rrc=0
__dk_no_git_env "$__dk_package_bin_dir/guard-review" --gate || rrc=$?
crc=0
if [ -n "$comp_pid" ]; then
    if [ "$rrc" -eq 0 ] || [ "$rrc" -eq 2 ]; then
        wait "$comp_pid" || crc=$?
    else
        # The fleet already blocked this commit — stop paying for a judgement of a diff that is
        # about to change. (The verdict would be keyed to THIS diff; the fix invalidates it.)
        # SIGNAL THEN REAP, never signal alone: the judge inherited git's stdout/stderr, so the
        # ship capture pipeline only unblocks once every copy of that write-end is closed. A hook
        # that returns while a signalled child is still winding down leaves the reader waiting on
        # a pipe nobody will write to again — the exact hang commit-with-gate-capture.sh's R3
        # supervisor exists to bound. Both lines are status-tested (|| true) because a reaped
        # job's status IS the signal (143), and under sh -e an untested non-zero would abort the
        # hook here, before it reports its own verdict below.
        kill "$comp_pid" 2>/dev/null || true
        wait "$comp_pid" 2>/dev/null || true
    fi
fi
if [ "$rrc" -eq 1 ]; then
    echo "   A reviewer FAILED (escalation-confirmed). Fix the findings above, then re-run."
    exit 1
elif [ "$rrc" -eq 3 ]; then
    echo "   guard-review: judge unavailable after retry — strict ship mode failed closed."
    echo "   Check the judge CLI auth/quota named above, then re-run devkit ship (completed verdicts are cached)."
    exit 1
elif [ "$rrc" -ne 0 ] && [ "$rrc" -ne 2 ]; then
    echo "   guard-review: unexpected exit $rrc — blocking the commit."
    exit 1
fi
# Same exit contract as the commit-msg fragment (commit-msg-block.mts) — a completeness verdict
# means the same thing regardless of WHERE it was judged, just earlier here.
if [ "$crc" -eq 1 ]; then
    echo "   Confirmed completeness gap (hard-by-default; findings above)."
    echo "   Fix the gap, or — with the user's explicit OK — GUARD_NO_COMPLETENESS=1 git commit ..."
    exit 1
elif [ "$crc" -eq 4 ]; then
    echo "   NOT a gate rejection — no defect was named; the staged content itself is unreadable."
    exit 1
elif [ "$crc" -eq 3 ]; then
    echo "   guard-review completeness: judge unavailable — strict ship mode failed closed."
    echo "   Check \\\`claude\\\` CLI auth/quota, then re-run devkit ship (cleared judgements are cached)."
    exit 1
fi
# rrc 0 = pass/cached/nothing-to-do, rrc 2 = inconclusive (non-strict fail-open) → continue.
# crc 0 = pass (now cached for the commit-msg gate) / skipped, crc 2 = fail-open → continue.
# /devkit:guard-review`,
};
