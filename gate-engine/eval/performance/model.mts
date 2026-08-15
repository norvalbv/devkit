import { createHash } from 'node:crypto';

export const PERFORMANCE_SCOPES = ['local-staged', 'full-clean'] as const;
export const ANALYZER_KINDS = ['none', 'biome-json', 'eslint-json', 'tsc-text'] as const;
const SEMANTIC_VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export type PerformanceScope = (typeof PERFORMANCE_SCOPES)[number];
export type AnalyzerKind = (typeof ANALYZER_KINDS)[number];
export type SamplePhase = 'warmup' | 'measured';

export interface InputSpec {
  mode: 'changed' | 'tracked';
  include: string[];
  appendToArgs: boolean;
}

export interface CommandSpec {
  executable: string;
  args: string[];
  versionArgs: string[];
  expectedExit: number;
  analyzer: AnalyzerKind;
  environment?: Record<string, string>;
}

export interface ContenderSpec {
  id: string;
  label: string;
  command: CommandSpec;
}

export interface LaneSpec {
  id: string;
  label: string;
  scope: PerformanceScope;
  cwd: string;
  inputs: InputSpec;
  contenders: ContenderSpec[];
}

export interface ExperimentSpec {
  schemaVersion: 1;
  id: string;
  sourceTree: string;
  minimumNodeVersion: string;
  timeoutMs: number;
  warmupsPerContender: number;
  measurementsPerContender: number;
  localPatch: { path: string; append: string };
  lanes: LaneSpec[];
}

export interface SamplePlan {
  phase: SamplePhase;
  round: number;
  orderIndex: number;
  contenderId: string;
}

export interface SummaryStats {
  count: number;
  min: number;
  median: number;
  max: number;
  p95NearestRank: number;
}

export interface NormalizedDiagnostic {
  semanticRuleId: string;
  relativePath: string;
  line: number;
  column: number;
  severity: string;
  normalizedMessage: string;
}

export interface AnalyzerResult {
  diagnostics: NormalizedDiagnostic[];
  reportedProcessedFiles?: string[];
}

export interface PerformanceSample {
  phase: SamplePhase;
  round: number;
  orderIndex: number;
  wallSeconds: number;
  userSeconds: number;
  systemSeconds: number;
  cpuTotalSeconds: number;
  maxResidentSetBytes: number;
  exitCode: number;
  diagnosticCount: number;
  diagnosticDigest: string;
  stdoutSha256: string;
  stderrSha256: string;
}

export interface ContenderResult {
  id: string;
  label: string;
  toolVersion: string;
  diagnostics: NormalizedDiagnostic[];
  reportedProcessedFiles?: string[];
  samples: PerformanceSample[];
  summary: {
    wallSeconds: SummaryStats;
    cpuTotalSeconds: SummaryStats;
    maxResidentSetBytes: SummaryStats;
  };
}

export interface LaneResult {
  id: string;
  label: string;
  scope: PerformanceScope;
  inputsAppliedToCommand: boolean;
  requestedFiles: string[];
  requestedFilesDigest: string;
  parity: { comparable: boolean; reason: string };
  contenders: ContenderResult[];
}

