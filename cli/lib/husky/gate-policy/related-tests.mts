/**
 * Self-host `related-tests` extra gate: runs the tests vitest's import graph relates to the
 * commit's staged paths (its argv, from extraGates' `{staged}`), so a broken test blocks early.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { runVitestDetailed, type VitestRun } from '../../../../gate-engine/coverage/vitest-cli.mts';
import {
  displayPath,
  readDiagnosis,
  RESULTS_NAME,
  type RunDiagnosis,
  UNHANDLED_REPORTER,
} from '../../../../gate-engine/coverage/failures.mts';
import { gateTimeoutMs } from '../../../../gate-engine/deterministic/command-gates.mts';
import {
  GATE_LABEL_ENV,
  GATE_REASON_ENV,
  writeGateReason,
} from '../../../../gate-engine/deterministic/reason.mts';
import { emitGateEvent } from '../../../../gate-engine/judge/gate-events.mts';
import { commitIndexEnv } from '../../../../gate-engine/ratchets/commit-index.mts';
import { type Comparison, label, renderComparison } from '../../baseline-status/compare.mts';
import {
  assertVitestReport,
  escapesRoot,
  SUMMARY_NAME,
  summarise,
} from '../../baseline-status/produce.mts';
import { type BaselineAnswer, resolveRef } from '../../baseline-status/query.mts';

// Runs with every selection: it fails when a module is left unreachable to `vitest related` itself.
const REACH_TEST = 'cli/__tests__/test-graph-reach.test.mts';

// The env-scrub test reads these from disk, so no import edge selects it. The ship-script pattern
// mirrors that test's own top-level scan of cli/lib/ship.
const SCRUB_TEST = 'cli/__tests__/vitest-setup-env-scrub.test.mts';
const SCRUB_INPUT_RE =
  /^cli\/lib\/ship\/[^/]+\.sh$|^vitest\.setup\.mjs$|^vitest(\.e2e)?\.config\.mjs$/;
// The agent-asset parity test reads hook sources, their projections and the selection from disk.
const PARITY_TEST = 'cli/__tests__/agent-asset-projection-parity.test.mts';
const PARITY_INPUT_RE =
  /^agents-hooks\/|^\.(claude|codex|cursor)\/hooks\/|^\.devkit\/config\.json$/;

const FORCED: readonly (readonly [RegExp, string])[] = [
  [SCRUB_INPUT_RE, SCRUB_TEST],
  [PARITY_INPUT_RE, PARITY_TEST],
];

/** The disk-reading tests a staged path selects, which `vitest related` would never run. */
export function forcedTests(staged: Iterable<string>): string[] {
  const paths = [...staged];
  return FORCED.filter(([re]) => paths.some((p) => re.test(p))).map(([, test]) => test);
}
import { errorMessage } from '../../ship/review/shared/common.mts';

// vitest's forceRerunTriggers (**/package.json, **/{vitest,vite}.config.*, setupFiles) select the
// whole suite, which CI already runs.
const RERUN_TRIGGER_RE = /(^|\/)(package\.json|(vitest|vite)\.config\.[^/]*)$|^vitest\.setup\.mjs$/;

/** Failing tests named in the reason; the rest stay in vitest's own output above it. */
const NAMED_TESTS = 5;

/** The staged paths the related-test listing starts from, sorted, minus the full-suite triggers. */
export function relatedPaths(staged: Iterable<string>): string[] {
  return [...staged].filter((p) => !RERUN_TRIGGER_RE.test(p)).sort();
}

// Source modules whose reachability the reach test guards.
const SOURCE_RE = /\.[cm]?[jt]sx?$/;

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

interface SpawnResult {
  status: number | null;
  error?: Error;
}

type Exec = (
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) => Promise<VitestRun>;

interface CiAttribution {
  answer: BaselineAnswer;
  comparison: Comparison;
}

type Attribute = (
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  ms: number,
) => Promise<CiAttribution | null>;

interface RunOpts {
  staged: Iterable<string>;
  exec?: Exec;
  list?: typeof listRelated;
  attribute?: Attribute;
}

/** The test files `vitest related` would select, resolved in-process so no queued vitest CLI starts. */
export async function listRelated(root: string, paths: string[]): Promise<string[]> {
  const { createVitest } = await import('vitest/node');
  const related = paths.map((p) => join(root, p));
  const ctx = await createVitest({ root, related, watch: false, run: true });
  try {
    const specs = await ctx.getRelevantTestSpecifications();
    return [...new Set(specs.map((s) => s.moduleId))].sort();
  } finally {
    await ctx.close();
  }
}

