/** `devkit review` — run the configured gate chain against a trusted checkout without committing. */
import { delimiter, dirname } from 'node:path';
import { packageDir } from '../lib/fs-helpers.mts';
import { runManagedPackagedScript } from '../lib/ship/run-packaged-script.mts';

export const meta = {
  name: 'review',
  agentFacing: true,
  summary: 'Review a trusted checkout without committing or changing it.',
  help: `devkit review — run the configured pre-commit chain against a trusted checkout.

Usage:
  devkit review [--target <path>] [--base <ref>]

  --target <path>  Local checkout/worktree to review (default: current repository).
  --base <ref>     Comparison base. Default: origin/HEAD, then local main, then local master.

The reviewed snapshot includes committed branch changes plus staged, unstaged, deleted, and
non-ignored untracked files. Devkit never fetches, calls GitHub, commits, pushes, or copies gate
changes back. The target checkout stays unchanged, although Git's shared worktree metadata is
touched temporarily while the isolated review worktrees exist.

Overlay setup is local to each checkout and is not copied by Git. Before reviewing a fresh clone of
an overlay consumer, run \`devkit init --overlay --review\` inside that target checkout.

WARNING: target-controlled hooks and package scripts execute. Review trusted targets only.

Output streams for the whole run, not just the gates: setup and teardown emit a
'phase=<name> t=<elapsed>s' line as each step begins, so a slow run is distinguishable from a wedged
one by tailing the log. Every invocation writes a unique log under .devkit/review-runs/<run-id>.log
in the target repository. Each log ends with a
'result=<passed|skipped|failed|timeout|signaled> exit=<code> phase=<phase>' line. A log without one
did not reach its own terminal — the run was killed, aborted before setup, or could not finish
writing.

Env:
  SHIP_COMMIT_TIMEOUT     Full-chain timeout in seconds (default 3600; shared with devkit ship).
  DEVKIT_PREFLIGHT_TIMEOUT  Ceiling for setup/teardown — the worktree checkouts, dependency and
                          asset materialization, and cleanup that sit outside the gate chain.
                          Defaults to SHIP_COMMIT_TIMEOUT, so one knob normally moves both. Set it
                          only to bound setup separately from the gates. A wedged step is reported
                          as a 124 timeout naming the phase it died in.

Exits 0 when the review passes or there is nothing to review, 1 on argument/setup/gate/format
failure, and preserves timeout statuses such as 124.`,
};

const INHERITED_RUN_CONTEXT = new Set([
  'DEVKIT_COMMIT_MSG_FILE', // stale ship intent must not leak in; review-target.sh synthesizes its own
  'DEVKIT_GATE_ARCHIVE_LOG',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_RUN_MODE',
  'GUARD_DECISIONS_DIR',
]);

// These two values describe the target rather than a previous run. Frink/root-agent orchestration
// may inject them when repository layout cannot be inferred from config alone.
const REVIEW_TOPOLOGY_INPUTS = new Set([
  'DEVKIT_REVIEW_BACKEND_ROOTS',
  'DEVKIT_REVIEW_FRONTEND_ROOTS',
]);

function validateArgs(args: readonly string[]): string | null {
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag !== '--target' && flag !== '--base') return `unknown argument: ${flag}`;
    if (seen.has(flag)) return `${flag} may only be specified once`;
    seen.add(flag);

    const value = args[index + 1];
    if (!value || value.startsWith('--')) return `${flag} requires a value`;
    index++;
  }
  return null;
}

/** A review always creates fresh run identity; caller credentials and ordinary tool config remain. */
function reviewEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  for (const name of Object.keys(sanitized)) {
    const inheritedReviewContext =
      name.startsWith('DEVKIT_REVIEW_') && !REVIEW_TOPOLOGY_INPUTS.has(name);
    const inheritedShipContext =
      name.startsWith('DEVKIT_SHIP') ||
      (name.startsWith('SHIP_') && name !== 'SHIP_COMMIT_TIMEOUT');
    if (INHERITED_RUN_CONTEXT.has(name) || inheritedReviewContext || inheritedShipContext) {
      delete sanitized[name];
    }
  }
  sanitized.PATH = [dirname(process.execPath), environment.PATH].filter(Boolean).join(delimiter);
  sanitized.DEVKIT_REVIEW_PACKAGE_ROOT = packageDir();
  return sanitized;
}

export default function review(args: string[], cwd: string): number | Promise<number> {
  const error = validateArgs(args);
  if (error) {
    console.error(`devkit review: ${error}`);
    return 1;
  }

  console.error(
    'devkit review: WARNING: target-controlled hooks and package scripts will execute; review trusted targets only.',
  );
  return runManagedPackagedScript('review-target.sh', args, {
    command: 'devkit review',
    cwd,
    env: reviewEnvironment(process.env),
  });
}
