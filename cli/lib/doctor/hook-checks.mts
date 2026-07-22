/**
 * The two pre-commit hook health checks, kept together because they answer complementary halves of
 * one question: `checkHusky` asks whether the hook exists and still calls the selected gates in THIS
 * checkout; `checkHookRunner` asks whether that hook survives `git worktree add` at all.
 *
 * They live here beside the other doctor checks (see `asset-checks.mts`) rather than in
 * `doctor.mts`, which is at its line budget.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { REVIEWABLE_GUARD_IDS } from '../components.mts';
import { detectGitRoot } from '../detect-git-root.mts';
import { markEnd, markStart } from '../husky/husky.mts';
import { extractGuardBlock, QAVIS_ADVISORY_ID } from '../husky/husky-block.mts';
import { type CheckResult, check } from './check-result.mts';

// Selection-aware: only the SELECTED guards must be present in the block (a deselected
// guard being absent is correct, not drift). Monorepo: the hook lives at the git root and the
// block is package-scoped — resolve both from cwd.
export function checkHusky(cwd: string, selectedGuards: string[]): CheckResult {
  const { gitRoot, pkgRel } = detectGitRoot(cwd);
  const hookPath = join(gitRoot, '.husky', 'pre-commit');
  if (!existsSync(hookPath)) {
    return check('.husky/pre-commit', 'MISSING', 'no hook', 'run `devkit init`', true);
  }
  const content = readFileSync(hookPath, 'utf8');
  if (!content.includes(markStart(pkgRel)) || !content.includes(markEnd(pkgRel))) {
    return check(
      '.husky/pre-commit',
      'DRIFT',
      pkgRel ? `no devkit-guards block for "${pkgRel}"` : 'no devkit-guards marker block',
      'run `devkit init` (appends the block)',
      true,
    );
  }
  const block = extractGuardBlock(content, pkgRel) ?? '';
  // Deterministic guards (size/fanout/dup/clone) run through the SINGLE `guard-deterministic`
  // orchestrator; decisions/review/qavis-advisory keep their own per-id `guard-<id>` fragment.
  // Verify one orchestrator call when any deterministic guard is selected, plus each selected
  // own-fragment sentinel. A pre-collapse block (per-guard lines) fails + is flagged for regen.
  // `sentry` runs at commit-msg (checkCommitMsgHook) — never expected in the pre-commit block.
  const OWN_FRAGMENT = new Set(['decisions', 'review', QAVIS_ADVISORY_ID]);
  const gates = selectedGuards.filter((guard) => REVIEWABLE_GUARD_IDS.includes(guard));
  const missing: string[] = [];
  if (gates.some((g) => !OWN_FRAGMENT.has(g)) && !block.includes('guard-deterministic')) {
    missing.push('deterministic gates');
  }
  for (const g of gates) {
    if (OWN_FRAGMENT.has(g) && !block.includes(`guard-${g}`)) missing.push(g);
  }
  if (missing.length) {
    return check(
      '.husky/pre-commit',
      'DRIFT',
      `block missing gate(s): ${missing.join(', ')}`,
      'run `devkit init --force` (or `devkit upgrade`) to regenerate the block',
      true,
    );
  }
  return check(
    '.husky/pre-commit',
    'OK',
    gates.length ? `block calls: ${gates.join(', ')}` : 'block present (no guards selected)',
  );
}

const RUNNER = 'hook runner (worktree-safe)';

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

/** A `core.hooksPath` at one config scope. Absent/unreadable (e.g. `--worktree` without
 * `extensions.worktreeConfig`) reads as ''. */
