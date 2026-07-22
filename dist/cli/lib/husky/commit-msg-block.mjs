/**
 * Assemble the devkit-managed `.husky/commit-msg` hook — the commit-MESSAGE judges. They live at
 * commit-msg, not pre-commit, because the message only exists once git has it (passed as the
 * message-file path in $1); pre-commit can't see it on interactive commits.
 *
 * Same architecture as the pre-commit block (husky-block.mts): per-guard `# devkit:<id>` sentinel
 * fragments joined inside the SAME `# >>> devkit-guards >>>` marker pair, spliced/removed with the
 * shared replace/remove helpers, so re-runs are idempotent and consumer lines outside the markers
 * are never touched. Emitted only when a commit-msg guard is selected (`review` → the completeness
 * judge, `sentry` → the Sentry-capture judge); deselecting them removes the block, mirroring the
 * pre-commit deselection path. Consumers previously HAND-WIRED these exact lines (the frink hook
 * this generator absorbs) — devkit now owns them so upgrade keeps every repo's plumbing current.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectGitRoot } from "../detect-git-root.mjs";
import { markEnd, markStart } from "./husky.mjs";
import { extractGuardBlock, PATH_SETUP, removeGuardBlock, replaceGuardBlock, } from "./husky-block.mjs";
/** The guard ids whose gates run at commit-msg (not pre-commit), in emit order. */
export const COMMIT_MSG_GUARD_IDS = ['review', 'sentry'];
// Per-guard fragment sentinel ids — `review` contributes the COMPLETENESS judge here (its reviewer
// fleet fragment stays in pre-commit), so its commit-msg sentinel carries its own name.
const FRAGMENT_ID = {
    review: 'guard-completeness',
    sentry: 'guard-sentry',
};
// The `|| var=$?` tested-status plumbing note — the whole reason the fragments have their shape.
// Emitted once at the top of the block (it governs every fragment below).
const TESTED_STATUS_COMMENT = `# \`|| var=$?\` makes each judge's exit a TESTED status — without it, husky's \`sh -e\` would
# abort the hook the instant a bin exits non-zero (before the code is read), so an exit-2
# fail-open would BLOCK the commit (inverting the fail-open invariant) and the exit-1 guidance
# would never print. (Same guard the pre-commit AI fragments use: \`rc=0; … || rc=$?\`.)`;
// One judge invocation line. Package mode runs the bundled bin via bunx; standalone runs the
// GLOBAL bin, command -v-guarded so a machine without devkit is never blocked (the standalone
// pre-commit precedent). Both capture the exit into `rcVar` (see TESTED_STATUS_COMMENT).
function invoke(standalone, cmd, rcVar) {
    if (!standalone)
        return `bunx ${cmd} --gate "$1" || ${rcVar}=$?`;
    const bin = cmd.split(' ')[0];
    return `if command -v ${bin} >/dev/null 2>&1; then ${cmd} --gate "$1" || ${rcVar}=$?; fi`;
}
// The feature-completeness judge (guard-review completeness) — hard-by-default upstream
// (gate-engine/review/completeness.mts): a confident FAIL exits 1, warn/skip 0, fail-open 2,
// and 3 = judge outage under GUARD_AI_STRICT (ship) — fail CLOSED, mirroring the pre-commit
// AI fragments (a strict-ship outage must never silently pass the gate).
const completenessFragment = (standalone) => `# devkit:guard-completeness
echo "🧩 Completeness gate (commit-msg judge)..."
crc=0
${invoke(standalone, 'guard-review completeness', 'crc')}
if [ "$crc" -eq 1 ]; then
    echo "   Confirmed completeness gap (hard-by-default; findings above)."
    echo "   Fix the gap, or — with the user's explicit OK — GUARD_NO_COMPLETENESS=1 git commit ..."
    exit 1
elif [ "$crc" -eq 3 ]; then
    echo "   guard-review completeness: judge unavailable — strict ship mode failed closed."
    echo "   Check \\\`claude\\\` CLI auth/quota, then re-run devkit ship (cleared judgements are cached)."
    exit 1
fi
# crc 0 = pass / warn-only / skipped, crc 2 = fail-open → continue.
# /devkit:guard-completeness`;
// The Sentry-capture judge (guard-sentry, gate-engine/sentry/check-sentry.mts) — hard-by-default:
// a confident MONITOR on a silent runtime error-class with no capture in the diff exits 1.
const sentryFragment = (standalone) => `# devkit:guard-sentry
echo "🛰️ Sentry gate (commit-msg judge)..."
src=0
${invoke(standalone, 'guard-sentry', 'src')}
if [ "$src" -eq 1 ]; then
    echo "   Commit describes an un-monitored runtime error-class (sentry gate, hard mode)."
    echo "   Add a Sentry capture on the named surface (backlog: docs/sentry-watchlist.md)."
    echo "   Verdict wrong? Do not bypass on your own judgement — surface it to the user; with"
    echo "   their approval:  GUARD_NO_SENTRY_JUDGE=1 git commit ..."
    exit 1
fi
# src 0 = pass / warn-only / skipped, src 2 = fail-open → continue.
# /devkit:guard-sentry`;
// The shebang + header + PATH preamble for a FRESH devkit-owned commit-msg hook (the PATH setup is
// shared with pre-commit; replaceGuardBlock injects it itself when splicing into a consumer hook
// that has none).
const COMMIT_MSG_PREAMBLE = `#!/bin/sh
# devkit generic commit-msg hook (POSIX sh). The commit-MESSAGE judges live here, not in
# pre-commit: the message only exists once git has it (passed as the message-file path in $1).
# The block between the two \`# devkit-guards\` markers is devkit-owned and is the only region
# init / removal touches — everything outside it is the consumer's own hook.

${PATH_SETUP}
`;
/** The selected commit-msg guard ids, in emit order. */
export function commitMsgGuards(guards = []) {
    return COMMIT_MSG_GUARD_IDS.filter((id) => guards.includes(id));
}
/**
 * Build the commit-msg `# devkit-guards` marker block (inclusive) from a selection, or null when
 * no commit-msg guard is selected (callers then remove any existing block instead).
 *
 * `pkgRel` (monorepo): package-scoped markers, and the judges run from the package dir (its staged
 * diff + guard.config.json). `standalone` swaps bunx for command -v-guarded global bins.
 */