export interface PerformanceResult {
  schemaVersion: 1;
  experimentId: string;
  capturedAt: string;
  sourceCommit: string;
  protocol: {
    warmupsPerContender: number;
    measurementsPerContender: number;
    minimumNodeVersion: string;
    order: string;
    p95Method: string;
  };
  accounting: {
    wall: 'monotonic-wrapper';
    cpu: 'wait-accounted-command';
    memory: 'timed-command-maxrss';
    instrumentationFloorSeconds: number;
  };
  host: {
    platform: string;
    release: string;
    architecture: string;
    logicalCpuCount: number;
    nodeVersion: string;
  };
  fixture: {
    sourceTree: string;
    localPatchDigest: string;
    cachePolicy: { localStaged: string; fullClean: string };
  };
  lanes: LaneResult[];
  acceptance: { accepted: boolean; reason: string };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function strings(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error(`${location} must be an array of strings`);
  return value as string[];
}

function nonEmpty(value: unknown, location: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${location} must be non-empty`);
  return value;
}

function integer(value: unknown, location: string, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum)
    throw new Error(`${location} must be an integer >= ${minimum}`);
  return value as number;
}

function versionParts(value: string, location: string): [number, number, number] {
  const match = SEMANTIC_VERSION.exec(value);
  if (!match) throw new Error(`${location} must be a semantic version`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function assertMinimumNodeVersion(current: string, minimum: string): void {
  const actual = versionParts(current, 'current Node version');
  const floor = versionParts(minimum, 'minimumNodeVersion');
  for (let index = 0; index < floor.length; index += 1) {
    if ((actual[index] as number) > (floor[index] as number)) return;
    if ((actual[index] as number) < (floor[index] as number))
      throw new Error(`Node ${minimum} or newer is required; running ${current}`);
  }
}

function command(value: unknown, location: string): CommandSpec {
  if (!record(value)) throw new Error(`${location} must be an object`);
  const analyzer = nonEmpty(value.analyzer, `${location}.analyzer`);
  if (!(ANALYZER_KINDS as readonly string[]).includes(analyzer))
    throw new Error(`${location}.analyzer is unsupported: ${analyzer}`);
  const environment = value.environment;
  if (
    environment !== undefined &&
    (!record(environment) || Object.values(environment).some((item) => typeof item !== 'string'))
  ) {
    throw new Error(`${location}.environment must contain string values`);
  }
  return {
    executable: nonEmpty(value.executable, `${location}.executable`),
    args: strings(value.args, `${location}.args`),
    versionArgs: strings(value.versionArgs, `${location}.versionArgs`),
    expectedExit: integer(value.expectedExit, `${location}.expectedExit`, 0),
    analyzer: analyzer as AnalyzerKind,
    ...(environment ? { environment: environment as Record<string, string> } : {}),
  };
}

function lane(value: unknown, index: number): LaneSpec {
  const location = `lanes[${index}]`;
  if (!record(value)) throw new Error(`${location} must be an object`);
  const scope = nonEmpty(value.scope, `${location}.scope`);
  if (!(PERFORMANCE_SCOPES as readonly string[]).includes(scope))
    throw new Error(`${location}.scope is unsupported: ${scope}`);
  if (!record(value.inputs)) throw new Error(`${location}.inputs must be an object`);
  const mode = nonEmpty(value.inputs.mode, `${location}.inputs.mode`);
  if (!['changed', 'tracked'].includes(mode))
    throw new Error(`${location}.inputs.mode must be changed or tracked`);
  if (scope === 'local-staged' && mode !== 'changed')
    throw new Error(`${location}: local-staged lanes must use changed inputs`);
  if (scope === 'full-clean' && mode !== 'tracked')
    throw new Error(`${location}: full-clean lanes must use tracked inputs`);
  if (
    !Array.isArray(value.contenders) ||
    value.contenders.length < 1 ||
    value.contenders.length > 2
  )
    throw new Error(`${location}.contenders must contain one or two contenders`);
  const contenders = value.contenders.map((candidate, contenderIndex) => {
    const contenderLocation = `${location}.contenders[${contenderIndex}]`;
    if (!record(candidate)) throw new Error(`${contenderLocation} must be an object`);
    return {
      id: nonEmpty(candidate.id, `${contenderLocation}.id`),
      label: nonEmpty(candidate.label, `${contenderLocation}.label`),
      command: command(candidate.command, `${contenderLocation}.command`),
    };
  });
  if (new Set(contenders.map((candidate) => candidate.id)).size !== contenders.length)
    throw new Error(`${location}: contender ids must be unique`);
  return {
    id: nonEmpty(value.id, `${location}.id`),
    label: nonEmpty(value.label, `${location}.label`),
    scope: scope as PerformanceScope,
    cwd: nonEmpty(value.cwd, `${location}.cwd`),
    inputs: {
      mode: mode as InputSpec['mode'],
      include: strings(value.inputs.include, `${location}.inputs.include`),
      appendToArgs: value.inputs.appendToArgs === true,
    },
    contenders,
  };
}

export function parseExperimentSpec(value: unknown): ExperimentSpec {
  if (!record(value) || value.schemaVersion !== 1)
    throw new Error('Performance experiment must use schemaVersion 1');
  if (!record(value.localPatch)) throw new Error('localPatch must be an object');
  if (!Array.isArray(value.lanes) || value.lanes.length === 0)
    throw new Error('lanes must be a non-empty array');
  const lanes = value.lanes.map(lane);
  if (new Set(lanes.map((candidate) => candidate.id)).size !== lanes.length)
    throw new Error('lane ids must be unique');
  const measurements = integer(value.measurementsPerContender, 'measurementsPerContender', 10);
  if (lanes.some((candidate) => candidate.contenders.length === 2) && measurements % 2 !== 0)
    throw new Error('measurementsPerContender must be even for balanced A/B comparisons');
  const minimumNodeVersion = nonEmpty(value.minimumNodeVersion, 'minimumNodeVersion');
  assertMinimumNodeVersion(minimumNodeVersion, minimumNodeVersion);
  return {
    schemaVersion: 1,
    id: nonEmpty(value.id, 'id'),
    sourceTree: nonEmpty(value.sourceTree, 'sourceTree'),
    minimumNodeVersion,
    timeoutMs: integer(value.timeoutMs, 'timeoutMs', 1),
    warmupsPerContender: integer(value.warmupsPerContender, 'warmupsPerContender', 3),
    measurementsPerContender: measurements,
    localPatch: {
      path: nonEmpty(value.localPatch.path, 'localPatch.path'),
      append: nonEmpty(value.localPatch.append, 'localPatch.append'),
    },
    lanes,
  };
}

export function balancedSchedule(
  contenderIds: string[],
  warmupsPerContender: number,
  measurementsPerContender: number,
): SamplePlan[] {
  const plans: SamplePlan[] = [];
  let orderIndex = 0;
  for (const phase of ['warmup', 'measured'] as const) {
    const rounds = phase === 'warmup' ? warmupsPerContender : measurementsPerContender;
    for (let round = 0; round < rounds; round += 1) {
      const order =
        contenderIds.length === 2 && round % 2 === 1 ? [...contenderIds].reverse() : contenderIds;
      for (const contenderId of order) {
        plans.push({ phase, round, orderIndex, contenderId });
        orderIndex += 1;
      }
    }
  }
  return plans;
}

export function summarize(values: number[]): SummaryStats {
  if (values.length === 0) throw new Error('Cannot summarize an empty sample');
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const median =
    ordered.length % 2 === 0
      ? ((ordered[middle - 1] as number) + (ordered[middle] as number)) / 2
      : (ordered[middle] as number);
  return {
    count: ordered.length,
    min: ordered[0] as number,
    median,
    max: ordered.at(-1) as number,
    p95NearestRank: ordered[Math.ceil(ordered.length * 0.95) - 1] as number,
  };
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
