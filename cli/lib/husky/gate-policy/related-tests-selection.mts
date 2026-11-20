/**
 * What the related-tests gate prints about its selection before vitest starts: the staged paths that
 * pull in the most test files, the change against the previous attempt, and the slowest selected files.
 * After the run it names the staged paths no selected test covers.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { z } from 'zod';
import { emitGateEvent } from '../../../../gate-engine/judge/gate-events.mts';
import { telemetrySink } from '../../../../gate-engine/judge/run-context.mts';
import { commitIndexEnv } from '../../../../gate-engine/ratchets/commit-index.mts';
import { scanBackward } from '../../ship/digest/tail.mts';

const SELECTION_EVENT = 'related_tests_selection';
/** Slowest files a row keeps, and how many of them, and of the drivers, a line names. */
const KEPT_SLOWEST = 10;
const NAMED = 3;
/** Below this many selected files the drivers are not worth a second vitest graph walk. */
const DRIVER_MIN_FILES = 20;

const selectionSchema = z.object({
  type: z.literal(SELECTION_EVENT),
  repo: z.string(),
  branch: z.string(),
  files: z.number(),
  slowest: z.array(z.object({ file: z.string(), ms: z.number() })),
});
type Selection = z.infer<typeof selectionSchema>;

/** A sink line as this repo+branch's selection row, or undefined. */
function parseSelection(line: string, repo: string, branch: string): Selection | undefined {
  try {
    const row = selectionSchema.safeParse(JSON.parse(line));
    return row.success && row.data.repo === repo && row.data.branch === branch
      ? row.data
      : undefined;
  } catch {
    return undefined;
  }
}

// vitest's forceRerunTriggers (**/package.json, **/{vitest,vite}.config.*, setupFiles) select the
// whole suite, which CI already runs.
const RERUN_TRIGGER_RE = /(^|\/)(package\.json|(vitest|vite)\.config\.[^/]*)$|^vitest\.setup\.mjs$/;

/** The staged paths the related-test listing starts from, sorted, minus the full-suite triggers. */
export function relatedPaths(staged: Iterable<string>): string[] {
  return [...staged].filter((p) => !RERUN_TRIGGER_RE.test(p)).sort();
}

/** Names the staged full-suite triggers this gate leaves to CI; undefined when none is staged. */
export function triggerLine(staged: Iterable<string>): string | undefined {
  const triggers = [...staged].filter((p) => RERUN_TRIGGER_RE.test(p)).sort();
  if (!triggers.length) return undefined;
  const more = triggers.length > NAMED ? ` (+${triggers.length - NAMED})` : '';
  return `related-tests: ${triggers.length} staged full-suite trigger(s), so CI runs vitest's whole suite: ${triggers.slice(0, NAMED).join(', ')}${more}`;
}

/** The newest selection this ship's repo+branch recorded; undefined outside a ship or with none. */
export function previousSelection(env: NodeJS.ProcessEnv = process.env): Selection | undefined {
  const { DEVKIT_SHIP_REPO: repo, DEVKIT_SHIP_BRANCH: branch } = env;
  if (!repo || !branch) return undefined;
  const parse = (line: string) => parseSelection(line, repo, branch);
  return scanBackward(telemetrySink(env) ?? '', parse, (kept) => kept.length > 0).at(-1);
}

/** The briefed paths that select the most test files, from one vitest context; [] when not worth it. */
export async function relatedDrivers(root: string, paths: string[], selected: number) {
  if (paths.length < 2 || selected < DRIVER_MIN_FILES) return [];
  const { createVitest } = await import('vitest/node');
  const ctx = await createVitest({ root, related: paths.map((p) => join(root, p)), watch: false });
  try {
    const counts: [string, number][] = [];
    for (const path of paths) {
      ctx.config.related = [join(root, path)];
      const specs = await ctx.getRelevantTestSpecifications();
      counts.push([path, new Set(specs.map((s) => s.moduleId)).size]);
    }
    return counts.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  } finally {
    await ctx.close();
  }
}

