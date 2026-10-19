#!/usr/bin/env node

// Ship's evidence step, run by publish-evidence.sh after the PR exists. `budget` sizes the bound,
// `publish` captures red/green and writes the block, `body` cleans a caller body before gh sees it.
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { emitGateEvent } from '../../../../gate-engine/judge/gate-events.mts';
import { clip } from '../../../../gate-engine/judge/odb-probe.mts';
import type { RegressionEvidence } from '../../baseline-status/regression-evidence.mts';
import { captureRegressionEvidence } from '../../baseline-status/regression-proof.mts';
import {
  type PreparedRegressionRepository,
  prepareRegressionRepository,
} from '../../baseline-status/regression-repository.mts';
import { errorMessage } from '../review/shared/common.mts';
import type { VerdictInput } from '../merge-verdict/ship-change.mts';
import {
  carryEvidenceBlock,
  type PrintedVerdict,
  readEvidenceBlock,
  renderEvidenceBlock,
  verdictUnavailable,
} from './block.mts';
import { type EvidenceConfig, expandCommand, readEvidenceConfig } from './config.mts';
import { type EvidenceOutcome, inconclusive, notRun, outcomeFromRegression } from './outcome.mts';
import { type PublishResult, publishEvidenceBlock, readPull } from './pr-body.mts';
import { buildRedCommit, classifyChange, prBase, treeOf } from './red-ref.mts';

const REPORT = '.devkit-evidence-report.json';

interface Produced {
  outcome: EvidenceOutcome;
  evidence: RegressionEvidence | null;
  /** Changed test files; null when the change was never classified. */
  tests: number | null;
}

/** What one completed publish run did, for its `ship_evidence` row. A null outcome produced none. */
export interface Published {
  outcome: EvidenceOutcome | null;
  tests: number | null;
  publish: PublishResult;
  verdict: string | null;
}

interface RunContext {
  pr: string;
  head: string;
  startedMs: number;
  failed: boolean;
}

const NO_OUTCOME = { status: null, reason: null, detail: null };

/** One row per completed run; a run without a ship id (by hand, or a test) records nothing. */
export function recordEvidenceEvent(published: Published, run: RunContext, now = Date.now()) {
  if (!process.env.DEVKIT_SHIP_ID) return;
  const { status, reason, detail } = published.outcome ?? NO_OUTCOME;
  emitGateEvent({
    type: 'ship_evidence',
    // Every caller passes a numeric PR; anything else serializes as null.
    pr_number: Number(run.pr),
    head: run.head,
    status,
    reason,
    detail: detail && clip(detail),
    test_files: published.tests,
    publish: published.publish,
    verdict: published.verdict,
    failed: run.failed,
    duration_s: Math.max(0, Math.round((now - run.startedMs) / 1000)),
  });
}

export interface PhaseMark {
  name: string;
  at: number;
}

/** `setup 6s, red 212s`: each phase runs until the next one starts, the last until `now`. */
export function phaseTimes(marks: readonly PhaseMark[], now: number): string {
  return marks
    .map(({ name, at }, index) => {
      const end = marks[index + 1]?.at ?? now;
      return `${name} ${Math.round((end - at) / 1000)}s`;
    })
    .join(', ');
}

/** The capture's own SIGTERM path stops the test tree and removes both clones at the deadline. */
async function captureWithin(
  prepared: PreparedRegressionRepository,
  seconds: number,
): Promise<{ evidence: RegressionEvidence; timing: string }> {
  // Monotonic, like the timer itself, so a wall-clock step cannot skew a phase or make it negative.
  const marks: PhaseMark[] = [{ name: 'setup', at: performance.now() }];
  let stalled: string | null = null;
  const timer = setTimeout(() => {
    stalled = `${phaseTimes(marks, performance.now())} unfinished`;
    process.kill(process.pid, 'SIGTERM');
  }, seconds * 1000);
  try {
    const { evidence } = await captureRegressionEvidence(prepared, (name) =>
      marks.push({ name, at: performance.now() }),
    );
    return { evidence, timing: phaseTimes(marks, performance.now()) };
  } catch (error) {
    throw stalled ? new Error(`the tests did not finish within ${seconds}s (${stalled})`) : error;
  } finally {
    clearTimeout(timer);
  }
}

