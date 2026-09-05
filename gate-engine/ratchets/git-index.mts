#!/usr/bin/env node
// Shared git-index helpers for the ratchet gates (folder-fanout / size-disable). Both gates
// auto-lower a baseline during a commit and need the same two primitives, so they live here as
// ONE code path rather than duplicated per ratchet.

import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';

const INDEX_LOCK_RETRY = new Int32Array(new SharedArrayBuffer(4));

function stagePathStrict(
  root: string,
  rel: string,
  { missingIsSuccess = false }: { missingIsSuccess?: boolean } = {},
): void {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = spawnSync('git', ['add', '--', rel], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.status === 0) return;
    if (missingIsSuccess && !indexTracksBaseline(root, rel)) return;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (output.includes('index.lock') && attempt < 49) {
      Atomics.wait(INDEX_LOCK_RETRY, 0, 0, 20);
      continue;
    }
    throw new Error(`Git could not stage ratchet baseline ${rel}: ${output.trim()}`);
  }
}

function isGitWorktree(root: string): boolean {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

export function indexTracksBaseline(root: string, rel: string): boolean {
  if (!isGitWorktree(root)) return false;
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', rel], {
    cwd: root,
    stdio: 'ignore',
  });
  return result.status === 0;
}

/**
 * Causes for "ignored by Git" that exist only inside a ship gate, where the tree is the PR base and
 * the plain `devkit init/upgrade` remedy misleads (sc-2357). Ship-gated: this runs in every consumer.
 */
function shipBaseCauses(): string {
  if (!process.env.DEVKIT_SHIP_BASE_SHA) return '';
  return (
    ' This gate tree is the PR base, not your checkout, so two other causes are possible:' +
    ' the base predates the .gitignore baseline exceptions (check that --base names the line your' +
    ' work is built on), or this is an overlay install where .devkit is hidden via .git/info/exclude.'
  );
}

/** Stop before migration writes when Git would refuse to track the canonical debt file. */
export function assertBaselineTrackable(root: string, rel: string): void {
  if (!isGitWorktree(root)) return;
  try {
    // Ship intentionally symlinks this mutable directory outside its commit worktree.
    if (lstatSync(join(root, dirname(rel))).isSymbolicLink()) return;
  } catch {
    // An absent destination directory is the ordinary pre-migration state; Git can still judge it.
  }
  const result = spawnSync('git', ['check-ignore', '-q', '--no-index', '--', rel], {
    cwd: root,
    stdio: 'ignore',
  });
  if (result.status === 1) return;
  if (result.status === 0) {
    throw new Error(
      `Devkit ratchet baseline migration stopped: ${rel} is ignored by Git. Run devkit init/upgrade to restore the .devkit baseline exceptions, then rerun.${shipBaseCauses()}`,
    );
  }
  throw new Error(
    `Devkit ratchet baseline migration stopped: Git could not verify that ${rel} is trackable.`,
  );
}

/**
 * Strict staging for a storage migration: add and verify the replacement before staging removal of
 * the legacy path. A staging failure can therefore leave two index entries, never debt deletion.
 */
export function stageBaselineMigration(root: string, from: string, to: string): void {
  if (!isGitWorktree(root)) return;
  const legacyWasTracked = indexTracksBaseline(root, from);
  stagePathStrict(root, to);
  if (!indexTracksBaseline(root, to)) {
    throw new Error(`Git did not stage migrated ratchet baseline ${to}.`);
  }
  if (!legacyWasTracked) return;
  stagePathStrict(root, from, { missingIsSuccess: true });
  if (indexTracksBaseline(root, from)) {
    throw new Error(`Git did not stage removal of legacy ratchet baseline ${from}.`);
  }
}

