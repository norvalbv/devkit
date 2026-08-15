import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { superviseGateCommand } from '../../../cli/lib/ship/review/process/gate-supervisor.mts';
import { readProcessTable } from '../../../cli/lib/ship/review/process/process-table.mts';
import { canonicalJson } from '../history.mts';
import { analyzeDiagnostics, diagnosticDigest } from './diagnostics.mts';
import {
  fixtureManifest,
  localPatchDigest,
  materializeFixture,
  type PerformanceFixture,
  type PreparedSource,
  prepareSource,
  verifyFixture,
} from './fixture.mts';
import type {
  CommandSpec,
  ContenderResult,
  ContenderSpec,
  ExperimentSpec,
  LaneResult,
  LaneSpec,
  PerformanceResult,
  PerformanceSample,
  SamplePlan,
} from './model.mts';
import {
  assertMinimumNodeVersion,
  balancedSchedule,
  digest,
  parseExperimentSpec,
  summarize,
} from './model.mts';
import type { MeasurementRequest, MeasurementResult } from './time.mts';

const MEASUREMENT_CHILD = fileURLToPath(new URL('./measurement-child.mts', import.meta.url));
const PRIVATE_ENVIRONMENT = /(?:TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|AUTH|COOKIE|SESSION|KEY)/i;

interface RunOptions {
  sourceRoot: string;
  onProgress?: (message: string) => void;
}

interface CapturedMeasurement {
  result: MeasurementResult;
  stdout: string;
  stderr: string;
}

function inside(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === '..' || rel.startsWith('../')) throw new Error(`Path escapes root: ${path}`);
  return absolute;
}

function resolveExecutable(fixtureRoot: string, executable: string): string {
  if (isAbsolute(executable))
    throw new Error('Experiment specs may not contain absolute executables');
  if (executable === 'node') return process.execPath;
  return realpathSync(inside(fixtureRoot, executable));
}

function safeEnvironment(
  root: string,
  extra: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const inheritedPath = process.env.PATH;
  if (!inheritedPath) throw new Error('PATH is required to run benchmark tools');
  if (extra && Object.keys(extra).some((name) => PRIVATE_ENVIRONMENT.test(name)))
    throw new Error('Benchmark specs may not declare secret-bearing environment variables');
  const home = join(root, 'home');
  const temporary = join(root, 'tmp');
  mkdirSync(home, { recursive: true });
  mkdirSync(temporary, { recursive: true });
  return {
    PATH: inheritedPath,
    HOME: home,
    TMPDIR: temporary,
    LC_ALL: 'C',
    LANG: 'C',
    TZ: 'UTC',
    CI: '1',
    NO_COLOR: '1',
    ...extra,
  };
}

