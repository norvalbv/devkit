/**
 * Which live `core.hooksPath` values `devkit review` accepts in OVERLAY mode.
 *
 * Overlay points core.hooksPath at `.devkit/hooks`, but husky's committed `prepare` resets it to
 * `.husky/_` on every install (husky/index.js sets it unconditionally). Review used to treat that
 * as fatal drift, so a single `pnpm install` broke `devkit review` in a repo whose commits were
 * still fully gated — the opt-in `~/.config/husky/init.sh` shim survives the reclaim and runs the
 * overlay hook from inside husky's own chain (see overlay-global-hook.mts, docs/decisions/
 * overlay-self-heal.md).
 *
 * The literal was the wrong proxy: in overlay mode review-target.sh HARDCODES
 * `-c core.hooksPath=.devkit/hooks` for its private gate run, so the captured value steers nothing
 * there — it is purely an assertion that the target repo is gated. So widen the assertion instead
 * of dropping it: accept the reclaimed value only when every link of the surviving chain is intact,
 * and keep failing loudly otherwise. A repo whose gates are genuinely unwired must NOT pass review.
 *
 * Presence is not proof — `.husky/_/h` and `.husky/_/pre-commit` are checked by CONTENT, because a
 * hand-edited or foreign runner with the right filenames would satisfy a presence-only test while
 * never reaching the shim.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globalHookWired, globalInitPath } from '../../../overlay-global-hook.mjs';
/** The hooksPath an overlay install writes, and the one review's private gate run always uses. */
export const OVERLAY_HOOKS_PATH = '.devkit/hooks';
/** The hooksPath husky reclaims to on every `prepare`. */
const HUSKY_RUNNER_HOOKS_PATH = '.husky/_';
/** husky's committed hook scripts live here; `_/h` resolves the real script as `../<hook>`. */
const HUSKY_SCRIPT_DIR = '.husky';
/** husky 9's per-hook stub is `. "$(dirname "$0")/h"` — it must actually source the runner. */
const HUSKY_STUB_SOURCES_RUNNER = /^\s*\.\s+.*\/h"?\s*$/m;
/** The variable `_/h` assigns the XDG init.sh path to: `i="${XDG_CONFIG_HOME:-$HOME/.config}/…"`. */
const HUSKY_INIT_ASSIGNMENT = /(?:^|\s)([A-Za-z_]\w*)=\s*"?[^"\n]*husky\/init\.sh/m;
/**
 * A `.`/`source` command in command position. Three lead-ins, because all are valid shell and all
 * genuinely source: line start — INDENTED or not, since a dot-source nested in an `if` block is a
 * common shape; after a `;`/`&&`/`||`, which is husky's own `[ -f "$i" ] && . "$i"`; and after a
 * block keyword, as in `if [ -f "$i" ]; then . "$i"; fi`. Anchoring at a bare `^` (as this did)
 * rejects the indented form and hard-fails a genuinely gated repo — the very outcome this module
 * exists to prevent, and inconsistent with HUSKY_STUB_SOURCES_RUNNER's own `^\s*`.
 */
const sourceCommand = (target) => new RegExp(String.raw `(?:^[ \t]*|[;&|]\s*)(?:(?:then|do|else)\s+)?(?:\.|source)\s+["']?${target}`, 'm');
// A `#` at line start or after whitespace opens a comment. Parameter expansions like `${0##*/}`
// are untouched: their `#` follows a non-space character.
const SHELL_COMMENT = /(^|\s)#.*$/;
/**
 * The script with comments stripped, so a classifier only ever sees lines that RUN.
 *
 * Without this, `# noop; . "$i"` satisfies a source-command match: the pattern needs only a `;`
 * before the dot-source, and a commented-out line still supplies one. Deliberately approximate in
 * ONE direction — a `#` inside a quoted string truncates the line early, which can only lose a
 * match and cause a REJECTION. This classifier must fail closed: refusing a gated repo is a loud
 * error the user can fix, accepting an ungated one is the silent hole this module exists to close.
 */
function executableLines(script) {
    return script
        .split('\n')
        .map((line) => line.replace(SHELL_COMMENT, '$1'))
        .filter((line) => line.trim() !== '')
        .join('\n');
}
/**
 * Does `_/h` actually SOURCE the XDG init.sh — not merely mention it?
 *
 * A bare `includes('husky/init.sh')` is not enough, and the trap is in husky's own runner: its
 * deprecation notice for `~/.huskyrc` embeds the literal `~/.config/husky/init.sh` in an echo. A
 * runner stripped of its `[ -f "$i" ] && . "$i"` line but still carrying that warning would pass a
 * substring test while never reaching the shim — precisely the presence-not-proof hole this module
 * exists to close. So find the variable the path is ASSIGNED to, then require a source of it (or a
 * direct source of a literal init.sh path).
 */
