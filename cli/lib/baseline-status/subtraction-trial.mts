import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { gitEnvironment } from '../ship/review/shared/common.mts';
import {
  sha256,
  type RegressionEvidence,
  type RegressionOperandEvidence,
} from './regression-evidence.mts';
import { captureRegressionComparison, regressionTempBase } from './regression-proof.mts';
import {
  linkRegressionDependencies,
  prepareRegressionRepository,
} from './regression-repository.mts';

const VALUE_OPTIONS = ['baseline', 'candidate', 'control', 'vitest-report'] as const;

function trialArgs(raw: string[]) {
  const separator = raw.indexOf('--');
  if (separator < 0) throw new Error('separate the exact test command with --');
  const { values } = parseArgs({
    args: raw.slice(0, separator),
    strict: true,
    options: {
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      control: { type: 'string' },
      'vitest-report': { type: 'string' },
      oracle: { type: 'string', multiple: true },
    },
  });
  for (const option of VALUE_OPTIONS) {
    if (!values[option]) throw new Error(`--${option} is required`);
  }
  if (!values.oracle?.length)
    throw new Error('at least one --oracle repository-relative file is required');
  for (const path of values.oracle) {
    if (
      isAbsolute(path) ||
      path.includes('\\') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error(`unsafe oracle path: ${JSON.stringify(path)}`);
    }
  }
  const command = raw.slice(separator + 1);
  return {
    baseline: values.baseline!,
    candidate: values.candidate!,
    control: values.control!,
    report: values['vitest-report']!,
    oracle: values.oracle,
    command,
  };
}

function captureArgs(red: string, green: string, report: string, command: string[]): string[] {
  return ['--red', red, '--green', green, '--vitest-report', report, '--', ...command];
}

