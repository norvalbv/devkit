import { spawn } from 'node:child_process';
import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { constants } from 'node:os';
import { gitEnvironment } from '../ship/review/shared/common.mjs';
function statusFor(result) {
    if (result.exitCode !== null)
        return result.exitCode;
    return result.signal ? 128 + (constants.signals[result.signal] ?? 0) : 1;
}
async function main(args) {
    const separator = args.indexOf('--');
    const [cwd, stdoutPath, stderrPath, resultPath] = args;
    const command = args.slice(separator + 1);
    const executable = command[0];
    if (separator !== 4 || !cwd || !stdoutPath || !stderrPath || !resultPath || !executable) {
        throw new Error('invalid regression execution helper arguments');
    }
    const stdout = openSync(stdoutPath, 'w', 0o600);
    const stderr = openSync(stderrPath, 'w', 0o600);
    return await new Promise((resolve) => {
        let settled = false;
        const finish = (result, error) => {
            if (settled)
                return;
            settled = true;
            if (error)
                writeSync(stderr, `could not start test command: ${error.message}\n`);
            closeSync(stdout);
            closeSync(stderr);
            writeFileSync(resultPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
            resolve(statusFor(result));
        };
        const child = spawn(executable, command.slice(1), {
            cwd,
            detached: process.platform !== 'win32',
            env: gitEnvironment({ PWD: cwd }),
            stdio: ['ignore', stdout, stderr],
        });
        child.once('error', (error) => finish({ exitCode: 127, signal: null, spawnError: true }, error));
        child.once('exit', (exitCode, signal) => finish({ exitCode, signal, spawnError: false }));
    });
}
void main(process.argv.slice(2))
    .then((status) => {
    process.exitCode = status;
})
    .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
