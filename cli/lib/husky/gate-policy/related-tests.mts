/**
 * Self-host `related-tests` extra gate: runs the tests vitest's import graph relates to the
 * commit's staged paths, so a test broken by the change blocks before any AI judge runs.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runVitestDetailed, type VitestRun } from '../../../../gate-engine/coverage/vitest-cli.mts';
import { commitIndexEnv } from '../../../../gate-engine/ratchets/commit-index.mts';
import { stagedSet } from '../../../../gate-engine/ratchets/git-index.mts';

// Runs with every selection: it fails when a module is left unreachable to `vitest related` itself.
const REACH_TEST = 'cli/__tests__/test-graph-reach.test.mts';

// vitest's forceRerunTriggers (**/package.json, **/{vitest,vite}.config.*, setupFiles) select the
// whole suite, which CI already runs.
const RERUN_TRIGGER_RE = /(^|\/)(package\.json|(vitest|vite)\.config\.[^/]*)$|^vitest\.setup\.mjs$/;

/** The staged paths handed to `vitest related`, sorted, minus the full-suite triggers. */
export function relatedPaths(staged: Iterable<string>): string[] {
  return [...staged].filter((p) => !RERUN_TRIGGER_RE.test(p)).sort();
}

// Extensions vite can hold in its module graph; any other staged path never selects a test.
const MODULE_RE = /\.[cm]?[jt]sx?$|\.json$/;

/** Staged paths `vitest related` cannot map to a test, such as shell scripts and templates. */
export function unmappedPaths(paths: string[]): string[] {
  return paths.filter((p) => !MODULE_RE.test(p));
}

type Grep = (root: string, needles: string[]) => ReadonlyMap<string, Iterable<string>>;

// `reship.test.mts` first, then `reship-*.test.mts`, then any other test naming reship.sh.
function nameRank(test: string, stem: string): number {
  if (test === `${stem}.test.mts`) return 0;
  return test.startsWith(stem) ? 1 : 2;
}

/** The commit-index test files naming each needle: one ls-files and one grep however many there are. */
function gitGrepTests(root: string, needles: string[]): Map<string, Set<string>> {
  const env = commitIndexEnv(root);
  const ls = spawnSync('git', ['ls-files', '--cached', '-z'], { cwd: root, env, encoding: 'utf8' });
  const counts = new Map<string, number>();
  for (const f of ls.stdout.split('\0')) {
    if (f && !f.startsWith('dist/')) counts.set(basename(f), (counts.get(basename(f)) ?? 0) + 1);
  }
  // A basename several sources share (README.md, check.sh) names none of them; dist/ only mirrors.
  const named = needles.filter((n) => (counts.get(n) ?? 0) < 2);
  const hits = new Map<string, Set<string>>();
  if (!named.length) return hits;
  // -o prints `file\0match` per hit; -w keeps a test naming reship.sh from naming ship.sh.
  const args = ['grep', '--cached', '-zowF', ...named.flatMap((n) => ['-e', n])];
  const r = spawnSync('git', [...args, '--', ':(glob)**/*.test.mts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  if (r.status === 1) return hits;
  if (r.status !== 0) throw new Error(r.stderr || 'git grep failed');
  for (const [file, match] of r.stdout.split('\n').map((l) => l.split('\0'))) {
    if (match) hits.set(match, (hits.get(match) ?? new Set()).add(file));
  }
  return hits;
}

/** Names each unmapped staged path and the tests that mention it, since vitest related ran none. */
export function noteUnmapped(root: string, paths: string[], grep: Grep = gitGrepTests): void {
  try {
    const unmapped = unmappedPaths(paths);
    if (!unmapped.length) return;
    const hits = grep(root, [...new Set(unmapped.map((p) => basename(p)))]);
    const lines = unmapped.flatMap((p) => {
      const stem = basename(p, extname(p));
      const tests = [...(hits.get(basename(p)) ?? [])]
        .map((t) => basename(t))
        .sort((a, b) => nameRank(a, stem) - nameRank(b, stem));
      if (!tests.length) return [];
      const more = tests.length > 3 ? ` (+${tests.length - 3})` : '';
      return [`  ${p} ← ${tests.slice(0, 3).join(', ')}${more}`];
    });
    if (!lines.length) return;
    console.log(
      `related-tests: ${lines.length} staged path(s) have no import-graph tests — not run here, CI will:`,
    );
    console.log(lines.join('\n'));
  } catch {
    // Disclosure only: a failed lookup never changes the gate's verdict.
  }
}

type Exec = (bin: string, args: string[], cwd: string) => Promise<VitestRun>;

interface RunOpts {
  staged?: Iterable<string> | null;
  exec?: Exec;
}

// Grouped, so a signal to this gate also ends vitest's fork workers rather than orphaning them.
const runGrouped: Exec = (bin, args, cwd) =>
  runVitestDetailed(bin, args, cwd, process.env, { group: true });

/** The related-tests run: code 0 when nothing is selected, vitest's outcome otherwise. */
export async function runRelatedTests(root: string, opts: RunOpts = {}): Promise<VitestRun> {
  const paths = relatedPaths(('staged' in opts ? opts.staged : stagedSet(root)) ?? []);
  if (!paths.length) {
    console.log('related-tests: none selected');
    return { code: 0, interrupted: false };
  }
  console.log(`related-tests: ${paths.length} staged path(s)`);
  const vitest = join(root, 'node_modules', '.bin', 'vitest');
  const args = ['related', '--run', '--reporter=dot', ...new Set([...paths, REACH_TEST])];
  const run = await (opts.exec ?? runGrouped)(vitest, args, root);
  // A signalled gate blocks, even when vitest still exits 0 after the forwarded signal.
  return run.interrupted && run.code === 0 ? { ...run, code: 1 } : run;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const run = await runRelatedTests(process.cwd());
  if (!run.interrupted) noteUnmapped(process.cwd(), relatedPaths(stagedSet(process.cwd()) ?? []));
  process.exitCode = run.code;
}