// Best-effort `git add` for a baseline the gate rewrote OR deleted, so the change rides the same
// commit. `git add -- <rel>` stages a modification AND a deletion (git records the removal), so the
// one call covers auto-lower and heal-delete alike. Never throws: a shrink must not block the gate,
// and non-git contexts (temp-dir tests, a bare checkout) simply leave the change on disk for a later
// commit/freeze.
export function stageBaseline(root: string, rel: string): void {
  try {
    execFileSync('git', ['add', '--', rel], { cwd: root, stdio: 'pipe' });
  } catch {
    // not a git repo / git absent — the change is still on disk; picked up on the next commit.
    // ponytail: also swallows the ship worktree's `fatal: pathspec ... is beyond a symbolic link`
    // (exit 128) when .devkit/baselines is symlinked in for an OVERLAY repo. Load-bearing: the write
    // itself lands on the real root file (the source of truth there, since overlay never commits
    // baselines) and staying unstaged is what keeps overlay git-invisible. So the recorded
    // "self-deletes & stages" contract (overlay-self-heal Ruling 2) degrades to "self-deletes" only
    // in that context. Do NOT realpath-resolve to force the add — that commits baselines into a repo
    // that deliberately never adopted them.
  }
}

// True iff a commit is in progress (anything staged, ANY status incl. deletions/renames). Used to
// gate the heal-delete: a folder pile heals by DELETING files, so an ACMR-only check (stagedSet)
// would miss a pure-deletion commit and never fire. Non-git / no staged changes → false (CI, a
// manual gate run — never mutate the tree there).
export function hasStagedFiles(root: string): boolean {
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: root,
      encoding: 'utf8',
    });
    return out.split('\n').some((l) => l.trim().length > 0);
  } catch {
    return false;
  }
}

// Split a NUL-delimited git list. `-z` is used so a path containing a newline (or one git would
// otherwise quote and escape) survives verbatim.
export function splitNul(out: string): string[] {
  return out.split('\0').filter((line) => line.length > 0);
}

function mergeInProgress(root: string): boolean {
  return (
    spawnSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: root }).status === 0
  );
}

/**
 * Every repo-root-relative path the pending commit TOUCHES, deletions included.
 *
 * The sibling stagedSet filters to ACMR on purpose — it scopes per-file work to files that still
 * exist. Attribution is the opposite question: every status the index can carry names a path this
 * commit changed, so a gate blaming from stagedSet lets `git rm` (D) or a symlink swap (T) of a
 * governed file read as pre-existing drift.
 *
 * Otherwise it matches stagedSet exactly: NUL-delimited so a path containing a newline is not split
 * into two wrong ones, and intersected with the MERGE_HEAD diff so a merge is blamed only for the
 * paths it actually resolved rather than everything inherited from the second parent. Returns null
 * when git cannot answer, so callers can stand down rather than blame the tree.
 */
export function stagedTouchedSet(root: string): Set<string> | null {
  // No --diff-filter at all: every status the index can carry is a path this commit touched,
  // including D (delete) and T (regular file <-> symlink). An allowlist of statuses is exactly how
  // deletions were missed once already.
  //
  // --no-renames because rename detection reports only the DESTINATION. Moving a governed file out
  // of its governed path would then be invisible to a caller matching on the source path, and the
  // drift that move caused would read as pre-existing. Split into delete + add, both sides appear.
  const argv = (args: string[]) => [
    'diff',
    '--cached',
    '--name-only',
    '-z',
    '--no-renames',
    ...args,
  ];
  try {
    const staged = new Set(
      splitNul(execFileSync('git', argv([]), { cwd: root, encoding: 'utf8' })),
    );
    // An ordinary commit has no MERGE_HEAD, and the first-parent set is the whole answer.
    if (!mergeInProgress(root)) return staged;
    try {
      const fromMergeHead = new Set(
        splitNul(
          execFileSync('git', argv(['MERGE_HEAD']), {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }),
        ),
      );
      return new Set([...staged].filter((file) => fromMergeHead.has(file)));
    } catch {
      // A merge IS in progress but its second-parent diff will not resolve, so first-parent scope
      // would blame every path inherited from MERGE_HEAD. Stand down instead of blaming the tree.
      return null;
    }
  } catch {
    return null;
  }
}

