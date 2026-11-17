import { spawn } from 'node:child_process';
import { constants } from 'node:os';

export const WINDOWS_REGRESSION_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGBREAK'] as const;

export function regressionCaptureSignals(
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<readonly [NodeJS.Signals, number]> {
  if (platform === 'win32') {
    return WINDOWS_REGRESSION_SIGNALS.map((signal) => [
      signal,
      128 + (constants.signals[signal] ?? 0),
    ]);
  }
  return [
    ['SIGHUP', 129],
    ['SIGINT', 130],
    ['SIGQUIT', 131],
    ['SIGTERM', 143],
  ];
}

interface WindowsHelperResult {
  status: number | null;
  signal: NodeJS.Signals | null;
}

export function windowsHelperCanBeSignalled(helperExited: boolean): boolean {
  return !helperExited;
}

export function attemptWindowsHelperSignal(
  started: boolean,
  helperExited: boolean,
  signalHelper: () => boolean,
): boolean {
  if (started || !windowsHelperCanBeSignalled(helperExited)) return started;
  try {
    return signalHelper();
  } catch {
    return false;
  }
}

/** Windows has no POSIX process groups; retain the prior direct-child lifecycle fallback there. */
export function superviseWindowsRegressionHelper(command: string[]): Promise<number> {
  const executable = command[0];
  if (!executable) return Promise.reject(new Error('execution helper requires a command'));
  return new Promise<number>((resolveRun, reject) => {
    const child = spawn(executable, command.slice(1), { detached: false, stdio: 'inherit' });
    let settled = false;
    let helperError: Error | null = null;
    let helperResult: WindowsHelperResult | null = null;
    let helperExited = false;
    let helperKillStarted = false;
    const settleIfReady = (): void => {
      if (settled || (!helperError && !helperResult)) return;
      settled = true;
      for (const { signal, handler } of handlers) process.off(signal, handler);
      if (helperError) {
        reject(helperError);
        return;
      }
      const result = helperResult!;
      resolveRun(
        result.status ?? (result.signal ? 128 + (constants.signals[result.signal] ?? 0) : 1),
      );
    };
    const handlers = WINDOWS_REGRESSION_SIGNALS.map((signal) => {
      const handler = (): void => {
        helperKillStarted = attemptWindowsHelperSignal(helperKillStarted, helperExited, () =>
          child.kill(signal),
        );
      };
      return { signal, handler };
    });
    for (const { signal, handler } of handlers) process.on(signal, handler);
    child.once('error', (error) => {
      helperError = error;
      settleIfReady();
    });
    child.once('exit', () => {
      helperExited = true;
    });
    child.once('close', (status, signal) => {
      helperResult = { status, signal };
      settleIfReady();
    });
  });
}
