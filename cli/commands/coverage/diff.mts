/** `devkit coverage-diff` — coverage of the lines a change ADDED, not of the files it touched.
 * Advisory: guard-coverage stays the gate. Rationale: the sc-3228 note on coverage-gate. */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveGuardConfig, sourceMatchers } from '../../../gate-engine/config.mts';
import {
  addedLineCoverage,
  addedLinesOf,
  type LineCoverageEntry,
  lineRanges,
} from '../../../gate-engine/coverage/lines.mts';
import { COVERAGE_DIR, COVERAGE_FILE } from '../../../gate-engine/coverage/produce.mts';
import {
  blobsIn,
  checkoutRoots,
  keysByPath,
  readArtifact,
  readManifest,
  sha256,
} from '../../../gate-engine/coverage/provenance.mts';
import { TEST_PATH } from '../../../gate-engine/coverage/gate-shared.mts';
import { computePercentages } from '../../../gate-engine/coverage/run.mts';
import { type GitRun, gitRunner, line, ok } from '../../lib/ship/base-drift/git-run.mts';
import { resolveBase } from '../../lib/ship/base-drift/resolve-base.mts';

export const meta = {
  name: 'coverage-diff',
  agentFacing: true,
  summary: 'Coverage of the lines your change added (not of the files it touched).',
  help: `devkit coverage-diff — what fraction of the executable lines this change ADDED ran under test.

Usage:
  devkit coverage-diff [--base <ref>] [--min <pct>]

  --base <ref>   Compare against the merge-base of HEAD and <ref> (a branch, tag or SHA).
                 Default: $DEVKIT_BASE_REF, then origin/HEAD, then origin/main, then origin/master.
  --min <pct>    Exit 1 when the added-line coverage is below <pct> (0-100). Without it the
                 command only reports.

Reads ${COVERAGE_FILE} as \`devkit coverage-run\` left it; it never runs tests. Added lines are
committed, staged and unstaged changes since the merge-base, plus untracked source files. A line
counts when a statement starts on it (istanbul's line rule, as guard-coverage uses), so comments,
braces and types are neither covered nor uncovered.

guard-coverage enforces this same measure at commit time when guard.config.json sets
"coverage": { "scope": "diff", "addedLines": <pct> }.

Use this when a brief asks for coverage of "the new diff": whole-file percentages on a large
existing file mostly measure code the change never touched.

Exit codes: 0 report printed; 1 below --min, or the artifact is absent or malformed; 2 usage error,
or no base could be resolved.`,
};

const MAX_LISTED = 10;

interface Options {
  base?: string;
  min?: number;
}

interface Failure {
  error: string;
}

function parseOptions(args: string[]): Options | Failure {
  const opts: Options = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '--base' && value) opts.base = value;
    else if (flag === '--min' && value) {
      const min = Number(value);
      if (!Number.isFinite(min) || min < 0 || min > 100) {
        return { error: `--min must be 0-100, got ${value}` };
      }
      opts.min = min;
    } else return { error: `unknown or incomplete argument: ${flag}` };
    i += 1;
  }
  return opts;
}