// The repo-root-relative paths ADDED/COPIED/MODIFIED/RENAMED in the pending commit (the git index).
// During a merge, a first-parent diff also includes every path inherited unchanged from MERGE_HEAD;
// intersect both parent diffs so ratchets govern only merge resolutions that differ from BOTH
// parents. Returns null when git is unavailable (temp-dir tests, a non-git checkout) so the caller
// falls back to whole-tree. Excludes deletions by design — callers scope per-file work (an oversized
// file to re-check) to files that still exist. For "is a commit in progress?" use hasStagedFiles.
export function stagedSet(root: string): Set<string> | null {
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      cwd: root,
      encoding: 'utf8',
    });
    const staged = new Set(
      out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
    try {
      const mergeOut = execFileSync(
        'git',
        ['diff', '--cached', '--name-only', '--diff-filter=ACMR', 'MERGE_HEAD'],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const changedFromMergeHead = new Set(
        mergeOut
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );
      return new Set([...staged].filter((file) => changedFromMergeHead.has(file)));
    } catch {
      // Ordinary commit, or merge metadata Git cannot resolve: preserve first-parent staged scope.
      return staged;
    }
  } catch {
    return null;
  }
}

// The CWD path inside its repository, slash-terminated (empty at the repository root).
export function gitPrefix(root: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-prefix'], {
      cwd: root,
      encoding: 'utf8',
    }).trimEnd();
  } catch {
    return '';
  }
}

/** Freeze the pending index into one immutable tree object without changing the index or worktree. */
export function indexTreeRef(root: string): string | null {
  try {
    return execFileSync('git', ['write-tree'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Read a CWD-relative UTF-8 blob from a Git tree. Missing paths or refs return null. */
export function treeTextAtRef(root: string, ref: string, relativePath: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:${gitPrefix(root)}${relativePath}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

export function mergeBaseRef(root: string, ref: string): string | null {
  try {
    return execFileSync('git', ['merge-base', ref, 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// The CWD-relative paths changed between an exact base commit and HEAD. This is the clean-index
// analogue of stagedSet for pull-request CI: GitHub supplies the base SHA, so inherited base debt
// is not attributed to the PR. NUL delimiters preserve every valid path byte except NUL itself.
export function changedSetSince(root: string, baseRef: string): Set<string> | null {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${baseRef}^{commit}`], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const prefix = gitPrefix(root);
    const out = execFileSync(
      'git',
      ['diff', '--name-only', '-z', '--diff-filter=ACMR', `${baseRef}...HEAD`],
      { cwd: root, encoding: 'utf8' },
    );
    const paths = out.split('\0').filter(Boolean);
    return new Set(
      prefix
        ? paths.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length))
        : paths,
    );
  } catch {
    return null;
  }
}

// GitHub PR checks opt into change attribution with the event's exact base SHA. No environment
// value means the ordinary local/push audit; an invalid supplied ref is an unavailable hard failure.
export function pullRequestScope(root: string): Set<string> | null {
  const baseRef = process.env.GUARD_RATCHET_BASE;
  if (!baseRef) return null;
  const scope = changedSetSince(root, baseRef);
  if (scope) return scope;
  console.error(`guard-size: pull-request base is unavailable: ${baseRef}`);
  process.exit(2);
}

// Every tracked path in the git INDEX — the tree the pending commit will record — CWD-relative.
// `git ls-files` is already scoped and addressed to the cwd. Deduped: an UNMERGED index lists a
// conflicted path once per stage (1/2/3), and a conflicted file is still one file. Returns null when
// git is unavailable, so callers can fall back to the filesystem.
export function indexFiles(root: string): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached'], {
      cwd: root,
      encoding: 'utf8',
    });
    return [...new Set(splitNul(out))];
  } catch {
    return null;
  }
}

// Every tracked path in `ref`'s tree, CWD-relative (same scoping as indexFiles). Returns null when
// the ref cannot be resolved — an UNBORN HEAD on a repo's first commit is the common case, and
// answering "no prior state" there is correct: on an initial commit every file IS new.
export function treeFilesAtRef(root: string, ref = 'HEAD'): string[] | null {
  try {
    const out = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', ref], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return splitNul(out);
  } catch {
    return null;
  }
}
