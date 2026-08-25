/**
 * The three pre-commit hook health checks, kept together because they answer complementary parts of
 * one question: `checkHusky` asks whether the hook exists and still calls the selected gates in THIS
 * checkout; `checkHookRunner` asks whether that hook survives `git worktree add` at all; and
 * `checkHooksPathOwner` asks whose hook a commit made HERE actually runs — delivery into a new
 * checkout and ownership of the current one being different failures with the same symptom.
 *
 * They live here beside the other doctor checks (see `asset-checks.mts`) rather than in
 * `doctor.mts`, which is at its line budget.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { REVIEWABLE_GUARD_IDS } from '../components.mjs';
import { detectGitRoot } from '../detect-git-root.mjs';
import { markEnd, markStart } from '../husky/husky.mjs';
import { extractGuardBlock, QAVIS_ADVISORY_ID } from '../husky/husky-block.mjs';
import { firstLine } from '../standalone.mjs';
import { check } from './check-result.mjs';
import { foreignPin, hooksDir, isInside, isInsideResolved, sharedHooksPath, worktreeHooksPathState, worktreeScopedPin, } from './hooks-path.mjs';
import { strayGateCalls } from './stray-gate-calls.mjs';
import { checkFailOpenGuards } from './unguarded-gate-calls.mjs';
/**
 * `doctor --fix`'s repair for a husky-reclaimed `core.hooksPath` in OVERLAY mode. husky's `prepare`
 * resets it to `.husky/_` on every install, and until now `--fix` only WARNED — while `devkit review`
 * told users to run exactly this command to repair it. Transient by nature (the next install
 * reclaims it again); `devkit init --overlay --global-commit-gate` is the durable fix.
 *
 * Lives here rather than in `doctor.mts` for the same reason the checks above do — that file is at
 * its recorded size budget — and beside them because this module already owns doctor's hooksPath
 * reasoning.
 *
 * Two refusals, both fail-safe:
 *   - no `.devkit/hooks/pre-commit` → re-pointing would aim core.hooksPath at a directory with no
 *     hook in it, turning a loud warning into a silent zero-gate state. Belt-and-braces in practice:
 *     the caller runs syncOverlayHook first, which regenerates a missing hook under `--fix`, so this
 *     only fires if that ever stops guaranteeing the file. The pointer must never lead the hook.
 *   - a LINKED worktree → core.hooksPath lives in the SHARED .git/config (only `--worktree` scope is
 *     per-checkout) and `.devkit/hooks` is relative, so writing it from here would re-point every
 *     sibling worktree at a path most of them do not have. Print the main-checkout command instead.
 */
