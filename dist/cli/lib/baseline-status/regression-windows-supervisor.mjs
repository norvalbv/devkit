import { spawn } from 'node:child_process';
import { constants } from 'node:os';
export const WINDOWS_REGRESSION_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGBREAK'];
export function regressionCaptureSignals(platform = process.platform) {
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
export function windowsHelperCanBeSignalled(helperExited) {
    return !helperExited;
}
export function attemptWindowsHelperSignal(started, helperExited, signalHelper) {
    if (started || !windowsHelperCanBeSignalled(helperExited))
        return started;
    try {
        return signalHelper();
    }
    catch {
        return false;
    }
}
/** Windows has no POSIX process groups; retain the prior direct-child lifecycle fallback there. */
export function superviseWindowsRegressionHelper(command) {
    const executable = command[0];
    if (!executable)
        return Promise.reject(new Error('execution helper requires a command'));
    return new Promise((resolveRun, reject) => {
        const child = spawn(executable, command.slice(1), { detached: false, stdio: 'inherit' });
        let settled = false;
        let helperError = null;
        let helperResult = null;
        let helperExited = false;
        let helperKillStarted = false;
        const settleIfReady = () => {
            if (settled || (!helperError && !helperResult))
                return;
            settled = true;
            for (const { signal, handler } of handlers)
                process.off(signal, handler);
            if (helperError) {
                reject(helperError);
                return;
            }
            const result = helperResult;
            resolveRun(result.status ?? (result.signal ? 128 + (constants.signals[result.signal] ?? 0) : 1));
        };
        const handlers = WINDOWS_REGRESSION_SIGNALS.map((signal) => {
            const handler = () => {
                helperKillStarted = attemptWindowsHelperSignal(helperKillStarted, helperExited, () => child.kill(signal));
            };
            return { signal, handler };
        });
        for (const { signal, handler } of handlers)
            process.on(signal, handler);
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
