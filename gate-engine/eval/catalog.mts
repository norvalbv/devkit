import { parseBaseline } from './adapters.mts';
import { activeEvents, canonicalJson, latestRecordedEvent } from './history.mts';
import type { RepositorySource } from './source.mts';
import type {
  BenchmarkCatalog,
  BenchmarkEvent,
  CheckpointEnvelope,
  MetricObservation,
} from './types.mts';
import { EVIDENCE_MODES, LIFECYCLES } from './types.mts';

const RUNNER_RE = /^gate-engine\/.+\/eval\/(?:.+\/)?(?:bench|eval)\.mts$/;
const AGENT_RE = /^agents\/[^/]+\.md$/;
const REVIEWER_BLOCK_RE = /export const REVIEWERS[\s\S]*?\n\]\);/;
const REVIEWER_NAME_RE = /\bname:\s*'([^']+)'/g;

export function loadCatalog(source: RepositorySource): BenchmarkCatalog {
  const raw = source.read('docs/benchmarks/catalog.json');
  if (!raw) throw new Error('Missing docs/benchmarks/catalog.json');
  let catalog: BenchmarkCatalog;
  try {
    catalog = JSON.parse(raw) as BenchmarkCatalog;
  } catch (error) {
    throw new Error(`Invalid benchmark catalog JSON: ${(error as Error).message}`);
  }
  if (
    catalog.schemaVersion !== 1 ||
    !Array.isArray(catalog.subjects) ||
    !Array.isArray(catalog.suites) ||
    !Array.isArray(catalog.singletonJudges) ||
    !Array.isArray(catalog.runnerExclusions)
  ) {
    throw new Error('Benchmark catalog must use schemaVersion 1 with subjects[] and suites[]');
  }
  return catalog;
}

export function baselinePublicationErrors(
  source: RepositorySource,
  catalog: BenchmarkCatalog,
  events: BenchmarkEvent[],
): string[] {
  const errors: string[] = [];
  const currentEvents = activeEvents(events);
  for (const suite of catalog.suites.filter((candidate) => candidate.baseline)) {
    const baselinePath = suite.baseline;
    if (!baselinePath) continue;
    const accepted = latestRecordedEvent(
      currentEvents.filter((event) => event.suiteId === suite.id && event.evidence === 'accepted'),
    );
    if (!accepted?.checkpoint) continue;
    const baselineRaw = source.read(baselinePath);
    const checkpointRaw = source.read(accepted.checkpoint.path);
    if (!baselineRaw || !checkpointRaw) continue;
    try {
      const baseline = parseBaseline(suite.adapter, JSON.parse(baselineRaw));
      const checkpoint = JSON.parse(checkpointRaw) as CheckpointEnvelope;
      const withoutAssessments = (metrics: MetricObservation[]) =>
        metrics.map((metric) => {
          const copy = { ...metric };
          delete copy.assessment;
          return copy;
        });
      const baselinePayload = canonicalJson({
        acceptance: baseline.acceptance,
        metrics: withoutAssessments(baseline.metrics),
        rows: baseline.rows,
      });
      const checkpointPayload = canonicalJson({
        acceptance: checkpoint.acceptance,
        metrics: withoutAssessments(checkpoint.metrics),
        rows: checkpoint.rows,
      });
      if (baselinePayload !== checkpointPayload)
        errors.push(`Accepted baseline changed without publication: ${baselinePath}`);
    } catch (error) {
      errors.push(`Cannot validate baseline ${baselinePath}: ${(error as Error).message}`);
    }
  }
  return errors;
}

function duplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  return values.find((value) => (seen.has(value) ? true : !seen.add(value)));
}

