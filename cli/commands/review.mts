/** `devkit review` — run a target checkout's full pre-commit chain against a synthetic staged diff. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REVIEW_DECISIONS_DIR,
  GUARD_IDS,
  normalizeReviewProfile,
  normalizeSelection,
  type Selection,
} from '../lib/components.mts';
import { packageDir } from '../lib/fs-helpers.mts';
import { reviewHookDrift } from '../lib/husky/review-drift.mts';

export const meta = {
  name: 'review',
  summary: 'Run the full pre-commit chain against a trusted checkout without committing.',
  help: `devkit review — review a trusted local checkout/worktree without creating a commit.

Usage:
  devkit review [--target <path>] [--base <ref>]

  --target <path>  Checkout/worktree to review (default: current repository).
  --base <ref>     Comparison base. Default: origin/HEAD, then local main, then master.

The reviewed snapshot is merge-base…HEAD plus tracked/untracked local changes. Devkit never fetches,
pushes, commits, or calls GitHub. The complete configured pre-commit chain runs in an ephemeral
worktree; Git's shared worktree metadata is touched temporarily, but the target checkout stays
unchanged. Target-controlled hooks/scripts execute, so use trusted targets only.

The overlay ESLint and Fallow gates compare the final snapshot with fresh ephemeral results from the
resolved merge-base, so inherited lint/dead-code/duplication/complexity debt does not block review.
No generated baseline is copied back to the target.

The local .devkit/config.json review profile enables this command, selects its guard allowlist, and
sets decisionsDir. Decision records themselves remain Markdown under that directory.

Env:
  SHIP_COMMIT_TIMEOUT  Full-chain timeout in seconds (default 3600; shared with devkit ship).
  DEVKIT_REVIEW_BACKEND_ROOTS / DEVKIT_REVIEW_FRONTEND_ROOTS
                       Optional JSON arrays injected by orchestration for this target. Otherwise a
                       non-empty guard.config.json review root wins, then scanRoots is used.

Exits 0 on pass/nothing-to-review, 1 on setup/gate/format failure, and preserves timeout statuses.`,
};

interface ReviewConfig {
  components?: Partial<Selection>;
  review?: { enabled?: unknown; guards?: unknown; decisionsDir?: unknown };
}

function loadReviewEnvironment(targetRoot: string): NodeJS.ProcessEnv | null {
  let config: ReviewConfig;
  try {
    config = JSON.parse(readFileSync(resolve(targetRoot, '.devkit/config.json'), 'utf8'));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(
      `devkit review: could not read .devkit/config.json (${message}) — run 'devkit doctor --fix'.`,
    );
    return null;
  }

  const installed = normalizeSelection(config.components ?? {}).guards;
  const rawReview = config.review;
  if (rawReview && rawReview.enabled === false) {
    console.error("devkit review: disabled by .devkit/config.json — run 'devkit init --review'.");
    return null;
  }
  const requested = Array.isArray(rawReview?.guards)
    ? rawReview.guards.filter((guard): guard is string => typeof guard === 'string')
    : installed;
  const invalid = requested.filter(
    (guard) => !GUARD_IDS.includes(guard) || !installed.includes(guard),
  );
  if (invalid.length > 0) {
    console.error(
      `devkit review: review.guards contains unknown or uninstalled guards: ${invalid.join(', ')} — run 'devkit init --review'.`,
    );
    return null;
  }
  const profile = normalizeReviewProfile(
    {
      enabled: typeof rawReview?.enabled === 'boolean' ? rawReview.enabled : true,
      guards: requested,
      decisionsDir:
        typeof rawReview?.decisionsDir === 'string'
          ? rawReview.decisionsDir
          : DEFAULT_REVIEW_DECISIONS_DIR,
    },
    installed,
    true,
  );
  return {
    ...process.env,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    DEVKIT_RUN_MODE: 'review',
    DEVKIT_REVIEW_GUARDS: profile.guards.join(','),
    GUARD_DECISIONS_DIR: profile.decisionsDir,
    DEVKIT_REVIEW_PACKAGE_ROOT: packageDir(),
  };
}

interface ReviewArgs {
  target: string | null;
  base: string | null;
}

function parseArgs(args: string[]): { value: ReviewArgs } | { error: string } {
  const value: ReviewArgs = { target: null, base: null };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag !== '--target' && flag !== '--base') return { error: `unknown argument: ${flag}` };
    if (seen.has(flag)) return { error: `${flag} may only be specified once` };
    seen.add(flag);
    if (!args[i + 1]) return { error: `${flag} requires a value` };
    if (flag === '--target') value.target = args[i + 1];
    else value.base = args[i + 1];
    i++;
  }
  return { value };
}

export default function review(args: string[], cwd: string): number {
  const parsed = parseArgs(args);
  if ('error' in parsed) {
    console.error(`devkit review: ${parsed.error}`);
    return 1;
  }
  const target = resolve(cwd, parsed.value.target ?? '.');
  const rootResult = spawnSync('git', ['-C', target, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  if (rootResult.status !== 0) {
    console.error(`devkit review: target is not inside a Git repository: ${target}`);
    return 1;
  }
  const targetRoot = rootResult.stdout.trim();
  const env = loadReviewEnvironment(targetRoot);
  if (!env) return 1;
  try {
    const drift = reviewHookDrift(targetRoot);
    if (drift) {
      console.error(`devkit review: ${drift} — run 'devkit doctor --fix'.`);
      return 1;
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(
      `devkit review: could not validate devkit setup (${message}) — run 'devkit doctor --fix'.`,
    );
    return 1;
  }
  const script = fileURLToPath(new URL('../lib/ship/review-target.sh', import.meta.url));
  const scriptArgs = [
    ...(parsed.value.target === null ? [] : ['--target', parsed.value.target]),
    ...(parsed.value.base === null ? [] : ['--base', parsed.value.base]),
  ];
  const result = spawnSync('bash', [script, ...scriptArgs], { cwd, env, stdio: 'inherit' });
  if (result.error) {
    console.error(`devkit review: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}