/** Why a failed run blocked: the failing tests by file and title, or why vitest never reported. */
export function relatedTestsReason(
  result: SpawnResult,
  diagnosis: RunDiagnosis | null,
  root: string,
): string[] {
  if (result.error || result.status === null) {
    const why = result.error?.message ?? 'it was killed before exiting';
    return [`related-tests could not run vitest: ${why}`];
  }
  if (!diagnosis) {
    return [
      `vitest exited ${result.status} without a test report — its output is in the full log above`,
    ];
  }
  if (diagnosis.unhandled) {
    return [
      'No test failed; the run ended on:',
      ...diagnosis.unhandled.map((e) =>
        e.file ? `${displayPath(e.file, root)}: ${e.message}` : e.message,
      ),
    ];
  }
  const named = [
    ...(diagnosis.failures?.tests ?? []).map((t) => `${displayPath(t.file, root)} > ${t.name}`),
    ...(diagnosis.collection ?? []).map(
      (c) => `${displayPath(c.file, root)} — failed to load: ${c.message.split('\n')[0]}`,
    ),
  ];
  const hidden = named.length - NAMED_TESTS;
  return [
    `${diagnosis.failedFiles.length} test file(s) failed:`,
    ...named.slice(0, NAMED_TESTS),
    ...(hidden > 0 ? [`(${hidden} more in the full log above)`] : []),
  ];
}

/** A private directory for vitest's json report; '' when none can be made, and the run goes unnarrated. */
function reportDir(): string {
  try {
    return mkdtempSync(join(tmpdir(), 'devkit-related-tests-'));
  } catch {
    return '';
  }
}

/** One budget for the CI lookup; past it the reason stays as the run left it. */
const CI_ATTRIBUTION_MS = 25_000;
/** Kept back from the gate runner's deadline, which replaces any reason with a timeout block. */
const CI_MARGIN_MS = 5_000;
/** Inherited failures named in the reason; the full comparison is in the log above it. */
const NAMED_INHERITED = 3;
/** Bound on the merge-base call, which runs inside the same gate deadline as the lookup. */
const GIT_MS = 5_000;

/** The lookup's budget: CI_ATTRIBUTION_MS, or less when the gate's own deadline is near. */
function ciBudget(root: string): number {
  const left = gateTimeoutMs(root) - process.uptime() * 1000 - CI_MARGIN_MS;
  return Math.min(CI_ATTRIBUTION_MS, Math.floor(left));
}

/** Where HEAD left the default branch, the commit CI is asked about; '' when git cannot say. */
export function ciBase(root: string): string {
  const ref = `origin/${resolveRef(root)}`;
  const opts = { cwd: root, encoding: 'utf8' as const, timeout: GIT_MS };
  const r = spawnSync('git', ['merge-base', 'HEAD', ref], opts);
  return r.status === 0 ? r.stdout.trim() : '';
}

/** The comparison `baseline-status --json` printed, or null on any exit but 0, other output, or the deadline. */
export function attributeToCi(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  ms = CI_ATTRIBUTION_MS,
): Promise<CiAttribution | null> {
  return new Promise((done) => {
    const [bin = '', ...args] = argv;
    // In the gate's own group, so a kill of this gate ends it too; its gh calls never hold our pipe.
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      done(null);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        const answer = JSON.parse(out);
        done(code === 0 && answer?.comparison ? { answer, comparison: answer.comparison } : null);
      } catch {
        done(null);
      }
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(null);
    }, ms);
  });
}

/** The reason lines a CI comparison adds: facts about the answering run, never a guess at blame. */
export function ciLines({ answer, comparison: c }: CiAttribution): string[] {
  const sha = answer.sha?.slice(0, 8) ?? 'unknown';
  const behind = answer.commitsBehindHead
    ? `, ${answer.commitsBehindHead} commit(s) before the base`
    : '';
  const hidden = c.inherited.length - NAMED_INHERITED;
  // A name list missing or cut short leaves some failures compared by file, so the counts are partial.
  const partial = c.namesKnown ? '' : ' (partial: some compared by file only)';
  return [
    `CI at ${sha} (${answer.ref}, run ${answer.runId}${behind}): ${c.inherited.length} inherited, ${c.fresh.length} new${partial}`,
    ...c.inherited.slice(0, NAMED_INHERITED).map((e) => `inherited · ${label(e)}`),
    ...(hidden > 0 ? [`(+${hidden} more inherited in the log above)`] : []),
    ...(c.fresh.length || !c.namesKnown
      ? ['to run this change in CI instead of on this machine: devkit ci-probe']
      : []),
  ];
}