export function buildCommitMsgBlock(selection, pkgRel = '', { standalone = false } = {}) {
    const selected = commitMsgGuards(selection.guards);
    if (!selected.length)
        return null;
    const pieces = [TESTED_STATUS_COMMENT];
    if (selected.includes('review'))
        pieces.push(completenessFragment(standalone));
    if (selected.includes('sentry'))
        pieces.push(sentryFragment(standalone));
    const body = pieces.join('\n\n');
    const start = markStart(pkgRel);
    const end = markEnd(pkgRel);
    if (!pkgRel)
        return `${start}\n${body}\n${end}`;
    // Absolutize the message path BEFORE cd'ing into the package (git hands it repo-root-relative on
    // a normal commit; a linked worktree already passes it absolute), then judge from the package
    // dir. `set --` rewrites $1 in place — the subshell inherits it — and `) || exit 1` propagates
    // an inner block, exactly like the pre-commit package block.
    return `${start}\ncase "$1" in /*) ;; *) set -- "$PWD/$1" ;; esac\n( cd "${pkgRel}" || exit 1\n\n${body}\n) || exit 1\n${end}`;
}
/**
 * A full fresh commit-msg hook: preamble + block + explicit trailing `exit 0`, so a judge's
 * fail-open exit 2 (captured into its rc var, never re-raised) can never propagate as a hook
 * failure. Callers guarantee a commit-msg guard is selected (block non-null).
 */
export function buildCommitMsgHook(selection, pkgRel = '', opts = {}) {
    return `${COMMIT_MSG_PREAMBLE}\n${buildCommitMsgBlock(selection, pkgRel, opts)}\n\nexit 0\n`;
}
/**
 * Write/refresh/remove the managed `.husky/commit-msg` from a selection — the commit-msg half of
 * init/upgrade's step-3 hook install (installHusky's sibling):
 *   - a commit-msg guard selected + no hook → write a fresh full hook;
 *   - selected + hook exists → splice/refresh the marker block (idempotent, consumer lines kept);
 *   - none selected → remove our block if present (the file itself is never deleted — mirroring
 *     how pre-commit deselection strips the block and leaves the consumer's hook).
 */
