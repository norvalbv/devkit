/** `devkit base-status` — the operator-facing surface over cli/lib/ship/base-drift (sc-2297). */
import { runBaseStatus } from '../../lib/ship/base-drift/cli.mts';

export const meta = {
  name: 'base-status',
  summary: 'Report whether origin/<base> moved under this checkout, and which paths it touched.',
  help: `devkit base-status — has the base moved under this worktree?

Usage:
  devkit base-status [--base <branch>] [--json] [--max-age-ms <n>] [--] [<path>...]

Fetches origin/<base> (TTL-cached across sibling worktrees of the same clone), compares it with
this checkout, and reports which files moved on the base since the two diverged. With paths, only
the ones overlapping those paths are reported.

Options:
  --base <branch>     Base to compare against. Defaults to $DEVKIT_BASE_REF, then origin/HEAD,
                      then main, then master. A base that cannot be verified is never guessed past.
  --json              Emit the full report as JSON.
  --max-age-ms <n>    Refs older than this are re-fetched. Default 0 (always fetch): an explicit
                      check must not answer from cached refs.
  --exit-zero         Always exit 0. For advisory callers that must not fail on a drift verdict.
  --ship              Use the ship-facing wording instead of the operator status block.

Exit codes:
  0  base resolved, refs current, no overlap
  2  usage error
  3  DRIFT — one or more of your paths also changed on the base
  4  could not determine — base unresolvable, unrelated histories, or the fetch failed

Exit 4 is deliberately not 0. A green computed from refs of unknown age is the false confidence
this command exists to prevent.

Examples:
  devkit base-status --base main
  devkit base-status --base main -- src/db/migrations package.json
  devkit base-status --json | jq .overlap`,
};

export default function baseStatus(args: string[], cwd: string): number {
  const { text, code, ship } = runBaseStatus(args, cwd);
  // Same stream contract as the direct entrypoint: --ship renders ship's own advisory, which belongs
  // on stderr beside its progress output, and stdout is reserved for the answer a caller asked for.
  if (text) (ship ? process.stderr : process.stdout).write(`${text}\n`);
  return code;
}
