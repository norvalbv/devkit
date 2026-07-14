/**
 * `devkit ship` — commit explicit files onto a NEW branch and open a PR WITHOUT moving the shared
 * checkout's HEAD (so parallel agents on one tree are undisturbed). The git/gh ceremony is the
 * battle-tested bash at ../lib/ship/ship-branch.sh; this dispatcher forwards argv + stdin and
 * propagates the exit code. A consuming repo shells out to this command (never imports it); the
 * manual lane runs the identical command in a plain terminal.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const meta = {
  name: 'ship',
  summary: 'Commit files onto a new branch + open a PR without moving HEAD.',
  help: `devkit ship — commit <path...> onto a new branch + open a PR without moving HEAD.

Usage:
  devkit ship <branch> "<title>" [--base <b>] [--body "<text>"] [--link <d>]... [--] <path...>
                          bare positional paths (no --) are accepted.

  --base <branch>     Branch off origin/<branch> and target the PR at it, instead of this checkout's
                      HEAD / current branch. <path...> content is still read from your working tree,
                      so this ships even when the branch you're on has ALREADY committed those files
                      (that case otherwise stages nothing). Must be a branch on origin — a PR base
                      can't be a sha or a tag. "origin/x" and "x" are equivalent.
  --body "<text>"     Commit + PR body, inline (no temp file). Wins over stdin; omit it to read the
                      body from stdin (a pipe or here-doc) or to leave the body empty.
  --link <d>          Extra gitignored gate-dep dir to symlink into the worktree (repeatable;
                      the base .husky/_ + node_modules are always linked).
  --pr                Re-push: add the changes to the EXISTING PR on <branch> as a new commit
                      (fast-forward, never --force) instead of opening a new PR.
  --                  Force everything after it to be a file path (ships a dash-leading filename).

Env:
  SHIP_DRY_RUN=1      Commit locally in the worktree; skip push + PR (preview).

Exits 0 on PR opened (or committed under SHIP_DRY_RUN), 1 on any preflight/git/gh error. A commit
that lands but fails to push KEEPS the branch (recovery line on stderr); a commit that never lands
auto-deletes the empty branch.`,
};

export default function ship(args: string[], cwd: string): number {
  if (args.length === 0) {
    console.log(meta.help); // no args is a usage error (`--help` is intercepted in index.mjs)
    return 1;
  }
  // `--pr` (before any `--` terminator, so a dash-leading file path can't misroute) selects the
  // re-push flow: add the changes to an existing PR's branch (ff-push) instead of a new PR.
  const sep = args.indexOf('--');
  const flagArgs = sep === -1 ? args : args.slice(0, sep);
  const mode = flagArgs.includes('--pr') ? 'reship' : 'ship-branch';
  const script = fileURLToPath(new URL(`../lib/ship/${mode}.sh`, import.meta.url));
  // `bash <script>` (not a direct exec of the file) so a lost +x bit through packaging can't break
  // it. stdio inherit: the PR body flows in on stdin, the PR URL out on stdout, progress on stderr,
  // and the TTY-ness the script probes (`[ -t 0 ]`) is preserved.
  const r = spawnSync('bash', [script, ...args], { cwd, stdio: 'inherit' });
  if (r.error) {
    console.error(`devkit ship: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}