function toolVersion(
  executable: string,
  command: CommandSpec,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): string {
  if (command.versionArgs.length === 0)
    return executable === process.execPath ? process.version : 'unreported';
  const result = spawnSync(executable, command.versionArgs, {
    cwd,
    env: environment,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`Could not read tool version for ${command.executable}`);
  return result.stdout.trim().split('\n')[0]?.slice(0, 200) || 'unreported';
}

async function captureMeasurement(
  experimentRoot: string,
  timeoutMs: number,
  request: Omit<MeasurementRequest, 'platform' | 'stdoutPath' | 'stderrPath' | 'timingPath'>,
): Promise<CapturedMeasurement> {
  const runRoot = mkdtempSync(join(experimentRoot, 'sample-'));
  const requestPath = join(runRoot, 'request.json');
  const resultPath = join(runRoot, 'result.json');
  const stdoutPath = join(runRoot, 'stdout.log');
  const stderrPath = join(runRoot, 'stderr.log');
  const timingPath = join(runRoot, 'time.log');
  writeFileSync(
    requestPath,
    canonicalJson({ ...request, platform: process.platform, stdoutPath, stderrPath, timingPath }),
  );
  const supervisorStatus = await superviseGateCommand(
    timeoutMs,
    [process.execPath, MEASUREMENT_CHILD, requestPath, resultPath],
    readProcessTable,
    undefined,
    false,
  );
  let result: MeasurementResult;
  try {
    result = JSON.parse(readFileSync(resultPath, 'utf8')) as MeasurementResult;
  } catch (error) {
    if (supervisorStatus === 124)
      throw new Error(`Benchmark command exceeded ${timeoutMs}ms`, { cause: error });
    throw new Error(
      `Benchmark measurement failed before producing metrics (status ${supervisorStatus})`,
      {
        cause: error,
      },
    );
  }
  if (supervisorStatus !== result.exitCode)
    throw new Error(
      `Supervisor status ${supervisorStatus} disagrees with measured exit ${result.exitCode}`,
    );
  return {
    result,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  };
}

function commandArguments(
  command: CommandSpec,
  requestedFiles: string[],
  fixtureRoot: string,
  cwd: string,
  appendToArgs: boolean,
): string[] {
  const relativeFiles = requestedFiles.map((path) =>
    relative(cwd, resolve(fixtureRoot, path)).replaceAll('\\', '/'),
  );
  if (command.args.includes('{inputs}'))
    return command.args.flatMap((arg) => (arg === '{inputs}' ? relativeFiles : [arg]));
  return appendToArgs ? [...command.args, ...relativeFiles] : command.args;
}

export function persistentFixtureKey(
  lane: Pick<LaneSpec, 'id'>,
  contender: Pick<ContenderSpec, 'id'>,
): string {
  return digest(canonicalJson([lane.id, contender.id]));
}

function buildFixture(
  prepared: PreparedSource,
  spec: ExperimentSpec,
  experimentRoot: string,
  lane: LaneSpec,
  contender: ContenderSpec,
  plan: SamplePlan,
  persistent: Map<string, PerformanceFixture>,
): { fixture: PerformanceFixture; disposable: boolean } {
  if (lane.scope === 'local-staged') {
    const key = persistentFixtureKey(lane, contender);
    const existing = persistent.get(key);
    if (existing) return { fixture: existing, disposable: false };
    const fixture = materializeFixture(
      prepared,
      spec,
      join(experimentRoot, 'local', key),
      lane.scope,
    );
    persistent.set(key, fixture);
    return { fixture, disposable: false };
  }
  const root = join(experimentRoot, 'full', `${lane.id}-${plan.orderIndex}-${contender.id}`);
  return {
    fixture: materializeFixture(prepared, spec, root, lane.scope),
    disposable: true,
  };
}

async function calibration(experimentRoot: string, timeoutMs: number): Promise<number> {
  const environment = safeEnvironment(join(experimentRoot, 'calibration'), undefined);
  const values: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const sample = await captureMeasurement(experimentRoot, timeoutMs, {
      executable: process.execPath,
      args: ['-e', 'process.exitCode = 0'],
      cwd: process.cwd(),
      environment,
    });
    if (sample.result.exitCode !== 0 || sample.result.maxResidentSetBytes <= 0)
      throw new Error('Platform timing capability probe failed');
    values.push(sample.result.wallSeconds);
  }
  return summarize(values).median;
}

function assertStableAnalysis(
  samples: PerformanceSample[],
  diagnostics: string[],
  reportedFiles: string[],
): void {
  if (new Set(diagnostics).size !== 1)
    throw new Error('A contender produced different diagnostic sets between samples');
  if (new Set(reportedFiles).size !== 1)
    throw new Error('A contender reported different processed files between samples');
  if (samples.filter((sample) => sample.phase === 'measured').length === 0)
    throw new Error('A contender produced no measured samples');
}