export function repointHooksPath(gitRoot, hookOk) {
    if (!hookOk)
        return false;
    try {
        const git = (...args) => execFileSync('git', args, { cwd: gitRoot, encoding: 'utf8' }).trim();
        if (git('rev-parse', '--git-dir') !== git('rev-parse', '--git-common-dir')) {
            console.log('  · linked worktree — core.hooksPath is shared with every other worktree, so --fix leaves it alone; re-point from the main checkout: git config --local core.hooksPath .devkit/hooks');
            return false;
        }
        git('config', '--local', 'core.hooksPath', '.devkit/hooks');
        return true; // the caller reports the healed path on its own core.hooksPath line
    }
    catch (e) {
        console.log(`  ! could not re-point core.hooksPath: ${firstLine(e)}`);
        return false;
    }
}
// Selection-aware: only the SELECTED guards must be present in the block (a deselected
// guard being absent is correct, not drift). Monorepo: the hook lives at the git root and the
// block is package-scoped — resolve both from cwd.
export function checkHusky(cwd, selectedGuards) {
    const { gitRoot, pkgRel } = detectGitRoot(cwd);
    const hookPath = join(gitRoot, '.husky', 'pre-commit');
    if (!existsSync(hookPath)) {
        return check('.husky/pre-commit', 'MISSING', 'no hook', 'run `devkit init`', true);
    }
    const content = readFileSync(hookPath, 'utf8');
    if (!content.includes(markStart(pkgRel)) || !content.includes(markEnd(pkgRel))) {
        return check('.husky/pre-commit', 'DRIFT', pkgRel ? `no devkit-guards block for "${pkgRel}"` : 'no devkit-guards marker block', 'run `devkit init` (appends the block)', true);
    }
    const block = extractGuardBlock(content, pkgRel) ?? '';
    // Deterministic guards (size/fanout/dup/clone) run through the SINGLE `guard-deterministic`
    // orchestrator; decisions/review/qavis-advisory keep their own per-id `guard-<id>` fragment.
    // Verify one orchestrator call when any deterministic guard is selected, plus each selected
    // own-fragment sentinel. A pre-collapse block (per-guard lines) fails + is flagged for regen.
    // `sentry` runs at commit-msg (checkCommitMsgHook) — never expected in the pre-commit block.
    const OWN_FRAGMENT = new Set(['decisions', 'review', QAVIS_ADVISORY_ID]);
    const gates = selectedGuards.filter((guard) => REVIEWABLE_GUARD_IDS.includes(guard));
    const missing = [];
    if (gates.some((g) => !OWN_FRAGMENT.has(g)) && !block.includes('guard-deterministic')) {
        missing.push('deterministic gates');
    }
    for (const g of gates) {
        if (OWN_FRAGMENT.has(g) && !block.includes(`guard-${g}`))
            missing.push(g);
    }
    if (missing.length) {
        return check('.husky/pre-commit', 'DRIFT', `block missing gate(s): ${missing.join(', ')}`, 'run `devkit init --force` (or `devkit upgrade`) to regenerate the block', true);
    }
    // A gate devkit emits, ALSO invoked outside the block, runs twice per commit — and for the LLM
    // judges that is a second model bill on every single commit, while .devkit/config.json still
    // describes one run. Report it; never rewrite the consumer's own lines (see strayGateCalls).
    const stray = strayGateCalls(content, pkgRel, gitRoot);
    if (stray.length) {
        const where = stray.map((s) => `${s.bin} (line ${s.line})`).join(', ');
        return check('.husky/pre-commit', 'DRIFT', `${stray.length} devkit gate call(s) OUTSIDE the managed block — these run a second time every commit: ${where}`, 'each is a hand-written copy of a gate devkit now owns. Review, then delete the block around it so only the devkit-guards block runs it — or keep it deliberately if it differs (different flags/ordering)', 
        // NOT fixable: `--fix` re-runs `devkit init`, which regenerates the managed block and cannot
        // touch a hand-written line outside it. Claiming fixable would loop with no effect, and this
        // check is report-only by design (see strayGateCalls) — the consumer decides.
        false);
    }
    return check('.husky/pre-commit', 'OK', gates.length ? `block calls: ${gates.join(', ')}` : 'block present (no guards selected)');
}
const RUNNER = 'hook runner (worktree-safe)';
// Named apart from RUNNER on purpose: the two answer different questions and would read as
// contradictory duplicates side by side. RUNNER judges DELIVERY into a new checkout; OWNER judges
// which checkout's hooks run in THIS one.
const OWNER = 'hooksPath owner';
/** Git's hook names — the same set husky generates stubs for. Used to tell a real hook apart from
 * an unrelated file sitting in the hooks directory. */
