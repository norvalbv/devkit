#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseBaseline } from './adapters.mts';
import { backfill } from './backfill.mts';
import { baselinePublicationErrors, loadCatalog, validateCatalog } from './catalog.mts';
import type { LockedAppend } from './history.mts';
import {
  activeEvents,
  checkpointArtifact,
  HISTORY_PATH,
  immutableErrors,
  latestRecordedEvent,
  parseHistory,
  publicationErrors,
  reconcileHistory,
  sha256,
  validateHistory,
  withPublishLock,
  writeAtomically,
} from './history.mts';
import { generatedOutputs, writeGeneratedOutputs } from './render.mts';
import { gitOutput, repositorySource, suiteHashes } from './source.mts';
import type {
  Assessment,
  BenchmarkEvent,
  ChangeType,
  CheckpointEnvelope,
  ComparisonObservation,
  MetricObservation,
  TrackerMode,
} from './types.mts';
import { ASSESSMENTS, CHANGE_TYPES } from './types.mts';

const cwd = process.cwd();
const command = process.argv[2];
const argv = process.argv.slice(3);
const ALL_ZERO_RE = /^0+$/;

function options(args: string[]) {
  return parseArgs({
    args,
    options: {
      mode: { type: 'string' },
      tree: { type: 'string' },
      base: { type: 'string' },
      suite: { type: 'string' },
      baseline: { type: 'string' },
      'change-type': { type: 'string' },
      assessment: { type: 'string' },
      note: { type: 'string' },
      predecessor: { type: 'string' },
      supersedes: { type: 'string' },
      'recorded-at': { type: 'string' },
      since: { type: 'string' },
      'local-log': { type: 'string', multiple: true },
      output: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
}

function fail(errors: string[]): never {
  for (const error of errors) console.error(`benchmark-tracker: ${error}`);
  process.exit(1);
}

function trackerMode(values: ReturnType<typeof options>['values']): TrackerMode {
  const mode = (values.mode ?? (values.tree ? 'tree' : 'working')) as TrackerMode;
  if (!['working', 'staged', 'tree'].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  return mode;
}

function sourceFrom(values: ReturnType<typeof options>['values']) {
  return repositorySource(cwd, trackerMode(values), values.tree);
}

function checkSnapshot(parsed: ReturnType<typeof options>): {
  errors: string[];
  mode: TrackerMode;
  ref?: string;
} {
  const source = sourceFrom(parsed.values);
  const catalog = loadCatalog(source);
  const errors = [...validateCatalog(source, catalog), ...validateHistory(source)];
  const checkpointPaths = new Set(
    parseHistory(source).flatMap(({ event }) => (event.checkpoint ? [event.checkpoint.path] : [])),
  );
  for (const path of source
    .listFiles()
    .filter((path) => path.startsWith('docs/benchmarks/checkpoints/'))) {
    if (!checkpointPaths.has(path)) errors.push(`Orphan checkpoint artifact: ${path}`);
  }
  const events = parseHistory(source).map(({ event }) => event);
  errors.push(...baselinePublicationErrors(source, catalog, events));
  const baseRef = parsed.values.base;
  if (baseRef && !ALL_ZERO_RE.test(baseRef)) {
    errors.push(...immutableErrors(source, repositorySource(cwd, 'tree', baseRef)));
  }
  let outputs: Record<string, string> = {};
  try {
    outputs = generatedOutputs(
      source,
      catalog,
      parseHistory(source).map(({ event }) => event),
    );
  } catch (error) {
    errors.push((error as Error).message);
  }
  for (const [path, expected] of Object.entries(outputs)) {
    if (source.read(path) !== expected)
      errors.push(`Generated output is stale: ${path} (run bun run benchmarks:render)`);
  }
  return { errors, mode: source.mode, ...(source.ref ? { ref: source.ref } : {}) };
}

export function withCheckConsistency<T>(root: string, mode: TrackerMode, action: () => T): T {
  return mode === 'working' ? withPublishLock(root, () => action()) : action();
}

function check(args: string[]): void {
  const parsed = options(args);
  const result = withCheckConsistency(cwd, trackerMode(parsed.values), () => checkSnapshot(parsed));
  if (result.errors.length) fail(result.errors);
  console.log(`benchmark-tracker: PASS (${result.mode}${result.ref ? ` ${result.ref}` : ''})`);
}

export function metricAssessment(before: MetricObservation, after: MetricObservation): Assessment {
  const noise = after.noiseFloor ?? after.mde ?? 0;
  if (Math.abs(before.value - after.value) <= noise) return 'flat';
  if (after.direction === 'target') return 'unknown';
  const better =
    after.direction === 'higher' ? after.value > before.value : after.value < before.value;
  return better ? 'improved' : 'regressed';
}

export function aggregateMetricAssessment(metrics: MetricObservation[]): Assessment {
  const assessments = metrics
    .map((metric) => metric.assessment)
    .filter((assessment): assessment is Assessment =>
      Boolean(assessment && assessment !== 'unknown'),
    );
  if (assessments.length === 0) return 'unknown';
  const changed = new Set(assessments.filter((assessment) => assessment !== 'flat'));
  if (changed.size === 0) return 'flat';
  if (changed.size > 1) return 'mixed';
  return [...changed][0];
}

function rowFlipStats(
  predecessorCheckpoint: CheckpointEnvelope,
  rows: Record<string, unknown>,
): { shared: number; positive: number; negative: number } {
  let positive = 0;
  let negative = 0;
  let shared = 0;
  for (const [id, current] of Object.entries(rows)) {
    const prior = predecessorCheckpoint.rows[id];
    if (!prior || typeof prior !== 'object' || !current || typeof current !== 'object') continue;
    const beforeOk = (prior as { ok?: unknown }).ok;
    const afterOk = (current as { ok?: unknown }).ok;
    if (typeof beforeOk !== 'boolean' || typeof afterOk !== 'boolean') continue;
    shared += 1;
    if (!beforeOk && afterOk) positive += 1;
    if (beforeOk && !afterOk) negative += 1;
  }
  return { shared, positive, negative };
}

export function comparisons(
  predecessor: BenchmarkEvent | undefined,
  predecessorCheckpoint: CheckpointEnvelope | undefined,
  rows: Record<string, unknown>,
  changeType: ChangeType,
  assessment: Assessment,
): ComparisonObservation[] {
  if (!predecessor) return [];
  if (changeType === 'methodology-reset') {
    return [
      {
        predecessorEventId: predecessor.id,
        method: 'adapter comparability contract',
        verdict: 'not-comparable',
        note: 'Corpus or scoring contract changed',
      },
    ];
  }
  if (changeType === 'coverage') {
    if (!predecessorCheckpoint)
      return [
        {
          predecessorEventId: predecessor.id,
          method: 'unpaired coverage comparison',
          verdict: 'unknown',
          note: 'Coverage-only status requires a row-backed predecessor',
        },
      ];
    const { shared, positive, negative } = rowFlipStats(predecessorCheckpoint, rows);
    const coverageOnly = shared > 0 && positive === 0 && negative === 0;
    return [
      {
        predecessorEventId: predecessor.id,
        sharedRows: shared,
        positiveDiscordant: positive,
        negativeDiscordant: negative,
        method: 'shared-row outcome comparison',
        verdict: shared === 0 ? 'unknown' : coverageOnly ? 'coverage-only' : 'mixed',
        ...(shared === 0 ? { note: 'No shared row outcomes; quality is not comparable' } : {}),
      },
    ];
  }
  if (!predecessorCheckpoint) {
    return [
      {
        predecessorEventId: predecessor.id,
        method: 'legacy aggregate comparison',
        verdict: assessment,
      },
    ];
  }
  const { shared, positive, negative } = rowFlipStats(predecessorCheckpoint, rows);
  const flipAssessment: Assessment =
    positive > 0 && negative > 0
      ? 'mixed'
      : positive > 0
        ? 'improved'
        : negative > 0
          ? 'regressed'
          : shared > 0
            ? 'flat'
            : 'unknown';
  const verdict: Assessment =
    flipAssessment === 'unknown' || flipAssessment === 'flat'
      ? assessment
      : assessment === 'unknown' || assessment === 'flat' || assessment === flipAssessment
        ? flipAssessment
        : 'mixed';
  return [
    {
      predecessorEventId: predecessor.id,
      sharedRows: shared,
      positiveDiscordant: positive,
      negativeDiscordant: negative,
      method: 'shared-row outcome comparison combined with metric assessment',
      verdict,
    },
  ];
}

export function defaultPredecessor(
  history: BenchmarkEvent[],
  suiteId: string,
): BenchmarkEvent | undefined {
  return latestRecordedEvent(
    activeEvents(history).filter(
      (event) => event.suiteId === suiteId && event.evidence === 'accepted' && event.checkpoint,
    ),
  );
}

function readCheckpoint(
  source: ReturnType<typeof repositorySource>,
  event?: BenchmarkEvent,
): CheckpointEnvelope | undefined {
  if (!event?.checkpoint) return undefined;
  const raw = source.read(event.checkpoint.path);
  return raw ? (JSON.parse(raw) as CheckpointEnvelope) : undefined;
}

export function parsePublishBaseline(suiteId: string, adapter: string, raw: string) {
  let baseline: ReturnType<typeof parseBaseline>;
  try {
    baseline = parseBaseline(adapter, JSON.parse(raw));
  } catch (error) {
    throw new Error(`Adapter rejected ${suiteId}: ${(error as Error).message}`);
  }
  if (!baseline.acceptance.accepted)
    throw new Error(`Adapter rejected ${suiteId}: ${baseline.acceptance.reason}`);
  return baseline;
}

function publishLocked(args: string[], append: LockedAppend): void {
  const parsed = options(args);
  const suiteId = parsed.values.suite;
  if (!suiteId) throw new Error('publish requires --suite <id>');
  const tree = parsed.values.tree ?? 'HEAD';
  if (
    tree === 'WORKTREE' &&
    gitOutput(cwd, ['status', '--porcelain=v1', '--untracked-files=all']).trim()
  ) {
    throw new Error('WORKTREE publication requires a completely clean working tree');
  }
  const source = repositorySource(
    cwd,
    tree === 'WORKTREE' ? 'working' : 'tree',
    tree === 'WORKTREE' ? undefined : tree,
  );
  const working = repositorySource(cwd, 'working');
  const catalog = loadCatalog(working);
  const existingErrors = [...validateCatalog(working, catalog), ...validateHistory(working)];
  if (existingErrors.length)
    throw new Error(`Refusing to publish into an invalid tracker:\n${existingErrors.join('\n')}`);
  const suite = catalog.suites.find((candidate) => candidate.id === suiteId);
  if (!suite) throw new Error(`Unknown suite: ${suiteId}`);
  const baselinePath = parsed.values.baseline ?? suite.baseline;
  if (!baselinePath) throw new Error(`Suite ${suiteId} has no baseline path; pass --baseline`);
  const raw = source.read(baselinePath);
  if (!raw) throw new Error(`Missing baseline ${baselinePath} at ${tree}`);
  const baseline = parsePublishBaseline(suiteId, suite.adapter, raw);
  const requestedChangeType =
    parsed.values['change-type'] ?? (suite.lifecycle === 'no-ship' ? 'no-ship' : 'quality');
  if (!(CHANGE_TYPES as readonly string[]).includes(requestedChangeType))
    throw new Error(`Invalid change type: ${requestedChangeType}`);
  const changeType = requestedChangeType as ChangeType;
  const requestedAssessment = parsed.values.assessment;
  if (
    requestedAssessment !== undefined &&
    !(ASSESSMENTS as readonly string[]).includes(requestedAssessment)
  )
    throw new Error(`Invalid assessment: ${requestedAssessment}`);
  const history = parseHistory(working).map(({ event }) => event);
  const superseded = parsed.values.supersedes
    ? history.find((event) => event.id === parsed.values.supersedes)
    : undefined;
  if (parsed.values.supersedes && !superseded)
    throw new Error(`Unknown superseded event: ${parsed.values.supersedes}`);
  if (superseded && superseded.suiteId !== suiteId)
    throw new Error('A correction can only supersede an event from the same suite');
  const predecessor = parsed.values.predecessor
    ? activeEvents(history).find((event) => event.id === parsed.values.predecessor)
    : defaultPredecessor(history, suiteId);
  if (parsed.values.predecessor && !predecessor)
    throw new Error(`Unknown active predecessor event: ${parsed.values.predecessor}`);
  const predecessorCheckpoint = readCheckpoint(working, predecessor);
  const hashes = suiteHashes(source, suite.hashes);
  if (
    predecessor?.hashes &&
    changeType === 'quality' &&
    (predecessor.hashes.corpus !== hashes.corpus ||
      predecessor.hashes.scorer !== hashes.scorer ||
      predecessor.hashes.runner !== hashes.runner)
  ) {
    throw new Error(
      'Corpus, scorer, or runner changed; publish as methodology-reset or an adapter-approved non-quality change',
    );
  }
  if (predecessor && changeType === 'quality') {
    for (const metric of baseline.metrics) {
      const prior = predecessor.metrics.find((candidate) => candidate.id === metric.id);
      if (prior) metric.assessment = metricAssessment(prior, metric);
    }
  }
  let assessment: Assessment =
    changeType === 'quality' ? aggregateMetricAssessment(baseline.metrics) : 'unknown';
  const comparison = comparisons(
    predecessor,
    predecessorCheckpoint,
    baseline.rows,
    changeType,
    assessment,
  );
  if (changeType === 'coverage') {
    const verdict = comparison[0]?.verdict;
    assessment = verdict === 'coverage-only' ? 'flat' : verdict === 'mixed' ? 'mixed' : 'unknown';
  } else if (changeType === 'quality') {
    const verdict = comparison[0]?.verdict;
    if (verdict && ['improved', 'regressed', 'flat', 'mixed', 'unknown'].includes(verdict))
      assessment = verdict as Assessment;
  }
  if (requestedAssessment !== undefined && requestedAssessment !== assessment)
    throw new Error(
      `Assessment ${requestedAssessment} contradicts adapter-derived assessment ${assessment}`,
    );
  const sourceCommit =
    tree === 'WORKTREE'
      ? gitOutput(cwd, ['rev-parse', 'HEAD']).trim()
      : gitOutput(cwd, ['rev-parse', tree]).trim();
  const recordedAtInput =
    parsed.values['recorded-at'] ??
    gitOutput(cwd, ['show', '-s', '--format=%cI', sourceCommit]).trim();
  const recordedAt = new Date(recordedAtInput).toISOString();
  const envelope: CheckpointEnvelope = {
    schemaVersion: 1,
    suiteId,
    capturedAt: recordedAt,
    sourceCommit,
    adapter: suite.adapter,
    hashes,
    metrics: baseline.metrics,
    comparisons: comparison,
    rows: baseline.rows,
    acceptance: baseline.acceptance,
  };
  const checkpoint = checkpointArtifact(envelope);
  const idSeed = `${suiteId}\0${sourceCommit}\0${recordedAt}\0${checkpoint.sha256}`;
  const event: BenchmarkEvent = {
    schemaVersion: 1,
    id: `evt-${recordedAt.slice(0, 10)}-${suiteId}-${sha256(idSeed).slice(0, 12)}`,
    recordedAt,
    suiteId,
    subjectIds: suite.subjectIds,
    lifecycle: suite.lifecycle,
    evidence: 'accepted',
    freshness: 'current',
    changeType,
    assessment,
    provenance: { tier: 'accepted', source: 'committed sanitized checkpoint', sourceCommit },
    hashes: envelope.hashes,
    checkpoint: { sha256: checkpoint.sha256, path: checkpoint.path },
    metrics: baseline.metrics,
    comparisons: comparison,
    note: parsed.values.note ?? baseline.acceptance.reason,
    ...(superseded ? { supersedes: superseded.id } : {}),
  };
  const validation = publicationErrors(event, envelope);
  if (validation.length) throw new Error(validation.join('\n'));
  append(event, checkpoint);
  const refreshed = repositorySource(cwd, 'working');
  writeGeneratedOutputs(cwd, generatedOutputs(refreshed, catalog, [...history, event]));
  console.log(`benchmark-tracker: published ${event.id}`);
}

function publish(args: string[]): void {
  withPublishLock(cwd, (append) => publishLocked(args, append));
}

function renderLocked(): void {
  const source = repositorySource(cwd, 'working');
  const catalog = loadCatalog(source);
  const events = parseHistory(source).map(({ event }) => event);
  writeGeneratedOutputs(cwd, generatedOutputs(source, catalog, events));
  console.log('benchmark-tracker: rendered README dashboards and SVGs');
}

function render(): void {
  withPublishLock(cwd, () => renderLocked());
}

export function reconcileLedgers(root: string, inputs: string[], output: string): void {
  const writeMerged = () => {
    const merged = reconcileHistory(
      inputs.map((path) => readFileSync(resolve(root, path), 'utf8')),
    );
    writeAtomically(output, merged);
  };
  if (output === resolve(root, HISTORY_PATH)) withPublishLock(root, () => writeMerged());
  else writeMerged();
}

function reconcile(args: string[]): void {
  const parsed = options(args);
  if (parsed.positionals.length < 2)
    throw new Error('reconcile requires at least two ledger paths');
  const output = resolve(cwd, parsed.values.output ?? HISTORY_PATH);
  reconcileLedgers(cwd, parsed.positionals, output);
  console.log(`benchmark-tracker: reconciled ${parsed.positionals.length} ledgers`);
}

if (import.meta.main) {
  try {
    if (command === 'check') check(argv);
    else if (command === 'publish') publish(argv);
    else if (command === 'render') render();
    else if (command === 'backfill') {
      const parsed = options(argv);
      backfill(cwd, parsed.values.since, parsed.values['local-log']);
    } else if (command === 'reconcile') reconcile(argv);
    else throw new Error('Usage: cli.mts <publish|render|check|backfill|reconcile> [options]');
  } catch (error) {
    fail([(error as Error).message]);
  }
}