/** The lines printed before vitest starts. `files` are the absolute selected test files. */
export function selectionLines(
  files: string[],
  root: string,
  drivers: [string, number][],
  previous: Selection | undefined,
): string[] {
  const lines: string[] = [];
  const named = drivers.slice(0, NAMED).map(([path, n]) => `${path} (${n})`);
  if (named.length) lines.push(`related-tests: most selected by ${named.join(', ')}`);
  if (previous && previous.files !== files.length) {
    lines.push(
      `related-tests: ${previous.files} test file(s) on the previous attempt of this branch`,
    );
  }
  const chosen = new Set(files.map((f) => relative(root, f)));
  const slow = (previous?.slowest ?? []).filter((s) => chosen.has(s.file)).slice(0, NAMED);
  if (slow.length) {
    const named = slow.map((s) => `${s.file} ${Math.round(s.ms / 1000)}s`);
    lines.push(`related-tests: slowest of these on the previous attempt: ${named.join(', ')}`);
  }
  return lines;
}

/** vitest's json report, reduced to each test file's wall time; a malformed entry is dropped. */
const reportTimesSchema = z.object({
  testResults: z
    .array(
      z
        .object({ name: z.string(), startTime: z.number(), endTime: z.number() })
        .nullable()
        .catch(null),
    )
    .catch([]),
});

/** Record this run's selection size and slowest files for the next attempt; only inside a ship. */
export function recordSelection(report: string, root: string, files: number): void {
  if (!process.env.DEVKIT_SHIP_ID) return;
  try {
    const run = reportTimesSchema.parse(JSON.parse(readFileSync(report, 'utf8')));
    const slowest = run.testResults
      .flatMap((r) => (r ? [{ file: relative(root, r.name), ms: r.endTime - r.startTime }] : []))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, KEPT_SLOWEST);
    emitGateEvent({ type: SELECTION_EVENT, files, slowest });
  } catch {
    // An unreadable report records nothing; the next attempt just prints no comparison.
  }
}

// The env-scrub test reads these from disk, so no import edge selects it. The ship-script pattern
// mirrors that test's own top-level scan of cli/lib/ship.
const SCRUB_TEST = 'cli/__tests__/vitest-setup-env-scrub.test.mts';
const SCRUB_INPUT_RE =
  /^cli\/lib\/ship\/[^/]+\.sh$|^vitest\.setup\.mjs$|^vitest(\.e2e)?\.config\.mjs$/;
// The agent-asset parity test reads agent and hook sources, their projections and the selection
// from disk. Skill projections are left to the skill-projection gate.
const PARITY_TEST = 'cli/__tests__/agent-asset-projection-parity.test.mts';
const PARITY_INPUT_RE =
  /^agents(-hooks)?\/|^\.(claude|codex|cursor)\/(hooks|agents)\/|^\.devkit\/(config|agents-manifest|agent-hooks-manifest)\.json$/;

const FORCED: readonly (readonly [RegExp, string])[] = [
  [SCRUB_INPUT_RE, SCRUB_TEST],
  [PARITY_INPUT_RE, PARITY_TEST],
];

/** The disk-reading tests a staged path selects, which `vitest related` would never run. */
export function forcedTests(staged: Iterable<string>): string[] {
  const paths = [...staged];
  return FORCED.filter(([re]) => paths.some((p) => re.test(p))).map(([, test]) => test);
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

/** Names each unmapped staged path and the tests that mention it, minus the repo-relative `ran`. */
export function noteUnmapped(
  root: string,
  paths: string[],
  ran: Iterable<string>,
  grep: Grep = gitGrepTests,
): void {
  try {
    const unmapped = unmappedPaths(paths);
    if (!unmapped.length) return;
    const hits = grep(root, [...new Set(unmapped.map((p) => basename(p)))]);
    const done = new Set(ran);
    const lines = unmapped.flatMap((p) => {
      const stem = basename(p, extname(p));
      const tests = [...(hits.get(basename(p)) ?? [])]
        .filter((t) => !done.has(t))
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