const GIT_HOOKS = new Set([
    'applypatch-msg',
    'pre-applypatch',
    'post-applypatch',
    'pre-commit',
    'pre-merge-commit',
    'prepare-commit-msg',
    'commit-msg',
    'post-commit',
    'pre-rebase',
    'post-checkout',
    'post-merge',
    'pre-push',
    'pre-auto-gc',
    'post-rewrite',
]);
function gitSucceeds(gitRoot, args) {
    try {
        execFileSync('git', ['-C', gitRoot, ...args], { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
/** Does the hook git falls back to (when core.hooksPath is unset) actually reach `.husky/`? Merely
 * EXISTING is not enough: an unrelated pre-commit in git's own hooks dir runs instead of the devkit
 * hook, not as well as it, so treating its presence as healthy would hide the dead-gates state.
 * Resolved via `rev-parse --git-path` so a linked worktree finds the shared common dir rather than a
 * `.git/hooks` it never has (its own `.git` being a FILE). */
function defaultHookDelegatesToHusky(gitRoot) {
    try {
        const dir = execFileSync('git', ['-C', gitRoot, 'rev-parse', '--git-path', 'hooks'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (!dir)
            return false;
        const hook = join(isAbsolute(dir) ? dir : join(gitRoot, dir), 'pre-commit');
        return existsSync(hook) && readFileSync(hook, 'utf8').includes('.husky');
    }
    catch {
        return false;
    }
}
/**
 * Does this checkout gate itself — would the hooks that run once the pin is gone actually be its
 * own, and actually run?
 *
 * Reuses `checkHookRunner`'s whole verdict rather than a second existence test, because a runner
 * DIRECTORY can be there while nothing runs: an empty runner dir, or a hook declared in `.husky/`
 * whose stub was never generated, are both states it already reports and `existsSync` cannot see.
 * Clearing a pin in either state would swap the sibling checkout's working hook for nothing at all.
 * The containment test is separate and comes first: `checkHookRunner` judges the shared value's
 * health, not whether that value points at US.
 */
function selfGated(cwd, gitRoot) {
    const shared = sharedHooksPath(gitRoot);
    if (!shared || !isInside(gitRoot, hooksDir(gitRoot, shared)))
        return false;
    return checkHookRunner(cwd).status === 'OK';
}
// A file reaches a new worktree iff it is TRACKED. Merely-untracked is transient (the next commit
// carries it), but untracked AND IGNORED is permanent: no ordinary `git add` can ever pick it up.
// That pairing — load-bearing yet unreachable — is the actual defect.
function isUnreachable(gitRoot, relPath) {
    if (gitSucceeds(gitRoot, ['ls-files', '--error-unmatch', relPath]))
        return false;
    return gitSucceeds(gitRoot, ['check-ignore', '-q', relPath]);
}
/**
 * The runner files this repo needs that are untracked AND gitignored — reachable by nothing an
 * ordinary `git add` can do, so `git worktree add` will never carry them. Empty when
 * core.hooksPath is unset/absolute (no in-repo runner to stage) or nothing declared is unreachable.
 *
 * `sync-hook-runner` is the only caller that stages files (an explicit, user-invoked command, never
 * `--fix`); kept separate from `checkHookRunner` rather than sharing its internals, so an
 * already-reviewed check's shape stays untouched.
 */
export function unreachableRunnerFiles(gitRoot) {
    const shared = sharedHooksPath(gitRoot);
    if (!shared || isAbsolute(shared) || !existsSync(join(gitRoot, shared)))
        return [];
    const huskyDir = join(gitRoot, '.husky');
    const runnerDir = join(gitRoot, shared);
    const declared = readdirSync(existsSync(huskyDir) ? huskyDir : runnerDir).filter((n) => GIT_HOOKS.has(n));
    const present = [...declared, 'h']
        .map((n) => `${shared}/${n}`)
        .filter((rel) => existsSync(join(gitRoot, rel)));
    return present.filter((rel) => isUnreachable(gitRoot, rel));
}
// Gate DELIVERY into fresh worktrees. Husky pins a RELATIVE core.hooksPath (`.husky/_`) and
// gitignores the runner it points at (`.husky/_/.gitignore` = `*`). A linked worktree therefore
// checks out with hooksPath resolving to a MISSING directory, and git treats "no runner" as "no
// hooks" — every commit made there is silently ungated, with no error. Tracking the runner makes git
// check it out into every worktree, so the relative path resolves everywhere and the committed hook
// still runs under `_/h`'s `sh -e`.
//
// Scope matters: a `--worktree` value shadows the shared one, so a repo can look healthy HERE while
// every NEW worktree is ungated. `git worktree add` inherits the SHARED (--local) value, so that is
// what gets judged.
//
// Detection only (never `fixable`): the repair stages files, which `--fix` must not do unasked.
export function checkHookRunner(cwd) {
    const { gitRoot } = detectGitRoot(cwd);
    const scopedState = worktreeHooksPathState(gitRoot);
    if (scopedState.status === 'ambiguous' || scopedState.status === 'unreadable')
        return check(RUNNER, 'DRIFT', `cannot determine the effective worktree core.hooksPath: ${scopedState.detail}`, 'inspect `git config --show-origin --show-scope --get-all core.hooksPath`');
    const shared = sharedHooksPath(gitRoot);
    // Unset → git's default hooks dir, which every linked worktree shares via the common dir.
    if (!shared) {
        // ...but an INSTALLED hook that git will never reach is the same silent-no-gates failure, one
        // layer up: `.husky/pre-commit` is committed while nothing points core.hooksPath at it, because
        // husky never ran (not a dependency, or an install that skipped `prepare`). Git falls back to
        // its own hooks dir and runs nothing — in the main checkout, not just in worktrees.
        // Guarded on being in a repo at all: with no git, there is no hook wiring to be wrong about.
        if (gitSucceeds(gitRoot, ['rev-parse', '--git-dir']) &&
            existsSync(join(gitRoot, '.husky', 'pre-commit')) &&
            !defaultHookDelegatesToHusky(gitRoot)) {
            return check(RUNNER, 'DRIFT', '.husky/pre-commit is installed but core.hooksPath is unset — git runs its own hooks dir and never reaches it, so NOTHING gates', 'run `bun install` (husky sets core.hooksPath), or `devkit init` for a husky-less install');
        }
        const scoped = worktreeScopedPin(gitRoot);
        if (!scoped)
            return check(RUNNER, 'OK', 'core.hooksPath unset (git default, shared with worktrees)');
        // A per-checkout override is healthy only while it points at something this checkout owns. With
        // no shared value behind it, an override at a SIBLING checkout means the only hooks that run
        // here are someone else's — reporting that as OK would state the defect as health, and would
        // also hand `sync-hook-runner` a false licence to clear the one thing still gating.
        return foreignPin(gitRoot)
            ? check(RUNNER, 'DRIFT', `shared core.hooksPath unset; this checkout overrides to ${scoped}, which is not its own`, `see the "${OWNER}" check`)
            : check(RUNNER, 'OK', `shared core.hooksPath unset (git default); this checkout overrides to ${scoped}`);
    }
    // Absolute → inherited verbatim by every worktree; it only has to exist.
    if (isAbsolute(shared)) {
        return existsSync(shared)
            ? check(RUNNER, 'OK', `absolute core.hooksPath (${shared}) — inherited by every worktree`)
            : check(RUNNER, 'MISSING', `core.hooksPath ${shared} resolves to nothing — every commit is silently ungated`, 'repoint core.hooksPath at an existing runner directory');
    }
    const runnerDir = join(gitRoot, shared);
    if (!existsSync(runnerDir)) {
        return check(RUNNER, 'MISSING', `core.hooksPath ${shared} resolves to nothing — every commit is silently ungated`, 'run dependency setup (e.g. `bun install`) to generate the runner');
    }
    // Which hooks does this repo actually define? Husky keeps them in `.husky/`, beside the `_` runner
    // it dispatches through. A custom hooksPath (`.githooks/…`, which a standalone install deliberately
    // leaves alone) has no `.husky` dir at all — there the runner dir holds the hooks directly, so read
    // it instead. Reading `.husky` unconditionally would crash doctor on exactly that layout.
    const huskyDir = join(gitRoot, '.husky');
    // Matched against real git hook NAMES, so a stray README in `.husky/` is never mistaken for a hook
    // whose stub is owed. Filtering by existence instead would be unsafe: it cannot tell "this hook
    // doesn't apply to this layout" from "this hook's stub is missing", and would silently pass the
    // second — the very silent-ungating this check exists to catch.
    const declared = readdirSync(existsSync(huskyDir) ? huskyDir : runnerDir).filter((n) => GIT_HOOKS.has(n));
    // A runner directory with no hooks in it runs nothing — never fall through to a vacuous OK.
    if (!declared.length) {
        return check(RUNNER, 'MISSING', `core.hooksPath ${shared} holds no hook files — nothing runs on commit`, 'run dependency setup (e.g. `bun install`) to regenerate the runner');
    }
    // Every declared hook needs its stub in the runner dir. One missing stub means THAT hook silently
    // runs nothing, even while its siblings are perfectly wired.
    const unwired = declared.filter((n) => !existsSync(join(gitRoot, shared, n)));
    if (unwired.length) {
        return check(RUNNER, 'MISSING', `${unwired.join(', ')} declared in .husky/ but absent from ${shared} — ${unwired.length === 1 ? 'that hook runs' : 'those hooks run'} nothing`, 'run dependency setup (e.g. `bun install`) to regenerate the runner');
    }
    // Husky's shared `h` dispatcher joins the per-hook stubs; absent in layouts that don't use one.
    const required = declared.map((n) => `${shared}/${n}`);
    if (existsSync(join(gitRoot, shared, 'h')))
        required.push(`${shared}/h`);
    const unreachable = required.filter((rel) => isUnreachable(gitRoot, rel));
    if (unreachable.length) {
        return check(RUNNER, 'DRIFT', `runner is gitignored (${unreachable.join(', ')}) — it can never reach a new checkout, so a fresh \`git worktree add\` runs ZERO gates, silently`, `devkit sync-hook-runner (or: git add -f ${unreachable.join(' ')})`);
    }
    return check(RUNNER, 'OK', `runner reachable (${required.length} files) — survives \`git worktree add\``);
}
/**
 * Whose hooks a commit made HERE actually runs.
 *
 * Returns a LIST so the call site is one line: `doctor.mts` is at its recorded line ceiling, and the
 * `CheckResult | null` shape used elsewhere costs two. Empty for every healthy repo, so ordinary
 * `devkit doctor` output does not grow a row.
 *
 * Inspects the repo-wide (`--local`) and per-checkout (`config.worktree`) scopes only — the two
 * devkit and husky write. A `core.hooksPath` arriving via `GIT_CONFIG_*`, `--global` or `--system`
 * is invisible here, while `devkit review` reads the fully merged value and does see it; that split
 * is documented in `docs/troubleshooting.md` rather than guessed at from this check's silence.
 */
export function checkHooksPathOwner(cwd) {
    const { gitRoot } = detectGitRoot(cwd);
    const state = worktreeHooksPathState(gitRoot);
    if (state.status === 'ambiguous' || state.status === 'unreadable')
        return [
            check(OWNER, 'DRIFT', `cannot establish this checkout's core.hooksPath ownership: ${state.detail}`, 'inspect `git config --show-origin --show-scope --get-all core.hooksPath`; devkit will not repair an ambiguous value', false),
        ];
    const pin = foreignPin(gitRoot);
    if (!pin) {
        // A benign per-checkout pin still shadows every repo-wide write — `devkit init`, `devkit clean`,
        // and husky's own `prepare` all write at `--local` and would silently fail to take effect here.
        // It is invisible to `git config --get`, so surface it even though nothing is wrong.
        if (state.status !== 'single')
            return [];
        const dir = hooksDir(gitRoot, state.value);
        if (!isInsideResolved(gitRoot, dir))
            return existsSync(dir)
                ? [
                    check(OWNER, 'OK', `this checkout pins an external core.hooksPath (${state.value}); it is not attributable to another checkout and is left unchanged`),
                ]
                : [
                    check(OWNER, 'MISSING', `this checkout pins core.hooksPath at ${state.value}, which is external to every registered checkout and resolves to nothing`, 'restore that external hooks directory or explicitly repoint this checkout; devkit cannot prove ownership and will not replace it', false),
                ];
        return [check(OWNER, 'OK', `this checkout pins its own core.hooksPath (${state.value})`)];
    }
    const scopeLabel = pin.scope === '--worktree' ? 'this checkout pins' : 'this repo pins';
    const shared = sharedHooksPath(gitRoot);
    const manual = pin.scope === '--worktree'
        ? `git config --worktree core.hooksPath ${shared || '.husky/_'}`
        : 'git config --unset core.hooksPath';
    // `--fix` is deliberately not offered: it regenerates FILE content from the recorded selection and
    // never mutates git state. `sync-hook-runner` is devkit's one sanctioned mutator, and it refuses
    // to clear anything until this checkout provably gates itself — so when it does not, the remedy
    // has to be the ordered sequence that gets it there. Pointing straight at sync-hook-runner would
    // send the user to a guaranteed no-op: it stages nothing while the shared value is unset.
    const remedy = pin.scope === '--local'
        ? // Repo-wide: the pin IS the shared value, so there is no local fallback to be gated by and
            // no per-checkout override to drop. Repointing it is a decision for the repo, not for us.
            `${manual} — repo-wide, so devkit will not replace it for you; repoint it at a runner each checkout carries (e.g. .husky/_)`
        : // Not self-gated YET is still sync-hook-runner's job whenever the reason is a runner it can
            // stage: it stages first and re-reads, so one run tracks the runner and then drops the pin.
            // Only when there is nothing to stage does the user have to go and produce a runner first.
            selfGated(cwd, gitRoot) || unreachableRunnerFiles(gitRoot).length
                ? `devkit sync-hook-runner (stages this checkout's own runner if needed, then replaces the sibling pin with ${shared}), or: ${manual}`
                : 'this checkout has no runner of its own to fall back on — run `bun install` here (husky generates it and sets core.hooksPath), then `devkit sync-hook-runner`, then `devkit doctor`';
    return [
        check(OWNER, pin.exists ? 'DRIFT' : 'MISSING', `${scopeLabel} core.hooksPath at ${pin.dir} — owned by sibling checkout ${pin.siblingRoot}${pin.exists ? '' : ' (now missing)'}, so commits made here ${pin.exists ? 'run ITS hooks' : 'run no hooks'}, not this checkout's own ${shared || '(none)'}`, remedy, false),
    ];
}
export function replaceableHooksPathPin(cwd) {
    const { gitRoot } = detectGitRoot(cwd);
    const pin = foreignPin(gitRoot);
    if (pin?.scope !== '--worktree')
        return null;
    const shared = sharedHooksPath(gitRoot);
    if (!shared || isAbsolute(shared))
        return null;
    const fallback = hooksDir(gitRoot, shared);
    if (!isInside(gitRoot, fallback))
        return null;
    return selfGated(cwd, gitRoot) ? { from: pin.value, to: shared } : null;
}
/**
 * Every hook-shaped check, as one list. Exists so `devkit doctor` can gain a hook check without
 * growing its own call site — cli/commands/doctor.mts sits on its recorded size budget and the
 * ratchet is shrink-only.
 */
export function hookChecks(cwd, guards) {
    return [
        checkHusky(cwd, guards),
        checkHookRunner(cwd),
        ...checkHooksPathOwner(cwd),
        checkFailOpenGuards(cwd),
    ];
}
