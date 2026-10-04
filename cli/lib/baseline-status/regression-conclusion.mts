import type { RegressionEvidence, RegressionOperandEvidence } from './regression-evidence.mts';

export function regressionResultReason(
  red: RegressionOperandEvidence,
  green: RegressionOperandEvidence,
  callerSamplesMatched: boolean,
  cleanup: RegressionEvidence['cleanup'],
): Pick<RegressionEvidence, 'status' | 'reason'> {
  if (!callerSamplesMatched) {
    return { status: 'inconclusive', reason: 'caller boundary fingerprints differ' };
  }
  if (!cleanup.redCloneRemoved || !cleanup.greenCloneRemoved) {
    return { status: 'inconclusive', reason: 'a disposable clone could not be removed' };
  }
  if (red.signal || green.signal) {
    return { status: 'inconclusive', reason: 'a test command ended from a signal' };
  }
  if (red.spawnError || green.spawnError) {
    return { status: 'inconclusive', reason: 'a test command could not be started' };
  }
  if (red.reportError || green.reportError) {
    return { status: 'inconclusive', reason: 'a requested structured report was unavailable' };
  }
  if (red.exitCode === null || red.exitCode === 0 || green.exitCode !== 0) {
    return {
      status: 'inconclusive',
      reason: `expected red nonzero and green zero; got ${String(red.exitCode)}/${String(green.exitCode)}`,
    };
  }
  return {
    status: 'captured',
    reason: `the same argv exited ${red.exitCode} on red and 0 on green`,
  };
}