/** Compare the run's failures with CI's run at the base; no lines when CI cannot answer. */
async function ciAttribution(
  report: string,
  root: string,
  env: NodeJS.ProcessEnv,
  attribute: Attribute,
): Promise<string[]> {
  try {
    const base = ciBudget(root) > 0 ? ciBase(root) : '';
    if (!base) return [];
    const dir = dirname(report);
    const summary = join(dir, SUMMARY_NAME);
    const run = assertVitestReport(JSON.parse(readFileSync(report, 'utf8')));
    writeFileSync(summary, JSON.stringify(summarise(run, root)));
    // Re-read after preparing the summary: one deadline covers the whole step.
    const ms = ciBudget(root);
    if (ms <= 0) return [];
    const cli = join(root, 'cli', 'index.mts');
    const argv = [process.execPath, cli, 'baseline-status', '--at', base, '--against', summary];
    // gh downloads land in the report dir, which runRelatedTests removes even after a kill.
    const found = await attribute([...argv, '--json'], root, { ...env, TMPDIR: dir }, ms);
    const c = found?.comparison;
    if (!found || !c || c.fresh.length + c.inherited.length === 0) return [];
    console.log(renderComparison(found.comparison, found.answer).join('\n'));
    return ciLines(found);
  } catch {
    return [];
  }
}

/** One failed vitest assertion; its ` > ` joined name is what `vitest -t` matches. */
const failedTestSchema = z.object({
  ancestorTitles: z.array(z.string()),
  title: z.string(),
  status: z.literal('failed'),
  duration: z.number().catch(0),
});
/** Each assertion of one file: a failed one parsed, anything else (passed, malformed) null. */
const failedListSchema = z.array(failedTestSchema.nullable().catch(null)).catch([]);
const statusListSchema = z.array(z.object({ status: z.string() }).nullable().catch(null)).catch([]);
/** Bounds on a base rerun: base attribution's whole budget is 120 s, its worktree included. */
const RERUN_TESTS = 20;
const RERUN_MS = 60_000;
const RERUN_BYTES = 2048;

/** The failing tests base attribution may rerun at the cut commit; none when they cannot fit, or
 * when a failing file did not load, since no test name could show that failure as new. */