export function validateCatalog(source: RepositorySource, catalog: BenchmarkCatalog): string[] {
  const errors: string[] = [];
  const files = source.listFiles();
  for (const subject of catalog.subjects) {
    if (!subject.id || !subject.label) errors.push('Catalog subject is missing id or label');
    if (!['agent', 'bin', 'reviewer', 'judge', 'benchmark'].includes(subject.kind))
      errors.push(`Subject ${subject.id}: invalid kind`);
    if (!(LIFECYCLES as readonly string[]).includes(subject.lifecycle))
      errors.push(`Subject ${subject.id}: invalid lifecycle`);
    if (!(EVIDENCE_MODES as readonly string[]).includes(subject.evidence))
      errors.push(`Subject ${subject.id}: invalid evidence mode`);
    if (!Array.isArray(subject.suiteIds))
      errors.push(`Subject ${subject.id}: suiteIds must be an array`);
  }
  for (const suite of catalog.suites) {
    if (!suite.id || !suite.label || !suite.adapter)
      errors.push('Catalog suite is missing id, label, or adapter');
    if (!(LIFECYCLES as readonly string[]).includes(suite.lifecycle))
      errors.push(`Suite ${suite.id}: invalid lifecycle`);
    if (!Array.isArray(suite.subjectIds))
      errors.push(`Suite ${suite.id}: subjectIds must be an array`);
    if (
      !suite.hashes ||
      !['implementation', 'corpus', 'scorer', 'runner'].every((key) =>
        Array.isArray(suite.hashes[key as keyof typeof suite.hashes]),
      )
    ) {
      errors.push(`Suite ${suite.id}: invalid hash path groups`);
    }
    if (suite.runner && !files.includes(suite.runner))
      errors.push(`Suite ${suite.id}: missing benchmark runner ${suite.runner}`);
  }
  const subjectIds = catalog.subjects.map((subject) => subject.id);
  const suiteIds = catalog.suites.map((suite) => suite.id);
  const duplicateSubject = duplicate(subjectIds);
  const duplicateSuite = duplicate(suiteIds);
  if (duplicateSubject) errors.push(`Duplicate benchmark subject id: ${duplicateSubject}`);
  if (duplicateSuite) errors.push(`Duplicate benchmark suite id: ${duplicateSuite}`);

  const canonical = new Set(catalog.subjects.map((subject) => subject.canonical).filter(Boolean));
  const discoveredCanonical = new Set<string>();
  for (const path of files.filter((path) => AGENT_RE.test(path))) {
    discoveredCanonical.add(path);
    if (!canonical.has(path)) errors.push(`Missing canonical agent subject: ${path}`);
  }

  const packageRaw = source.read('package.json');
  if (!packageRaw) errors.push('Missing package.json for bin discovery');
  else {
    const bins = (JSON.parse(packageRaw) as { bin?: Record<string, string> }).bin ?? {};
    for (const name of Object.keys(bins).sort()) {
      const key = `package.json#bin:${name}`;
      discoveredCanonical.add(key);
      if (!canonical.has(key)) errors.push(`Missing shipped bin subject: ${name}`);
    }
  }

  const reviewersRaw = source.read('gate-engine/review/reviewers.mts') ?? '';
  const block = reviewersRaw.match(REVIEWER_BLOCK_RE)?.[0] ?? '';
  const reviewerNames = [...block.matchAll(REVIEWER_NAME_RE)].map((match) => match[1]);
  for (const name of reviewerNames) {
    const key = `REVIEWERS:${name}`;
    discoveredCanonical.add(key);
    if (!canonical.has(key)) errors.push(`Missing REVIEWERS subject: ${name}`);
  }
  for (const subject of catalog.subjects) {
    if (subject.canonical && !discoveredCanonical.has(subject.canonical))
      errors.push(`Orphan canonical subject ${subject.id}: ${subject.canonical}`);
  }

  const registeredRunners = new Set(catalog.suites.map((suite) => suite.runner).filter(Boolean));
  const excludedRunners = new Set(catalog.runnerExclusions);
  for (const runner of files.filter((path) => RUNNER_RE.test(path))) {
    if (!registeredRunners.has(runner) && !excludedRunners.has(runner)) {
      errors.push(`Orphan benchmark runner: ${runner}`);
    }
  }

  for (const singleton of catalog.singletonJudges) {
    if (!subjectIds.includes(singleton))
      errors.push(`Unknown singleton judge subject: ${singleton}`);
  }
  for (const suite of catalog.suites) {
    for (const subjectId of Array.isArray(suite.subjectIds) ? suite.subjectIds : []) {
      if (!subjectIds.includes(subjectId))
        errors.push(`Suite ${suite.id} references unknown subject: ${subjectId}`);
    }
  }
  for (const subject of catalog.subjects) {
    for (const suiteId of Array.isArray(subject.suiteIds) ? subject.suiteIds : []) {
      if (!suiteIds.includes(suiteId))
        errors.push(`Subject ${subject.id} references unknown suite: ${suiteId}`);
    }
  }
  return errors;
}
