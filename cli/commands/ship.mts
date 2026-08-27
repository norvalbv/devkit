/**
 * `devkit ship` — commit explicit files onto a NEW branch and open a PR WITHOUT moving the shared
 * checkout's HEAD (so parallel agents on one tree are undisturbed). The git/gh ceremony is the
 * battle-tested bash at ../lib/ship/ship-branch.sh; this dispatcher forwards argv + stdin and
 * propagates the exit code. A consuming repo shells out to this command (never imports it); the
 * manual lane runs the identical command in a plain terminal.
 */
import { delimiter, dirname } from 'node:path';
import { runManagedPackagedScript } from '../lib/ship/run-packaged-script.mts';

export const meta = {
  name: 'ship',
  summary: 'Commit files onto a new branch + open a PR without moving HEAD.',
  help: `devkit ship — commit <path...> onto a new branch + open a PR without moving HEAD.

Usage:
  devkit ship <branch> "<title>" [--base <b>] [--body "<text>"] [--link <d>]... [--] <path...>
                          bare positional paths (no --) are accepted.

  <branch> and "<title>" are POSITIONAL and must come FIRST, before any flag. The bracketed flags
  below are optional, NOT free-floating: \`ship --base main <branch> "<title>"\` binds the branch
  name to --base and is rejected. Ship CREATES <branch>. An unrelated local branch is rejected; an
  exact commit preserved by a prior post-commit failure is resumed after its ship gate receipt, base,
  message, paths and current scoped tree are verified. On origin, use --pr to append to the existing
  PR branch instead.

  --base <branch>     Branch off origin/<branch> and target the PR at it, instead of this checkout's
                      HEAD / current branch. <path...> content is still read from your working tree,
                      so this ships even when the branch you're on has ALREADY committed those files
                      (that case otherwise stages nothing). Must be a branch on origin — a PR base
                      can't be a sha or a tag. "origin/x" and "x" are equivalent.
  --body "<text>"     Commit + PR body, inline (no temp file). Wins over stdin; omit it to read the
                      body from stdin (a pipe or here-doc) or to leave the body empty.
  --link <d>          Extra gitignored gate-dep dir to symlink into the worktree (repeatable;
                      the base .husky/_ + node_modules are always linked).
  --no-qavis-publish  Do not publish a passed staged Qavis result into the PR description for this
                      ship. The Qavis gate still runs; this suppresses only the post-push PR write.
  --pr                Re-push: add the changes to the EXISTING PR on <branch> as a new commit
                      (fast-forward, never --force) instead of opening a new PR.
  --                  Force everything after it to be a file path (ships a dash-leading filename).

Env:
  SHIP_DRY_RUN=1      Commit locally in the worktree; skip push + PR (preview).
  GUARD_COVERAGE_OK=1 Ship without verified coverage, for THIS run only (alias: GUARD_NO_COVERAGE=1).
                      For when the BASE branch already fails the coverage gate and your diff didn't
                      cause it — the gate logs a loud BYPASSED line instead of blocking, and the
                      bypass is recorded in telemetry. A shortfall your own change caused, fix.
                      Prefer \`export GUARD_COVERAGE_OK=1\` on its own line: an inline
                      \`GUARD_COVERAGE_OK=1 devkit ship …\` prefix can be stripped by
                      command-rewriting shell hooks (same caveat as SHIP_COMMIT_TIMEOUT).
                      Editing "coverage": false in guard.config.json does NOT work here — ship reads
                      that file from the committed tree, so a local-only edit is silently ignored.
  GUARD_STRUCTURE_OK=1 Ship without structure lint, for THIS run only (alias: GUARD_NO_STRUCTURE=1).
                      Use only when the BASE branch already has structure violations your diff did
                      not cause. The gate logs a loud BYPASSED line, records telemetry, and keeps
                      every other deterministic gate active. Prefer exporting it on its own line.

Exits 0 on PR opened (or committed under SHIP_DRY_RUN), 1 on any preflight/git/gh error. A commit
that lands but fails to push KEEPS the branch; an identical retry verifies and resumes that commit.
A commit that never lands auto-deletes the empty branch.`,
};

export default function ship(args: string[], cwd: string): number | Promise<number> {
  if (args.length === 0) {
    console.log(meta.help); // no args is a usage error (`--help` is intercepted in index.mjs)
    return 1;
  }
  // `--pr` (before any `--` terminator, so a dash-leading file path can't misroute) selects the
  // re-push flow: add the changes to an existing PR's branch (ff-push) instead of a new PR.
  const sep = args.indexOf('--');
  const flagArgs = sep === -1 ? args : args.slice(0, sep);
  const mode = flagArgs.includes('--pr') ? 'reship' : 'ship-branch';
  // `bash <script>` (not a direct exec of the file) so a lost +x bit through packaging can't break
  // it. stdio inherit: the PR body flows in on stdin, the PR URL out on stdout, progress on stderr,
  // and the TTY-ness the script probes (`[ -t 0 ]`) is preserved.
  //
  // MANAGED (sc-2159), matching `devkit review`: signals reach the script's own process group, not
  // the wrapper alone.
  //
  // PATH carries the node running THIS process, the way `devkit review` already does. The gate
  // supervisor bounding the commit is a node script, so no commit happens at all without node on
  // PATH — and a devkit launched through a wrapper whose PATH omits it would fail at the gate, not
  // at startup. Only PATH is touched: unlike review, ship must forward the caller's environment
  // intact (SHIP_*, DEVKIT_SHIP*, GUARD_* are all meaningful here).
  const env = {
    ...process.env,
    PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
  };
  return runManagedPackagedScript(`${mode}.sh`, args, { command: 'devkit ship', cwd, env });
}
