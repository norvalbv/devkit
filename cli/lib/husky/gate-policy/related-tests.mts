/**
 * Self-host `related-tests` extra gate: runs the tests vitest's import graph relates to the
 * commit's staged paths, so a test broken by the change blocks before any AI judge runs.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commitIndexEnv } from '../../../../gate-engine/ratchets/commit-index.mts';
import { stagedSet } from '../../../../gate-engine/ratchets/git-index.mts';

// Runs with every selection: it fails when a module is left unreachable to `vitest related` itself.
const REACH_TEST = 'cli/__tests__/test-graph-reach.test.mts';

// The env-scrub test reads these from disk, so no import edge selects it. The ship-script pattern
// mirrors that test's own top-level scan of cli/lib/ship.
const SCRUB_TEST = 'cli/__tests__/vitest-setup-env-scrub.test.mts';
const SCRUB_INPUT_RE = /^cli\/lib\/ship\/[^/]+\.sh$|^vitest\.setup\.mjs$/;

/** The disk-reading tests a staged path selects, which `vitest related` would never run. */
export function forcedTests(staged: Iterable<string>): string[] {
  return [...staged].some((p) => SCRUB_INPUT_RE.test(p)) ? [SCRUB_TEST] : [];
}

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
    const forced = new Set(forcedTests(paths));
    const lines = unmapped.flatMap((p) => {
      const stem = basename(p, extname(p));
      const tests = [...(hits.get(basename(p)) ?? [])]
        .filter((t) => !forced.has(t))
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

type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; stdio: 'inherit' },
) => { status: number | null; error?: Error };

interface RunOpts {
  staged?: Iterable<string> | null;
  exec?: Exec;
}

/** Exit code of the related-tests run: 0 when nothing is selected, vitest's status otherwise. */
export function runRelatedTests(root: string, opts: RunOpts = {}): number {
  const staged = [...(('staged' in opts ? opts.staged : stagedSet(root)) ?? [])];
  const paths = relatedPaths(staged);
  // From the raw set: relatedPaths drops vitest.setup.mjs, which the env-scrub test binds.
  const forced = forcedTests(staged);
  if (!paths.length && !forced.length) {
    console.log('related-tests: none selected');
    return 0;
  }
  console.log(
    `related-tests: ${paths.length} staged path(s)${forced.length ? `, ${forced.length} forced` : ''}`,
  );
  const vitest = join(root, 'node_modules', '.bin', 'vitest');
  const args = [
    'related',
    '--run',
    '--reporter=dot',
    ...new Set([...paths, ...forced, REACH_TEST]),
  ];
  const result = (opts.exec ?? spawnSync)(vitest, args, { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(`✗ related-tests could not run vitest: ${result.error.message}`);
  // A null status is a signal kill or a failed spawn: nothing passed, so block.
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const code = runRelatedTests(process.cwd());
  noteUnmapped(process.cwd(), relatedPaths(stagedSet(process.cwd()) ?? []));
  process.exitCode = code;
}