function runnerSourcesInit(script) {
    const runner = executableLines(script);
    if (sourceCommand(String.raw `[^\n]*husky/init\.sh`).test(runner))
        return true;
    const assigned = HUSKY_INIT_ASSIGNMENT.exec(runner)?.[1];
    return assigned !== undefined && sourceCommand(String.raw `\$\{?${assigned}\}?`).test(runner);
}
// `throwIfNoEntry: false` only silences ENOENT — an unreadable parent directory still throws
// EACCES, and a symlink cycle ELOOP. Both must read as "cannot prove this link is intact" and fall
// through to the caller's rejection message, not escape as an unhandled error from a predicate whose
// whole job is to return a diagnostic.
function readIfFile(path) {
    try {
        const stat = lstatSync(path, { throwIfNoEntry: false });
        return stat?.isFile() ? readFileSync(path, 'utf8') : null;
    }
    catch {
        return null;
    }
}
function isExecutableFile(path) {
    try {
        const stat = lstatSync(path, { throwIfNoEntry: false });
        return stat?.isFile() === true && (stat.mode & 0o111) !== 0;
    }
    catch {
        return false;
    }
}
/**
 * Why a husky-reclaimed core.hooksPath is NOT provably gated, or null when it is. The order walks
 * the chain a real `git commit` takes, so the first failure names the first broken link.
 */
function huskyReclaimRejection(context) {
    const { gitRoot } = context;
    if (!existsSync(join(gitRoot, OVERLAY_HOOKS_PATH, 'pre-commit')))
        return `${OVERLAY_HOOKS_PATH}/pre-commit is missing, so nothing would run it`;
    if (!globalHookWired())
        return `no devkit block in ${globalInitPath()} — husky reclaimed core.hooksPath and nothing re-wires the overlay`;
    const runner = readIfFile(join(gitRoot, HUSKY_RUNNER_HOOKS_PATH, 'h'));
    if (runner === null)
        return `${HUSKY_RUNNER_HOOKS_PATH}/h is missing`;
    if (!runnerSourcesInit(runner))
        return `${HUSKY_RUNNER_HOOKS_PATH}/h never sources husky/init.sh`;
    const stubPath = join(gitRoot, HUSKY_RUNNER_HOOKS_PATH, 'pre-commit');
    const stub = readIfFile(stubPath);
    if (stub === null)
        return `${HUSKY_RUNNER_HOOKS_PATH}/pre-commit is missing`;
    if (!isExecutableFile(stubPath))
        return `${HUSKY_RUNNER_HOOKS_PATH}/pre-commit is not executable`;
    if (!HUSKY_STUB_SOURCES_RUNNER.test(executableLines(stub)))
        return `${HUSKY_RUNNER_HOOKS_PATH}/pre-commit never sources ${HUSKY_RUNNER_HOOKS_PATH}/h`;
    // The chain hook is load-bearing TWICE over. husky 9's `_/h` does `[ ! -f "$s" ] && exit 0`
    // BEFORE it sources init.sh, so with no committed .husky/pre-commit the shim never fires at all
    // and commits are genuinely ungated (the residual hole overlay-self-heal.md documents). And the
    // chain must resolve through .husky: an overlay installed BEFORE husky records origHooksPath ''
    // and chains to .git/hooks, which husky's runner would never execute — review would then clear a
    // commit whose real hook chain it never ran.
    if (context.chain === null || context.chain.sourcePath !== HUSKY_SCRIPT_DIR)
        return `the overlay chains to ${context.chain?.sourcePath ?? '(nothing)'}, not ${HUSKY_SCRIPT_DIR} — husky's runner would never reach it`;
    // Stricter than husky's own `[ ! -f "$s" ]` test on purpose: captureOverlayChain freezes the
    // chain hook as executable, and a mode-0644 committed hook is a setup devkit will not vouch for.
    if (!context.chainPresent)
        return `${context.chain.path} is missing or not executable, so husky's runner exits before sourcing the shim`;
    return null;
}
/**
 * Why `value` is unacceptable as an overlay repo's live core.hooksPath, or null when it is fine.
 * `.devkit/hooks` is accepted outright; `.husky/_` only on proof; anything else is drift.
 */
export function overlayHooksPathRejection(value, context) {
    if (value === OVERLAY_HOOKS_PATH)
        return null;
    if (value !== HUSKY_RUNNER_HOOKS_PATH)
        return `core.hooksPath is ${JSON.stringify(value || '(unset)')}, expected ${OVERLAY_HOOKS_PATH}`;
    const rejection = huskyReclaimRejection(context);
    return rejection === null
        ? null
        : `core.hooksPath is ${JSON.stringify(value)} (husky reclaimed it) and the overlay is not provably still gated: ${rejection}`;
}