/** The merge-base sha plus a label naming what it was taken against. */
function mergeBaseOf(
  run: GitRun,
  base: string | undefined,
): { sha: string; label: string } | Failure {
  let target: string;
  let label: string;
  if (base) {
    const r = run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`]);
    if (!ok(r)) return { error: `cannot resolve --base ${base} to a commit` };
    target = line(r);
    label = base;
  } else {
    const resolved = resolveBase(run);
    if (resolved.kind !== 'resolved') {
      return { error: `no base branch found (${resolved.reason}) — pass --base <ref>` };
    }
    target = resolved.sha;
    label = resolved.base;
  }
  const mb = run(['merge-base', 'HEAD', target]);
  if (!ok(mb)) return { error: `HEAD shares no history with ${label} — pass --base <ref>` };
  return { sha: line(mb), label };
}

const nulList = (out: string): string[] => out.split('\0').filter(Boolean);

/** Added new-side line numbers of one tracked path since `mergeBase` (working tree included). */
function addedLines(run: GitRun, mergeBase: string, path: string): Set<number> {
  const diff = run([
    '--literal-pathspecs',
    'diff',
    '-U0',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-relative',
    mergeBase,
    '--',
    path,
  ]);
  return addedLinesOf(diff.stdout);
}

/** Every line of an untracked file is added. */
function allLines(top: string, path: string): Set<number> {
  const count = readFileSync(join(top, path), 'utf8').split('\n').length;
  return new Set(Array.from({ length: count }, (_, i) => i + 1));
}

/** Measured paths whose bytes differ from what the coverage run measured, so its line numbers may
 * not match the diff's. Empty when the artifact carries no trustworthy manifest (reported apart). */
function stalePaths(
  run: GitRun,
  top: string,
  manifest: NonNullable<ReturnType<typeof readManifest>>,
  paths: string[],
): string[] {
  if (paths.length === 0) return [];
  const now = run(['--literal-pathspecs', 'hash-object', '--', ...paths]);
  if (!ok(now)) return paths;
  const current = line(now).split('\n');
  let atHead: Map<string, string>;
  try {
    atHead = blobsIn(
      top,
      manifest.head,
      paths.filter((p) => !Object.hasOwn(manifest.dirty, p)),
    );
  } catch {
    return paths;
  }
  return paths.filter((p, i) => (manifest.dirty[p] ?? atHead.get(p)) !== current[i]);
}

const pct = (covered: number, total: number): string => `${((covered / total) * 100).toFixed(1)}%`;

function listCapped(paths: string[]): string[] {
  const lines = paths.slice(0, MAX_LISTED).map((p) => `     ${p}`);
  if (paths.length > MAX_LISTED) lines.push(`     …and ${paths.length - MAX_LISTED} more`);
  return lines;
}

export default function coverageDiff(args: string[], cwd: string): number {
  const opts = parseOptions(args);
  if ('error' in opts) {
    console.error(`devkit coverage-diff: ${opts.error}\n\n${meta.help}`);
    return 2;
  }

  const file = resolve(cwd, COVERAGE_FILE);
  let artifact: ReturnType<typeof readArtifact>;
  let cov: Record<string, LineCoverageEntry>;
  try {
    artifact = readArtifact(file);
    cov = JSON.parse(artifact.bytes);
    computePercentages(cov); // shape validation: throws on a malformed entry
  } catch {
    const why = existsSync(file) ? 'unreadable or malformed' : 'absent';
    console.error(
      `🚫 ${COVERAGE_FILE} is ${why}. Produce it with \`devkit coverage-run\`, then re-run.`,
    );
    return 1;
  }

  const probe = gitRunner(cwd);
  const topResult = probe(['rev-parse', '--show-toplevel']);
  if (!ok(topResult)) {
    console.error('devkit coverage-diff: not inside a git repository.');
    return 2;
  }
  const top = line(topResult);
  const run = gitRunner(top);
  const mb = mergeBaseOf(run, opts.base);
  if ('error' in mb) {
    console.error(`devkit coverage-diff: ${mb.error}`);
    return 2;
  }

  const manifest = readManifest(resolve(cwd, COVERAGE_DIR));
  const bound =
    manifest &&
    sha256(artifact.bytes) === manifest.artifactSha256 &&
    artifact.identity === manifest.artifactIdentity
      ? manifest
      : null;
  const keys = keysByPath(Object.keys(cov), bound ? bound.roots : checkoutRoots(cwd, top));
  const { isSource } = sourceMatchers(resolveGuardConfig(cwd).sourceExtensions);
  const relevant = (p: string) => keys.has(p) || (isSource(p) && !TEST_PATH.test(p));

  const changed = nulList(
    run(['diff', '--name-only', '-z', '--no-renames', '--no-relative', '--diff-filter=AM', mb.sha])
      .stdout,
  ).filter(relevant);
  const untracked = nulList(
    run(['ls-files', '-z', '--others', '--exclude-standard']).stdout,
  ).filter(relevant);

  const rows: { path: string; covered: number; total: number; uncovered: number[] }[] = [];
  const notMeasured: string[] = [];
  for (const [paths, linesOf] of [
    [changed, (p: string) => addedLines(run, mb.sha, p)],
    [untracked, (p: string) => allLines(top, p)],
  ] as const) {
    for (const path of paths) {
      const key = keys.get(path);
      if (key === undefined) notMeasured.push(path);
      else rows.push({ path, ...addedLineCoverage(cov[key] ?? {}, linesOf(path)) });
    }
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));

  console.log(`Coverage of lines added since ${mb.label} (merge-base ${mb.sha.slice(0, 12)}):`);
  let covered = 0;
  let total = 0;
  for (const r of rows) {
    if (r.total === 0) continue;
    covered += r.covered;
    total += r.total;
    const missing = r.uncovered.length ? `   uncovered: ${lineRanges(r.uncovered)}` : '';
    console.log(
      `  ${`${r.covered}/${r.total}`.padStart(9)}  ${pct(r.covered, r.total).padStart(6)}  ${r.path}${missing}`,
    );
  }
  if (total === 0) console.log('  no executable added lines in measured files.');
  else
    console.log(
      `Total: ${covered}/${total} added executable lines covered (${pct(covered, total)}).`,
    );

  if (notMeasured.length) {
    console.log(`Not measured — changed source files absent from ${COVERAGE_FILE}:`);
    for (const l of listCapped(notMeasured.sort())) console.log(l);
  }
  if (!bound) {
    console.log(
      '⚠️  Artifact provenance unknown (not from `devkit coverage-run`, or replaced since):',
    );
    console.log('   line numbers may describe a different tree than the one diffed.');
  } else {
    const stale = stalePaths(
      run,
      top,
      bound,
      rows.map((r) => r.path),
    );
    if (stale.length) {
      console.log(
        '⚠️  Changed since the coverage run — line numbers may be stale; re-run `devkit coverage-run`:',
      );
      for (const l of listCapped(stale)) console.log(l);
    }
  }

  if (opts.min !== undefined && total > 0 && (covered / total) * 100 < opts.min) {
    console.error(`🚫 Added-line coverage ${pct(covered, total)} is below --min ${opts.min}%.`);
    return 1;
  }
  return 0;
}
