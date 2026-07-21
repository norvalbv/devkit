/** `devkit review` — run the configured gate chain against a trusted checkout without committing. */
import { delimiter, dirname } from 'node:path';
import { packageDir } from '../lib/fs-helpers.mts';
import { runManagedPackagedScript } from '../lib/ship/run-packaged-script.mts';

export const meta = {
  name: 'review',
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

WARNING: target-controlled hooks and package scripts execute. Review trusted targets only.

Output streams as the gates run. Every invocation also writes a unique log under
.devkit/review-runs/<run-id>.log in the target repository.

Env:
  SHIP_COMMIT_TIMEOUT  Full-chain timeout in seconds (default 3600; shared with devkit ship).

Exits 0 when the review passes or there is nothing to review, 1 on argument/setup/gate/format
failure, and preserves timeout statuses such as 124.`,
};

const INHERITED_RUN_CONTEXT = new Set([
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