async function runLane(
  lane: LaneSpec,
  spec: ExperimentSpec,
  prepared: PreparedSource,
  experimentRoot: string,
  onProgress: (message: string) => void,
): Promise<LaneResult> {
  const schedule = balancedSchedule(
    lane.contenders.map((contender) => contender.id),
    spec.warmupsPerContender,
    spec.measurementsPerContender,
  );
  const inputApplications = lane.contenders.map(
    (contender) =>
      lane.inputs.appendToArgs || contender.command.args.some((arg) => arg === '{inputs}'),
  );
  if (new Set(inputApplications).size !== 1)
    throw new Error(`Lane ${lane.id} contenders apply input manifests differently`);
  const inputsAppliedToCommand = inputApplications[0] ?? false;
  const persistent = new Map<string, PerformanceFixture>();
  const results = new Map<
    string,
    {
      samples: PerformanceSample[];
      digests: string[];
      reportedFileDigests: string[];
      diagnostics?: ReturnType<typeof analyzeDiagnostics>;
      toolVersion?: string;
      requestedFiles?: string[];
    }
  >();
  try {
    for (const plan of schedule) {
      const contender = lane.contenders.find((candidate) => candidate.id === plan.contenderId);
      if (!contender) throw new Error(`Unknown scheduled contender: ${plan.contenderId}`);
      const state = results.get(contender.id) ?? {
        samples: [],
        digests: [],
        reportedFileDigests: [],
      };
      results.set(contender.id, state);
      const { fixture, disposable } = buildFixture(
        prepared,
        spec,
        experimentRoot,
        lane,
        contender,
        plan,
        persistent,
      );
      try {
        const requestedFiles = fixtureManifest(fixture, lane.inputs);
        if (requestedFiles.length === 0) throw new Error(`Lane ${lane.id} selected no input files`);
        if (
          state.requestedFiles &&
          canonicalJson(state.requestedFiles) !== canonicalJson(requestedFiles)
        )
          throw new Error(`Lane ${lane.id} input manifest changed between samples`);
        state.requestedFiles ??= requestedFiles;
        const cwd = realpathSync(inside(fixture.root, lane.cwd));
        const executable = resolveExecutable(fixture.root, contender.command.executable);
        const environmentKey =
          lane.scope === 'local-staged'
            ? persistentFixtureKey(lane, contender)
            : `${persistentFixtureKey(lane, contender)}-${plan.orderIndex}`;
        const environment = safeEnvironment(
          join(experimentRoot, 'environment', environmentKey),
          contender.command.environment,
        );
        state.toolVersion ??= toolVersion(executable, contender.command, cwd, environment);
        onProgress(
          `${lane.id}: ${plan.phase} ${plan.round + 1}/${plan.phase === 'warmup' ? spec.warmupsPerContender : spec.measurementsPerContender} ${contender.id}`,
        );
        const captured = await captureMeasurement(experimentRoot, spec.timeoutMs, {
          executable,
          args: commandArguments(
            contender.command,
            requestedFiles,
            fixture.root,
            cwd,
            lane.inputs.appendToArgs,
          ),
          cwd,
          environment,
        });
        if (captured.result.signal)
          throw new Error(`${lane.id}/${contender.id} terminated by ${captured.result.signal}`);
        if (captured.result.exitCode !== contender.command.expectedExit)
          throw new Error(
            `${lane.id}/${contender.id} exited ${captured.result.exitCode}; expected ${contender.command.expectedExit}`,
          );
        const analyzed = analyzeDiagnostics(
          contender.command.analyzer,
          captured.stdout,
          captured.stderr,
          fixture.root,
          cwd,
        );
        const diagnosticsDigest = diagnosticDigest(analyzed.diagnostics);
        state.diagnostics ??= analyzed;
        state.digests.push(diagnosticsDigest);
        state.reportedFileDigests.push(
          analyzed.reportedProcessedFiles
            ? digest(canonicalJson(analyzed.reportedProcessedFiles))
            : '<unavailable>',
        );
        state.samples.push({
          phase: plan.phase,
          round: plan.round,
          orderIndex: plan.orderIndex,
          wallSeconds: captured.result.wallSeconds,
          userSeconds: captured.result.userSeconds,
          systemSeconds: captured.result.systemSeconds,
          cpuTotalSeconds: captured.result.userSeconds + captured.result.systemSeconds,
          maxResidentSetBytes: captured.result.maxResidentSetBytes,
          exitCode: captured.result.exitCode,
          diagnosticCount: analyzed.diagnostics.length,
          diagnosticDigest: diagnosticsDigest,
          stdoutSha256: digest(captured.stdout),
          stderrSha256: digest(captured.stderr),
        });
        verifyFixture(fixture);
      } finally {
        if (disposable) rmSync(fixture.root, { recursive: true, force: true });
      }
    }

    const contenders: ContenderResult[] = lane.contenders.map((contender) => {
      const state = results.get(contender.id);
      if (!state?.diagnostics || !state.toolVersion || !state.requestedFiles)
        throw new Error(`Contender ${contender.id} did not run`);
      assertStableAnalysis(state.samples, state.digests, state.reportedFileDigests);
      const measured = state.samples.filter((sample) => sample.phase === 'measured');
      return {
        id: contender.id,
        label: contender.label,
        toolVersion: state.toolVersion,
        diagnostics: state.diagnostics.diagnostics,
        ...(state.diagnostics.reportedProcessedFiles
          ? { reportedProcessedFiles: state.diagnostics.reportedProcessedFiles }
          : {}),
        samples: state.samples,
        summary: {
          wallSeconds: summarize(measured.map((sample) => sample.wallSeconds)),
          cpuTotalSeconds: summarize(measured.map((sample) => sample.cpuTotalSeconds)),
          maxResidentSetBytes: summarize(measured.map((sample) => sample.maxResidentSetBytes)),
        },
      };
    });
    const requestedFileSets = lane.contenders.map(
      (contender) => results.get(contender.id)?.requestedFiles ?? [],
    );
    if (new Set(requestedFileSets.map((files) => canonicalJson(files))).size !== 1)
      throw new Error(`Lane ${lane.id} contenders received different input manifests`);
    const requestedFiles = requestedFileSets[0] ?? [];
    const comparable =
      contenders.length === 1 ||
      contenders.every(
        (contender) =>
          diagnosticDigest(contender.diagnostics) ===
          diagnosticDigest(contenders[0]?.diagnostics ?? []),
      );
    return {
      id: lane.id,
      label: lane.label,
      scope: lane.scope,
      inputsAppliedToCommand,
      requestedFiles,
      requestedFilesDigest: digest(canonicalJson(requestedFiles)),
      parity: {
        comparable,
        reason:
          contenders.length === 1
            ? 'Baseline lane; diagnostic digest retained for later comparison'
            : comparable
              ? 'Normalized diagnostic sets match exactly'
              : 'Normalized diagnostic sets differ',
      },
      contenders,
    };
  } finally {
    for (const fixture of persistent.values())
      rmSync(fixture.root, { recursive: true, force: true });
  }
}

