/** `devkit coverage-run --changed[=<ref>]`: a per-file coverage table for a branch's diff, never
 * published. Why each injected flag exists: the 2026-10-02 note on docs/decisions/coverage-gate.md. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolveGuardConfig } from '../config.mts';
import { pruneStaleRuns, RESERVED_FLAG, reservesCoverageDir, resolveRunDir } from './produce.mts';
import { resolveVitest, runVitestDetailed } from './vitest-cli.mts';

export const CHANGED_FLAG = '--changed';
export const DEFAULT_BASE = 'origin/HEAD';

const isChanged = (arg: string): boolean =>
  arg === CHANGED_FLAG || arg.startsWith(`${CHANGED_FLAG}=`);

/** The base ref and the remaining vitest args, or null when argv carries no `--changed`. Accepts the
 * same spellings vitest does: `--changed`, `--changed=<ref>` and `--changed <ref>`. */
export function takeChanged(argv: string[]): { base: string; rest: string[] } | null {
  const at = argv.findIndex(isChanged);
  if (at < 0) return null;
  const flag = argv[at];
  const next = argv[at + 1];
  const spaced = flag === CHANGED_FLAG && next !== undefined && !next.startsWith('-');
  const base =
    flag === CHANGED_FLAG ? (spaced ? next : DEFAULT_BASE) : flag.slice(CHANGED_FLAG.length + 1);
  const rest = argv.filter((_, i) => i !== at && !(spaced && i === at + 1));
  return { base, rest };
}

/** `coverage.include` globs for the consumer's own source layout. */
export function includeGlobs(scanRoots: string[], extensions: string[]): string[] {
  const exts = extensions.map((e) => e.replace(/^\./, ''));
  return scanRoots.flatMap((root) => {
    const dir = root.replace(/^\.\/?/, '').replace(/\/+$/, '');
    return exts.map((ext) => (dir ? `${dir}/**/*.${ext}` : `**/*.${ext}`));
  });
}

const owns = (argv: string[], flag: string): boolean =>
  argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`) || arg.startsWith(`${flag}.`));

/** Whether `ref` names a commit in this repo. */
function resolvesToCommit(cwd: string, ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** The vitest argv for one changed-only run into `runDir`. Pure, so every injection is testable. */
export function changedArgs(
  base: string,
  rest: string[],
  runDir: string,
  scanRoots: string[],
  extensions: string[],
): string[] {
  const reporter = owns(rest, '--coverage.reporter') ? [] : ['--coverage.reporter=text'];
  const include = owns(rest, '--coverage.include')
    ? []
    : includeGlobs(scanRoots, extensions).map((glob) => `--coverage.include=${glob}`);
  return [
    'run',
    `${CHANGED_FLAG}=${base}`,
    '--coverage.enabled',
    `${RESERVED_FLAG}=${runDir}`,
    ...reporter,
    ...include,
    ...rest,
  ];
}

/** Run the changed-only coverage table and return vitest's exit code. Publishes nothing. */
export async function runChangedCoverage(
  cwd: string,
  changed: { base: string; rest: string[] },
): Promise<number> {
  const { base, rest } = changed;
  if (rest.some(isChanged)) {
    console.error(
      `🚫 ${CHANGED_FLAG} was given twice; pass one base, e.g. ${CHANGED_FLAG}=origin/main.`,
    );
    return 1;
  }
  if (reservesCoverageDir(rest)) {
    console.error(`🚫 ${RESERVED_FLAG} is owned by \`devkit coverage-run\`; drop it.`);
    return 1;
  }
  const vitest = resolveVitest(cwd);
  if (!vitest) {
    console.error(
      '🚫 devkit coverage-run --changed needs vitest — node_modules/.bin/vitest not found.',
    );
    return 1;
  }
  if (!resolvesToCommit(cwd, base)) {
    console.error(`🚫 ${CHANGED_FLAG} base '${base}' does not resolve to a commit.`);
    if (base === DEFAULT_BASE) {
      console.error(
        '   origin/HEAD is unset in this clone: run `git remote set-head origin --auto`,',
      );
      console.error(`   or name the base, e.g. ${CHANGED_FLAG}=origin/main.`);
    } else {
      console.error(
        `   Fetch it first (git fetch origin), or name another, e.g. ${CHANGED_FLAG}=HEAD~1.`,
      );
    }
    return 1;
  }
  const { scanRoots, sourceExtensions } = resolveGuardConfig(cwd);
  pruneStaleRuns(cwd);
  const runDir = resolveRunDir(cwd);
  mkdirSync(runDir, { recursive: true });
  try {
    const args = changedArgs(base, rest, runDir, scanRoots, sourceExtensions);
    return (await runVitestDetailed(vitest, args, cwd)).code;
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}