export function baseRerunTests(report: string, root: string): { file: string; name: string }[] {
  const run = JSON.parse(readFileSync(report, 'utf8'));
  const tests: { file: string; name: string }[] = [];
  let ms = 0;
  for (const result of run.testResults ?? []) {
    const file = relative(root, String(result?.name ?? ''));
    const failed = failedListSchema.parse(result?.assertionResults).flatMap((t) => (t ? [t] : []));
    const claimed = statusListSchema.parse(result?.assertionResults);
    // A failed entry too malformed to name is as unnameable as a file that did not load.
    if (claimed.filter((a) => a?.status === 'failed').length !== failed.length) return [];
    if (result?.status === 'failed' && failed.length === 0) return [];
    if (failed.length && (isAbsolute(file) || escapesRoot(file))) return [];
    for (const t of failed) {
      tests.push({ file, name: [...t.ancestorTitles, t.title].join(' > ') });
      ms += t.duration;
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(tests));
  const fits = tests.length <= RERUN_TESTS && ms <= RERUN_MS && bytes <= RERUN_BYTES;
  return fits ? tests : [];
}

/** Publish the failing tests for base attribution, which only a blocked ship runs. */
function publishBaseRerun(report: string, root: string): void {
  const gate = process.env[GATE_LABEL_ENV];
  if (!gate || !process.env.DEVKIT_SHIP_ID) return;
  let tests: { file: string; name: string }[] = [];
  try {
    tests = baseRerunTests(report, root);
  } catch {
    // An unreadable report publishes the empty list below; the CI step after this still runs.
  }
  // Published even when empty, so an earlier run's tests are never read for this one.
  emitGateEvent({ type: 'gate_base_rerun', gate, tests });
}

/** Record the failure reason. Narration only: nothing here may throw into the verdict. */
async function narrate(
  result: SpawnResult,
  report: string,
  root: string,
  env: NodeJS.ProcessEnv,
  attribute: Attribute,
): Promise<void> {
  try {
    const diagnosis = report ? readDiagnosis(report, result.status ?? 1) : null;
    // Written before the optional CI step, which can only append lines.
    writeGateReason(relatedTestsReason(result, diagnosis, root));
    // A killed run reached no verdict, so there is nothing to compare and no time to spend.
    if (result.status !== null && diagnosis?.failedFiles.length && !diagnosis.unhandled) {
      publishBaseRerun(report, root);
      writeGateReason(await ciAttribution(report, root, env, attribute));
    }
  } catch {
    // The exit code already carries the verdict.
  }
}

// Grouped, so a signal to this gate also ends vitest's fork workers rather than orphaning them.
const runGrouped: Exec = (bin, args, cwd, env) =>
  runVitestDetailed(bin, args, cwd, env, { group: true });

/** The related-tests run: code 0 when nothing is selected, vitest's outcome otherwise. */
export async function runRelatedTests(root: string, opts: RunOpts): Promise<VitestRun> {
  const staged = [...opts.staged];
  const paths = relatedPaths(staged);
  // From the raw set: relatedPaths drops vitest.setup.mjs, which the env-scrub test binds.
  const forced = forcedTests(staged);
  if (!paths.length && !forced.length) {
    console.log('related-tests: none selected');
    return { code: 0, interrupted: false };
  }
  let files: string[] = [];
  try {
    if (paths.length) files = await (opts.list ?? listRelated)(root, paths);
  } catch (err) {
    console.error(`✗ related-tests could not list related tests: ${errorMessage(err)}`);
    return { code: 1, interrupted: false };
  }
  // The reach test only answers for source modules, so a config-only commit skips the queue.
  if (!files.length && !forced.length && !paths.some((p) => SOURCE_RE.test(p))) {
    console.log(`related-tests: no test relates to the ${paths.length} staged path(s)`);
    return { code: 0, interrupted: false };
  }
  // listRelated returns absolute paths, so absolutise the rest for the set to dedupe.
  const tests = [...new Set([...files, ...[...forced, REACH_TEST].map((t) => join(root, t))])];
  console.log(
    `related-tests: ${tests.length} test file(s) for ${paths.length} staged path(s)${forced.length ? `, ${forced.length} forced` : ''}`,
  );
  const vitest = join(root, 'node_modules', '.bin', 'vitest');
  const dir = reportDir();
  const report = dir && join(dir, RESULTS_NAME);
  const reporters = report
    ? ['--reporter=json', `--outputFile.json=${report}`, `--reporter=${UNHANDLED_REPORTER}`]
    : [];
  // A passing ship or reviewer test's console output would echo the ship's own progress lines.
  const args = ['run', '--reporter=dot', '--silent=passed-only', ...reporters, ...tests];
  // A test that drives gate code must not write into this gate's reason file or publish as this gate.
  const env = { ...process.env };
  delete env[GATE_REASON_ENV];
  delete env[GATE_LABEL_ENV];
  try {
    const run = await (opts.exec ?? runGrouped)(vitest, args, root, env);
    // A signalled gate blocks, even when vitest still exits 0 after the forwarded signal.
    const code = run.interrupted && run.code === 0 ? 1 : run.code;
    // A null status reads as "killed before exiting" in the reason.
    if (code !== 0) {
      const status = run.interrupted ? null : code;
      await narrate({ status }, report, root, env, opts.attribute ?? attributeToCi);
    }
    return { ...run, code };
  } finally {
    try {
      if (dir) rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp dir never outranks the verdict.
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const staged = process.argv.slice(2);
  // devkit never spawns a `{staged}` gate with nothing staged, so no paths means a dropped token.
  if (!staged.length) {
    console.error(
      '✗ related-tests got no paths: run it as an extraGates command ending in {staged}',
    );
    process.exitCode = 1;
  } else {
    const run = await runRelatedTests(process.cwd(), { staged });
    // The raw set, not relatedPaths: a staged vitest.setup.mjs must still mark its forced test as run.
    if (!run.interrupted) noteUnmapped(process.cwd(), staged);
    process.exitCode = run.code;
  }
}