async function produce(
  cwd: string,
  head: string,
  baseRefOid: string,
  config: EvidenceConfig,
): Promise<Produced> {
  const base = prBase(cwd, baseRefOid, head);
  const change = classifyChange(cwd, base, head, config.supportPaths);
  const tests = change.tests.length;
  const abstain = (reason: 'docs-only' | 'no-test-change', detail: string): Produced => ({
    outcome: notRun(reason, detail, head, base),
    evidence: null,
    tests,
  });
  if (change.docsOnly) return abstain('docs-only', 'the PR changes only Markdown');
  if (tests === 0) return abstain('no-test-change', 'the PR adds or changes no test');
  const red = buildRedCommit(cwd, base, change.overlay);
  if (treeOf(cwd, red) === treeOf(cwd, head)) {
    const detail = 'the PR changes only test and support files, so red and green are one tree';
    return { outcome: inconclusive(detail, head, base), evidence: null, tests };
  }
  // Ship's own run env (mode, slot, telemetry sink) must not reach the consumer's test suite; it
  // comes back afterwards so this run's telemetry row still names the ship.
  const shipEnv = Object.entries(process.env).filter(([key]) => key.startsWith('DEVKIT_'));
  for (const [key] of shipEnv) delete process.env[key];
  try {
    const argv = expandCommand(config.command, change.tests, REPORT);
    console.error(
      `evidence: running ${tests} test file(s) on red and green (at most ${config.timeoutSeconds}s)`,
    );
    const prepared = prepareRegressionRepository(
      ['--red', red, '--green', head, '--vitest-report', REPORT, '--', ...argv],
      cwd,
    );
    const { evidence, timing } = await captureWithin(prepared, config.timeoutSeconds);
    const outcome = outcomeFromRegression(evidence, head, base);
    return { outcome: { ...outcome, detail: `${outcome.detail} (${timing})` }, evidence, tests };
  } catch (error) {
    return { ...notProduced(errorMessage(error), head), tests };
  } finally {
    Object.assign(process.env, Object.fromEntries(shipEnv));
  }
}

const notProduced = (why: string, head: string): Produced => ({
  outcome: inconclusive(`evidence could not be produced: ${why}`, head, null),
  evidence: null,
  tests: null,
});

/** Loaded only once a block is being written, so a ship that writes none never pays for it. */
async function shipVerdict(input: VerdictInput): Promise<PrintedVerdict> {
  try {
    const { printVerdict } = await import('../merge-verdict/ship-change.mts');
    return printVerdict(input);
  } catch (error) {
    return verdictUnavailable(errorMessage(error));
  }
}

interface PublishArgs {
  cwd: string;
  repo: string;
  pr: string;
  head: string;
  failed: string | undefined;
}

async function publish({ cwd, repo, pr, head, failed }: PublishArgs): Promise<Published | null> {
  const nothing = { outcome: null, tests: null, verdict: null };
  const pull = readPull(repo, pr);
  if (pull.headRefOid !== head) {
    console.error(`evidence: PR head is no longer ${head.slice(0, 12)}; nothing was published`);
    return { ...nothing, publish: 'head-moved' };
  }
  const current = readEvidenceBlock(pull.body, head);
  if (current?.stale === false) {
    console.error('evidence: the PR body already records evidence for this head');
    const verdict = current.mergeVerdict?.verdict ?? null;
    return { ...nothing, outcome: current, verdict, publish: 'unchanged' };
  }
  const config = readEvidenceConfig(cwd);
  if (!config) return null;
  const env = { ...process.env };
  let produced: Produced = {
    outcome: inconclusive(failed ?? '', head, null),
    evidence: null,
    tests: null,
  };
  if (!failed) {
    try {
      produced = await produce(cwd, head, pull.baseRefOid, config);
    } catch (error) {
      produced = notProduced(errorMessage(error), head);
    }
  }
  const { title, baseRefOid } = pull;
  const verdict = await shipVerdict({
    cwd,
    head,
    baseRefOid,
    title,
    outcome: produced.outcome,
    env,
  });
  const block = renderEvidenceBlock(produced.outcome, produced.evidence, verdict);
  const result = publishEvidenceBlock(repo, pr, head, block);
  const { status, reason, detail } = produced.outcome;
  console.error(
    `evidence: ${status}${reason ? ` (${reason})` : ''}: ${detail} [PR body ${result}]`,
  );
  const { outcome, tests } = produced;
  return { outcome, tests, publish: result, verdict: verdict.verdict?.verdict ?? null };
}

function required(values: Record<string, string | undefined>, name: string): string {
  const value = values[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === 'budget') {
    process.stdout.write(`${readEvidenceConfig(rest[0] ?? '.')?.timeoutSeconds ?? 0}\n`);
    return;
  }
  const options = {
    cwd: { type: 'string' },
    repo: { type: 'string' },
    pr: { type: 'string' },
    head: { type: 'string' },
    failed: { type: 'string' },
    started: { type: 'string' },
  } as const;
  const { values } = parseArgs({ args: rest, options, strict: true });
  if (command === 'body') {
    const caller = readFileSync(0, 'utf8');
    const current = values.pr ? readPull(required(values, 'repo'), values.pr).body : '';
    process.stdout.write(carryEvidenceBlock(caller, current));
    return;
  }
  if (command !== 'publish') throw new Error('usage: run.mts budget <dir> | publish … | body …');
  // The step's start, from the shell, so a fallback run after a killed one times the whole step.
  const started = Number(values.started) * 1000;
  const run = {
    pr: required(values, 'pr'),
    head: required(values, 'head'),
    startedMs: Number.isFinite(started) && started > 0 ? started : Date.now(),
    failed: values.failed !== undefined,
  };
  const published = await publish({
    cwd: required(values, 'cwd'),
    repo: required(values, 'repo'),
    pr: run.pr,
    head: run.head,
    failed: values.failed,
  });
  // Last, never in a finally: a run that throws exits 1 and its --failed fallback writes the row.
  if (published) recordEvidenceEvent(published, run);
}

async function runCli(): Promise<void> {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`evidence: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void runCli();
}
