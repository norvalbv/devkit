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
  devkit ship <branch> "<title>" [--dry-gates] [--base <b>] [--body "<text>"] [--body-file <f>] [--link <d>]... [--] <path...>
  devkit ship --resume <branch> [--body-file <f>] [--] <extra-path...>
                          bare positional paths (no --) are accepted.

  <branch> and "<title>" are POSITIONAL and must come FIRST, before any flag. The bracketed flags
  below are optional, NOT free-floating: \`ship --base main <branch> "<title>"\` binds the branch
  name to --base and is rejected. Ship CREATES <branch>. An unrelated local branch is rejected; an
  exact commit preserved by a prior post-commit failure is resumed after its ship gate receipt, base,
  message, paths and current scoped tree are verified. Paths that ship's OWN gates added to that
  commit (a ratchet baseline it lowered) are exempt from the path and tree checks — recorded when the
  commit landed, so narrowing <path...> on the retry still refuses. On origin, use --pr to append to
  the existing PR branch instead.

  --base <branch>     For a new ship, branch off origin/<branch> and target the PR at it instead of
                      this checkout's HEAD/current branch. With --pr, explicitly replace the open
                      PR from a caller-prepared resolution on origin/<branch>: verify the exact PR
                      head/base, gate one replacement commit, then push under an exact-OID lease.
                      The caller must first rebase or merge the base; devkit does not resolve it.
                      Every path changed by the old PR must be briefed. Must name a branch on origin;
                      a PR base cannot be a sha or tag. "origin/x" and "x" are equivalent.
  --body "<text>"     Commit + PR body, inline (no temp file). Wins over stdin; omit it to read the
                      body from stdin (a pipe or here-doc) or to leave the body empty.
  --body-file <f>     Commit + PR body read from a file — author it ONCE; the recorded invocation
                      replays it on every retry. Mutually exclusive with --body; wins over stdin.
  --resume <branch>   Replay the invocation recorded by the previous attempt for <branch> (title,
                      base, body, links, paths — every attempt records itself), instead of re-typing
                      them. LEADING position only. Extra paths after [--] are MERGED into the
                      recorded set (a gate remedy that adds a file rides the retry); --body/--body-file
                      override the recorded body — note an amended body re-pays the completeness
                      judge, while an unchanged one replays its cached PASS. Works for both a blocked
                      new ship and a blocked --pr re-push (the record knows which it was). A pushed
                      ship deletes its record; a stale (>6h) or foreign record is refused by name.
  --dry-gates         Rehearse the exact ship base + explicit path staging in an ephemeral worktree.
                      Runs the formatter, configured deterministic/structure/extra gates, and the
                      changed-comment firewall; skips decisions, Qavis, domain/completeness review,
                      commit, push, and PR creation. The comment firewall may invoke its configured
                      judge. With --base, refreshes and uses the current origin tip just like ship.
                      Never leaves a local branch or commit. Cannot be combined with --resume.
  --link <d>          Extra gitignored gate-dep dir to symlink into the worktree (repeatable;
                      the base .husky/_ + node_modules are always linked).
  --no-qavis-publish  Skip the post-push step that hands a passed staged Qavis result to qavis for
                      publication. The Qavis gate still runs; only the post-push hand-off is skipped.
                      Publication needs a qavis exposing \`publish\` (qavis #85). Against an older
                      one the hand-off is inert: ship names the gap once and prints the
                      \`qavis qa --pr … --annotate description\` remedy instead.
  --pr                Re-push: add changes to the EXISTING PR on <branch> as a new commit
                      (fast-forward, never --force). Pair with --base only when replacing a PR whose
                      conflicts you already resolved; that explicit mode rewrites under an exact
                      expected-OID lease and refuses an incomplete old-PR path brief.
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

Exits 0 on PR opened, committed under SHIP_DRY_RUN, or a passing --dry-gates rehearsal; 1 on any
preflight/git/gh/gate error. A commit
that lands but fails to push KEEPS the branch; an identical retry verifies and resumes that commit.
A commit that never lands auto-deletes the empty branch. Every blocked attempt records its
invocation — retry with \`devkit ship --resume <branch>\` instead of re-typing the command.`,
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
