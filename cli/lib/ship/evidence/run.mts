#!/usr/bin/env node

// Ship's evidence step, run by publish-evidence.sh after the PR exists. `budget` sizes the bound,
// `publish` writes the red/green block, `body` cleans a caller body and adds the UI task item.
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { RegressionEvidence } from '../../baseline-status/regression-evidence.mts';
import { captureRegressionEvidence } from '../../baseline-status/regression-proof.mts';
import {
  type PreparedRegressionRepository,
  prepareRegressionRepository,
} from '../../baseline-status/regression-repository.mts';
import { UI_EVIDENCE } from '../../../../gate-engine/ui-evidence/check.mts';
import { textOf } from '../digest/fields.mts';
import { ATTEMPT, readShipEvents } from '../digest/gate-digest.mts';
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
import { publishEvidenceBlock, readPull } from './pr-body.mts';
import { buildRedCommit, classifyChange, prBase, treeOf } from './red-ref.mts';
import { withUiItem } from './ui-item.mts';

const REPORT = '.devkit-evidence-report.json';

interface Produced {
  outcome: EvidenceOutcome;
  evidence: RegressionEvidence | null;
}

/** The capture's own SIGTERM path stops the test tree and removes both clones at the deadline. */
async function captureWithin(
  prepared: PreparedRegressionRepository,
  seconds: number,
): Promise<RegressionEvidence> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.kill(process.pid, 'SIGTERM');
  }, seconds * 1000);
  try {
    return (await captureRegressionEvidence(prepared)).evidence;
  } catch (error) {
    throw timedOut ? new Error(`the tests did not finish within ${seconds}s`) : error;
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
  const abstain = (reason: 'docs-only' | 'no-test-change', detail: string): Produced => ({
    outcome: notRun(reason, detail, head, base),
    evidence: null,
  });
  if (change.docsOnly) return abstain('docs-only', 'the PR changes only Markdown');
  if (change.tests.length === 0) return abstain('no-test-change', 'the PR adds or changes no test');
  const red = buildRedCommit(cwd, base, change.overlay);
  if (treeOf(cwd, red) === treeOf(cwd, head)) {
    const detail = 'the PR changes only test and support files, so red and green are one tree';
    return { outcome: inconclusive(detail, head, base), evidence: null };
  }
  // Ship's own run env (mode, slot, telemetry sink) must not reach the consumer's test suite.
  for (const key of Object.keys(process.env))
    if (key.startsWith('DEVKIT_')) delete process.env[key];
  const argv = expandCommand(config.command, change.tests, REPORT);
  console.error(
    `evidence: running ${change.tests.length} test file(s) on red and green (at most ${config.timeoutSeconds}s)`,
  );
  const prepared = prepareRegressionRepository(
    ['--red', red, '--green', head, '--vitest-report', REPORT, '--', ...argv],
    cwd,
  );
  const evidence = await captureWithin(prepared, config.timeoutSeconds);
  return { outcome: outcomeFromRegression(evidence, head, base), evidence };
}

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

async function publish({ cwd, repo, pr, head, failed }: PublishArgs): Promise<void> {
  const pull = readPull(repo, pr);
  if (pull.headRefOid !== head) {
    console.error(`evidence: PR head is no longer ${head.slice(0, 12)}; nothing was published`);
    return;
  }
  if (readEvidenceBlock(pull.body, head)?.stale === false) {
    console.error('evidence: the PR body already records evidence for this head');
    return;
  }
  const config = readEvidenceConfig(cwd);
  if (!config) return;
  const env = { ...process.env };
  let produced: Produced = { outcome: inconclusive(failed ?? '', head, null), evidence: null };
  if (!failed) {
    try {
      produced = await produce(cwd, head, pull.baseRefOid, config);
    } catch (error) {
      const detail = `evidence could not be produced: ${errorMessage(error)}`;
      produced = { outcome: inconclusive(detail, head, null), evidence: null };
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
}

/** This ship attempt's screenshot reminder, read from its own gate events; null when it was quiet. */
function uiEvidenceDetail(env: NodeJS.ProcessEnv): string | null {
  const events = readShipEvents(env.DEVKIT_GATE_EVENTS ?? '', env.DEVKIT_SHIP_ID ?? '');
  // One ship id can span attempts: only rows after the newest marker are this run's. With no
  // marker the rows cannot be attributed, and a reminder that cannot tell stays quiet.
  const opened = events.map((e) => e.type).lastIndexOf(ATTEMPT);
  const mine = opened < 0 ? [] : events.slice(opened);
  const rows = mine.filter((e) => e.type === 'advisory_result' && e.gate === UI_EVIDENCE);
  // A sink row is arbitrary JSON, so a non-string detail reads as no reminder instead of throwing.
  return textOf(rows[rows.length - 1]?.detail) || null;
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
  } as const;
  const { values } = parseArgs({ args: rest, options, strict: true });
  if (command === 'body') {
    const caller = readFileSync(0, 'utf8');
    let current = '';
    try {
      if (values.pr) current = readPull(required(values, 'repo'), values.pr).body;
    } catch (error) {
      console.error(
        `evidence: the current PR body was not read, so its block is not carried: ${errorMessage(error)}`,
      );
    }
    const body = carryEvidenceBlock(caller, current);
    process.stdout.write(withUiItem(body, current, uiEvidenceDetail(process.env)));
    return;
  }
  if (command !== 'publish') throw new Error('usage: run.mts budget <dir> | publish … | body …');
  await publish({
    cwd: required(values, 'cwd'),
    repo: required(values, 'repo'),
    pr: required(values, 'pr'),
    head: required(values, 'head'),
    failed: values.failed,
  });
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