function hooksPathAt(gitRoot: string, scope: '--local' | '--worktree'): string {
  try {
    return execFileSync('git', ['-C', gitRoot, 'config', scope, '--get', 'core.hooksPath'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function gitSucceeds(gitRoot: string, args: string[]): boolean {
  try {
    execFileSync('git', ['-C', gitRoot, ...args], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Does the hook git falls back to (when core.hooksPath is unset) actually reach `.husky/`? Merely
 * EXISTING is not enough: an unrelated pre-commit in git's own hooks dir runs instead of the devkit
 * hook, not as well as it, so treating its presence as healthy would hide the dead-gates state.
 * Resolved via `rev-parse --git-path` so a linked worktree finds the shared common dir rather than a
 * `.git/hooks` it never has (its own `.git` being a FILE). */
function defaultHookDelegatesToHusky(gitRoot: string): boolean {
  try {
    const dir = execFileSync('git', ['-C', gitRoot, 'rev-parse', '--git-path', 'hooks'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!dir) return false;
    const hook = join(isAbsolute(dir) ? dir : join(gitRoot, dir), 'pre-commit');
    return existsSync(hook) && readFileSync(hook, 'utf8').includes('.husky');
  } catch {
    return false;
  }
}

// A file reaches a new worktree iff it is TRACKED. Merely-untracked is transient (the next commit
// carries it), but untracked AND IGNORED is permanent: no ordinary `git add` can ever pick it up.
// That pairing — load-bearing yet unreachable — is the actual defect.
function isUnreachable(gitRoot: string, relPath: string): boolean {
  if (gitSucceeds(gitRoot, ['ls-files', '--error-unmatch', relPath])) return false;
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
export function unreachableRunnerFiles(gitRoot: string): string[] {
  const shared = hooksPathAt(gitRoot, '--local');
  if (!shared || isAbsolute(shared) || !existsSync(join(gitRoot, shared))) return [];
  const huskyDir = join(gitRoot, '.husky');
  const runnerDir = join(gitRoot, shared);
  const declared = readdirSync(existsSync(huskyDir) ? huskyDir : runnerDir).filter((n) =>
    GIT_HOOKS.has(n),
  );
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
export function checkHookRunner(cwd: string): CheckResult {
  const { gitRoot } = detectGitRoot(cwd);
  const shared = hooksPathAt(gitRoot, '--local');
  // Unset → git's default hooks dir, which every linked worktree shares via the common dir.
  if (!shared) {
    // ...but an INSTALLED hook that git will never reach is the same silent-no-gates failure, one
    // layer up: `.husky/pre-commit` is committed while nothing points core.hooksPath at it, because
    // husky never ran (not a dependency, or an install that skipped `prepare`). Git falls back to
    // its own hooks dir and runs nothing — in the main checkout, not just in worktrees.
    // Guarded on being in a repo at all: with no git, there is no hook wiring to be wrong about.
    if (
      gitSucceeds(gitRoot, ['rev-parse', '--git-dir']) &&
      existsSync(join(gitRoot, '.husky', 'pre-commit')) &&
      !defaultHookDelegatesToHusky(gitRoot)
    ) {
      return check(
        RUNNER,
        'DRIFT',
        '.husky/pre-commit is installed but core.hooksPath is unset — git runs its own hooks dir and never reaches it, so NOTHING gates',
        'run `bun install` (husky sets core.hooksPath), or `devkit init` for a husky-less install',
      );
    }
    const scoped = hooksPathAt(gitRoot, '--worktree');
    return check(
      RUNNER,
      'OK',
      scoped
        ? `shared core.hooksPath unset (git default); this worktree overrides to ${scoped}`
        : 'core.hooksPath unset (git default, shared with worktrees)',
    );
  }
  // Absolute → inherited verbatim by every worktree; it only has to exist.
  if (isAbsolute(shared)) {
    return existsSync(shared)
      ? check(RUNNER, 'OK', `absolute core.hooksPath (${shared}) — inherited by every worktree`)
      : check(
          RUNNER,
          'MISSING',
          `core.hooksPath ${shared} resolves to nothing — every commit is silently ungated`,
          'repoint core.hooksPath at an existing runner directory',
        );
  }
  const runnerDir = join(gitRoot, shared);
  if (!existsSync(runnerDir)) {
    return check(
      RUNNER,
      'MISSING',
      `core.hooksPath ${shared} resolves to nothing — every commit is silently ungated`,
      'run dependency setup (e.g. `bun install`) to generate the runner',
    );
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
  const declared = readdirSync(existsSync(huskyDir) ? huskyDir : runnerDir).filter((n) =>
    GIT_HOOKS.has(n),
  );
  // A runner directory with no hooks in it runs nothing — never fall through to a vacuous OK.
  if (!declared.length) {
    return check(
      RUNNER,
      'MISSING',
      `core.hooksPath ${shared} holds no hook files — nothing runs on commit`,
      'run dependency setup (e.g. `bun install`) to regenerate the runner',
    );
  }
  // Every declared hook needs its stub in the runner dir. One missing stub means THAT hook silently
  // runs nothing, even while its siblings are perfectly wired.
  const unwired = declared.filter((n) => !existsSync(join(gitRoot, shared, n)));
  if (unwired.length) {
    return check(
      RUNNER,
      'MISSING',
      `${unwired.join(', ')} declared in .husky/ but absent from ${shared} — ${unwired.length === 1 ? 'that hook runs' : 'those hooks run'} nothing`,
      'run dependency setup (e.g. `bun install`) to regenerate the runner',
    );
  }
  // Husky's shared `h` dispatcher joins the per-hook stubs; absent in layouts that don't use one.
  const required = declared.map((n) => `${shared}/${n}`);
  if (existsSync(join(gitRoot, shared, 'h'))) required.push(`${shared}/h`);
  const unreachable = required.filter((rel) => isUnreachable(gitRoot, rel));
  if (unreachable.length) {
    return check(
      RUNNER,
      'DRIFT',
      `runner is gitignored (${unreachable.join(', ')}) — it can never reach a new checkout, so a fresh \`git worktree add\` runs ZERO gates, silently`,
      `devkit sync-hook-runner (or: git add -f ${unreachable.join(' ')})`,
    );
  }
  return check(
    RUNNER,
    'OK',
    `runner reachable (${required.length} files) — survives \`git worktree add\``,
  );
}
