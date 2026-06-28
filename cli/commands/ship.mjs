/**
 * `devkit ship` — commit explicit files onto a NEW branch and open a PR WITHOUT moving the shared
 * checkout's HEAD (so parallel agents on one tree are undisturbed). The git/gh ceremony is the
 * battle-tested bash at ../lib/ship/ship-branch.sh; this dispatcher forwards argv + stdin and
 * propagates the exit code. A consuming repo shells out to this command (never imports it); the
 * manual lane runs the identical command in a plain terminal.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELP = `devkit ship — commit <path...> onto a new branch + open a PR without moving HEAD.

Usage:
  devkit ship <branch> "<title>" [--body "<text>"] [--markers-dir <d>]... [--link <d>]... [--] <path...>
                          bare positional paths (no --) are accepted.

  --body "<text>"     Commit + PR body, inline (no temp file). Wins over stdin; omit it to read the
                      body from stdin (a pipe or here-doc) or to leave the body empty.
  --markers-dir <d>   Reviewer-marker dir to carry into the commit worktree (repeatable;
                      default .claude + .cursor). A repo without these dirs carries nothing.
  --link <d>          Extra gitignored gate-dep dir to symlink into the worktree (repeatable;
                      the base .husky/_ + node_modules are always linked).
  --pr                Re-push: add the changes to the EXISTING PR on <branch> as a new commit
                      (fast-forward, never --force) instead of opening a new PR.
  --                  Force everything after it to be a file path (ships a dash-leading filename).

Env:
  SHIP_DRY_RUN=1      Commit locally in the worktree; skip push + PR (preview).

Exits 0 on PR opened (or committed under SHIP_DRY_RUN), 1 on any preflight/git/gh error. A commit
that lands but fails to push KEEPS the branch (recovery line on stderr); a commit that never lands
auto-deletes the empty branch.`;

export default function ship(args, cwd) {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP);
    return args.length === 0 ? 1 : 0; // no args is a usage error; explicit --help is success
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