function trialGit(root: string, args: string[]): Buffer {
  return execFileSync('git', ['-C', root, ...args], {
    env: gitEnvironment({ GIT_LITERAL_PATHSPECS: '1' }),
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
}

function oracleIdentity(root: string, sha: string, path: string): string {
  const entry = trialGit(root, ['ls-tree', '-z', sha, '--', path]).toString('utf8');
  if (!/^100(?:644|755) blob [0-9a-f]+\t[^\0]+\0$/.test(entry)) {
    throw new Error(`oracle must name a tracked regular file at each ref: ${JSON.stringify(path)}`);
  }
  return entry;
}

function trustworthyCapture(evidence: RegressionEvidence): boolean {
  return (
    evidence.callerBoundarySamples.matched &&
    evidence.cleanup.redCloneRemoved &&
    evidence.cleanup.greenCloneRemoved &&
    [evidence.red, evidence.green].every(
      (operand) =>
        !operand.signal &&
        !operand.spawnError &&
        !operand.reportError &&
        operand.testCounts !== null,
    )
  );
}

function passingAssertions(operand: RegressionOperandEvidence): boolean {
  const counts = operand.testCounts;
  return operand.exitCode === 0 && !!counts && counts.total > 0 && counts.passed === counts.total;
}

function trialConclusion(candidate: RegressionEvidence, control: RegressionEvidence) {
  if (!trustworthyCapture(candidate) || !trustworthyCapture(control)) {
    return {
      status: 'inconclusive',
      reason: 'capture, cleanup, caller samples or structured report unavailable',
    };
  }
  if (candidate.red.testCounts!.total === 0 || control.green.testCounts!.total === 0) {
    return { status: 'oracle_blind', reason: 'baseline executed no assertions' };
  }
  if (!passingAssertions(candidate.red) || !passingAssertions(control.green)) {
    return {
      status: 'inconclusive',
      reason: 'baseline did not pass nonempty assertions in both runs',
    };
  }
  const count = candidate.red.testCounts!.total;
  if (
    [candidate.green, control.red, control.green].some(
      (operand) => operand.testCounts!.total !== count,
    )
  ) {
    return { status: 'inconclusive', reason: 'executed assertion counts differ between operands' };
  }
  if (control.red.exitCode === 0 || control.red.testCounts!.failed === 0) {
    return { status: 'oracle_blind', reason: 'known-invalid control did not fail an assertion' };
  }
  if (passingAssertions(candidate.green)) {
    return {
      status: 'tests-preserved',
      reason:
        'selected assertions passed at baseline and candidate; the control failed an assertion',
    };
  }
  if (candidate.green.exitCode !== 0 && candidate.green.testCounts!.failed > 0) {
    return { status: 'tests-failed', reason: 'candidate failed a selected assertion' };
  }
  return {
    status: 'inconclusive',
    reason: 'candidate did not produce a complete assertion result',
  };
}

/** A capture that ended before producing evidence is an inconclusive trial, never a silent exit. */
function captureFailed(operand: 'candidate' | 'control', exitCode: number): number {
  console.log(`subtraction: inconclusive — the ${operand} capture produced no evidence`);
  return exitCode || 1;
}

export async function subtractionTrial(
  rawArgs: string[],
  cwd: string,
  capture = captureRegressionComparison,
): Promise<number> {
  let dependencyRoot: string | null = null;
  try {
    const args = trialArgs(rawArgs);
    const pair = prepareRegressionRepository(
      captureArgs(args.baseline, args.candidate, args.report, args.command),
      cwd,
    );
    const controlPair = prepareRegressionRepository(
      captureArgs(args.control, pair.redSha, args.report, args.command),
      cwd,
    );
    const oracles = args.oracle.map((path) => {
      const identity = oracleIdentity(pair.root, pair.redSha, path);
      if (
        [pair.greenSha, controlPair.redSha].some(
          (sha) => oracleIdentity(pair.root, sha, path) !== identity,
        )
      ) {
        throw new Error(`oracle changed between refs: ${JSON.stringify(path)}`);
      }
      return { path, treeEntry: identity };
    });
    const diff = trialGit(pair.root, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      pair.redSha,
      pair.greenSha,
      '--',
    ]);
    const paths = trialGit(pair.root, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-only',
      '-z',
      pair.redSha,
      pair.greenSha,
      '--',
    ])
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    dependencyRoot = mkdtempSync(
      join(regressionTempBase(pair.root), 'devkit-subtraction-dependencies-'),
    );
    mkdirSync(join(dependencyRoot, pair.prefix), { recursive: true });
    const dependencies = linkRegressionDependencies(
      dependencyRoot,
      pair.prefix,
      pair.dependencySource,
    );
    const candidate = await capture(
      captureArgs(pair.redSha, pair.greenSha, args.report, args.command),
      cwd,
      dependencies,
    );
    if (!candidate.evidence || !candidate.evidenceDir)
      return captureFailed('candidate', candidate.exitCode);
    const control = await capture(
      captureArgs(controlPair.redSha, pair.redSha, args.report, args.command),
      cwd,
      dependencies,
    );
    if (!control.evidence || !control.evidenceDir)
      return captureFailed('control', control.exitCode);
    const conclusion = trialConclusion(candidate.evidence, control.evidence);
    const evidence = {
      schema: 1,
      ...conclusion,
      redundancyProven: false,
      limitation:
        'Observation of the selected assertions only; removed-hunk coverage is not measured. Declared oracle files stayed fixed; their sufficiency and the control failure cause require review. Commands are trusted and unsandboxed.',
      command: candidate.evidence.command,
      oracles,
      candidateDiff: { sha256: sha256(diff), paths },
      baseline: candidate.evidence.red,
      candidate: candidate.evidence.green,
      control: control.evidence.red,
      captures: { candidate: candidate.evidenceDir, control: control.evidenceDir },
    };
    writeFileSync(join(candidate.evidenceDir, 'candidate.diff'), diff, { mode: 0o600 });
    writeFileSync(
      join(candidate.evidenceDir, 'subtraction.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(`subtraction: ${conclusion.status} — ${conclusion.reason}`);
    console.log(`subtraction evidence: ${candidate.evidenceDir}`);
    return conclusion.status === 'tests-preserved' ? 0 : 1;
  } catch (error) {
    console.error(`subtraction-trial: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (dependencyRoot) rmSync(dependencyRoot, { recursive: true, force: true });
  }
}
