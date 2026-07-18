export const LIFECYCLES = ['shipped', 'experimental', 'no-ship'] as const;
export const EVIDENCE_MODES = ['accepted', 'evidence-only', 'external-required', 'none'] as const;
export const FRESHNESS_STATES = ['current', 'stale', 'unknown'] as const;
export const CHANGE_TYPES = ['quality', 'coverage', 'methodology-reset', 'no-ship'] as const;
export const ASSESSMENTS = ['improved', 'regressed', 'flat', 'mixed', 'unknown'] as const;
export const METRIC_DIRECTIONS = ['higher', 'lower', 'target'] as const;
export const METRIC_UNITS = ['ratio', 'count', 'score', 'seconds', 'percentage-points'] as const;

export type Lifecycle = (typeof LIFECYCLES)[number];
export type EvidenceMode = (typeof EVIDENCE_MODES)[number];
export type Freshness = (typeof FRESHNESS_STATES)[number];
export type ChangeType = (typeof CHANGE_TYPES)[number];
export type Assessment = (typeof ASSESSMENTS)[number];
export type MetricDirection = (typeof METRIC_DIRECTIONS)[number];
export type MetricUnit = (typeof METRIC_UNITS)[number];

export interface HashSet {
  implementation: string;
  corpus: string;
  scorer: string;
  runner: string;
}

export interface MetricObservation {
  id: string;
  label: string;
  value: number;
  unit: MetricUnit;
  direction: MetricDirection;
  numerator?: number;
  denominator?: number;
  interval?: {
    method: string;
    lower: number;
    upper: number;
  };
  inferenceUnit: string;
  floor?: number;
  ceiling?: number;
  mde?: number;
  noiseFloor?: number;
  assessment?: Assessment;
}

export interface ComparisonObservation {
  predecessorEventId: string;
  sharedRows?: number;
  positiveDiscordant?: number;
  negativeDiscordant?: number;
  method: string;
  pValue?: number;
  verdict: Assessment | 'not-comparable' | 'coverage-only';
  note?: string;
}

export interface CheckpointEnvelope {
  schemaVersion: 1;
  suiteId: string;
  capturedAt: string;
  sourceCommit: string;
  adapter: string;
  hashes: HashSet;
  metrics: MetricObservation[];
  comparisons: ComparisonObservation[];
  rows: Record<string, unknown>;
  acceptance: {
    accepted: boolean;
    reason: string;
  };
}

export interface BenchmarkEvent {
  schemaVersion: 1;
  id: string;
  recordedAt: string;
  suiteId: string;
  subjectIds: string[];
  lifecycle: Lifecycle;
  evidence: EvidenceMode;
  freshness: Freshness;
  changeType: ChangeType;
  assessment: Assessment;
  provenance: {
    tier: 'accepted' | 'committed-summary' | 'reported' | 'local-aggregate' | 'external';
    source: string;
    sourceCommit?: string;
  };
  hashes?: HashSet;
  checkpoint?: {
    sha256: string;
    path: string;
  };
  metrics: MetricObservation[];
  comparisons: ComparisonObservation[];
  note: string;
  supersedes?: string;
}

export interface CatalogSubject {
  id: string;
  label: string;
  kind: 'agent' | 'bin' | 'reviewer' | 'judge' | 'benchmark';
  lifecycle: Lifecycle;
  evidence: EvidenceMode;
  suiteIds: string[];
  canonical?: string;
  externalUrl?: string;
}

export interface BenchmarkSuite {
  id: string;
  label: string;
  adapter: string;
  subjectIds: string[];
  runner?: string;
  baseline?: string;
  lifecycle: Lifecycle;
  acceptance: string;
  hashes: {
    implementation: string[];
    corpus: string[];
    scorer: string[];
    runner: string[];
  };
}

export interface BenchmarkCatalog {
  schemaVersion: 1;
  subjects: CatalogSubject[];
  suites: BenchmarkSuite[];
  singletonJudges: string[];
  runnerExclusions: string[];
}

export interface ParsedBaseline {
  metrics: MetricObservation[];
  rows: Record<string, unknown>;
  comparisons?: ComparisonObservation[];
  acceptance: {
    accepted: boolean;
    reason: string;
  };
}

export type TrackerMode = 'working' | 'staged' | 'tree';