export function installCommitMsgHook(hookRoot, pkgRel, selection, { dryRun = false, standalone = false } = {}) {
    const block = buildCommitMsgBlock(selection, pkgRel, { standalone });
    if (block === null) {
        removeCommitMsgBlock(hookRoot, pkgRel, dryRun);
        return;
    }
    const hookPath = join(hookRoot, '.husky', 'commit-msg');
    if (!existsSync(hookPath)) {
        if (dryRun) {
            console.log('  [dry-run] write .husky/commit-msg (commit-msg judges from selection)');
            return;
        }
        mkdirSync(join(hookRoot, '.husky'), { recursive: true });
        writeFileSync(hookPath, buildCommitMsgHook(selection, pkgRel, { standalone }));
        chmodSync(hookPath, 0o755);
        console.log('  ✓ created .husky/commit-msg (commit-msg judges)');
        return;
    }
    const current = readFileSync(hookPath, 'utf8');
    const merged = replaceGuardBlock(current, block, pkgRel);
    if (merged === current) {
        console.log('  • .husky/commit-msg already wired (devkit-guards block current)');
        return;
    }
    if (dryRun) {
        console.log('  [dry-run] refresh devkit-guards block in existing .husky/commit-msg');
        return;
    }
    writeFileSync(hookPath, merged);
    console.log('  ✓ refreshed devkit-guards block in .husky/commit-msg');
}
/**
 * Remove this package's devkit-guards block from `.husky/commit-msg`, consumer lines kept.
 * SILENT no-op when the file or block is absent (called on every non-commit-msg init), loud when
 * it actually removes. Returns whether a block was removed.
 */
export function removeCommitMsgBlock(hookRoot, pkgRel, dryRun = false) {
    const hookPath = join(hookRoot, '.husky', 'commit-msg');
    if (!existsSync(hookPath))
        return false;
    const { content, removed } = removeGuardBlock(readFileSync(hookPath, 'utf8'), pkgRel);
    if (!removed)
        return false;
    if (dryRun) {
        console.log('  [dry-run] remove devkit-guards block from .husky/commit-msg');
        return true;
    }
    writeFileSync(hookPath, content);
    console.log('  ✓ removed devkit-guards block from .husky/commit-msg');
    return true;
}
/**
 * Doctor check for the managed commit-msg hook — only meaningful when a commit-msg guard is
 * selected (the caller gates on `commitMsgGuards(...).length`). MISSING/DRIFT heal via
 * `devkit init`/`upgrade` (fixable).
 */
export function checkCommitMsgHook(cwd, selectedGuards) {
    const name = '.husky/commit-msg';
    const { gitRoot, pkgRel } = detectGitRoot(cwd);
    const wanted = commitMsgGuards(selectedGuards).map((id) => FRAGMENT_ID[id]);
    const hookPath = join(gitRoot, '.husky', 'commit-msg');
    if (!existsSync(hookPath)) {
        return {
            name,
            status: 'MISSING',
            detail: `no hook (commit-msg judges selected: ${wanted.join(', ')})`,
            remediation: 'run `devkit init` (or `devkit upgrade`)',
            fixable: true,
        };
    }
    const block = extractGuardBlock(readFileSync(hookPath, 'utf8'), pkgRel) ?? '';
    // Symmetric sentinel check (same depth as pre-commit's checkHusky): a fragment for a DESELECTED
    // guard lingering in the block is drift too — a stale hard gate would keep blocking commits.
    const present = [...block.matchAll(/^# devkit:([a-z-]+)$/gm)].map((m) => m[1]);
    const extra = present.filter((id) => !wanted.includes(id));
    if (extra.length) {
        return {
            name,
            status: 'DRIFT',
            detail: `block contains deselected gate(s): ${extra.join(', ')}`,
            remediation: 'run `devkit init --force` (or `devkit upgrade`) to regenerate the block',
            fixable: true,
        };
    }
    const missing = wanted.filter((id) => !block.includes(`# devkit:${id}`));
    if (missing.length) {
        return {
            name,
            status: 'DRIFT',
            detail: `block missing gate(s): ${missing.join(', ')}`,
            remediation: 'run `devkit init --force` (or `devkit upgrade`) to regenerate the block',
            fixable: true,
        };
    }
    return {
        name,
        status: 'OK',
        detail: `block calls: ${wanted.join(', ')}`,
        remediation: '',
        fixable: false,
    };
}