export async function runPerformanceExperiment(
  rawSpec: unknown,
  options: RunOptions,
): Promise<PerformanceResult> {
  const spec = parseExperimentSpec(rawSpec);
  assertMinimumNodeVersion(process.versions.node, spec.minimumNodeVersion);
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error(`Unsupported performance benchmark platform: ${process.platform}`);
  const experimentRoot = realpathSync(mkdtempSync(join(tmpdir(), 'devkit-quality-bench-')));
  const onProgress = options.onProgress ?? (() => undefined);
  try {
    const prepared = prepareSource(options.sourceRoot, spec.sourceTree, experimentRoot);
    const instrumentationFloorSeconds = await calibration(experimentRoot, spec.timeoutMs);
    const lanes: LaneResult[] = [];
    for (const lane of spec.lanes) {
      lanes.push(await runLane(lane, spec, prepared, experimentRoot, onProgress));
    }
    const accepted = lanes.every((lane) => lane.parity.comparable);
    return {
      schemaVersion: 1,
      experimentId: spec.id,
      capturedAt: new Date().toISOString(),
      sourceCommit: prepared.sourceCommit,
      protocol: {
        warmupsPerContender: spec.warmupsPerContender,
        measurementsPerContender: spec.measurementsPerContender,
        minimumNodeVersion: spec.minimumNodeVersion,
        order: 'balanced AB/BA rounds; each contender runs first equally often when n is even',
        p95Method: 'nearest-rank; at n=10 p95 equals max',
      },
      accounting: {
        wall: 'monotonic-wrapper',
        cpu: 'wait-accounted-command',
        memory: 'timed-command-maxrss',
        instrumentationFloorSeconds,
      },
      host: {
        platform: platform(),
        release: release(),
        architecture: process.arch,
        logicalCpuCount: cpus().length,
        nodeVersion: process.version,
      },
      fixture: {
        sourceTree: spec.sourceTree,
        localPatchDigest: localPatchDigest(spec),
        cachePolicy: {
          localStaged: 'isolated contender fixture retained across warmups and measured samples',
          fullClean:
            'fresh disposable committed fixture and tool cache directories for every sample; dependency tree shared and excluded from timing',
        },
      },
      lanes,
      acceptance: {
        accepted,
        reason: accepted
          ? 'All samples completed with stable inputs, exits, and normalized diagnostics'
          : 'At least one comparison lane failed normalized diagnostic parity',
      },
    };
  } finally {
    rmSync(experimentRoot, { recursive: true, force: true });
  }
}
