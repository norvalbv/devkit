import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackagedScriptOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** Run one of Devkit's packaged ship/review shell entrypoints with inherited stdio. */
export function runPackagedScript(
  scriptName: string,
  args: string[],
  { command, cwd, env }: PackagedScriptOptions,
): number {
  const script = fileURLToPath(new URL(`./${scriptName}`, import.meta.url));
  const result = spawnSync('bash', [script, ...args], { cwd, env, stdio: 'inherit' });
  if (result.error) {
    console.error(`${command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

const FORWARDED_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM'] as const;
type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

const SIGNAL_STATUS: Record<ForwardedSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGTERM: 143,
};

function forwardSignalToManagedGroup(
  child: ReturnType<typeof spawn>,
  signal: ForwardedSignal,
): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }

  try {
    child.kill(signal);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause;
  }
}

/** Run a managed script without letting a signal strand its child after the CLI process is targeted. */
export function runManagedPackagedScript(
  scriptName: string,
  args: string[],
  { command, cwd, env }: PackagedScriptOptions,
): Promise<number> {
  const script = fileURLToPath(new URL(`./${scriptName}`, import.meta.url));
  let signalRoot: string;
  try {
    signalRoot = mkdtempSync(join(tmpdir(), 'devkit-managed-signal-'));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`${command}: could not create private signal state: ${message}`);
    return Promise.resolve(1);
  }
  const signalLock = join(signalRoot, 'signal.lock');
  const signalStatus = join(signalRoot, 'status');

  return new Promise((resolve) => {
    let finished = false;
    let requestedSignal: ForwardedSignal | undefined;
    let child: ReturnType<typeof spawn> | undefined;

    const cleanupSignalRoot = () => {
      try {
        rmSync(signalRoot, { force: true, recursive: true });
      } catch {
        // The child is already closed; a private signal-state cleanup failure cannot change it.
      }
    };
    const finish = (status: number) => {
      if (finished) return;
      finished = true;
      resolve(status);
    };
    // The CLI calls process.exit() immediately after awaiting this promise. Keep the handlers and
    // finalization lock alive through that boundary so a last-moment signal cannot change only the
    // process status after Bash has emitted terminal telemetry.
    // Do not unregister the signal handlers in the exit listener: native termination happens only
    // after listeners return, and restoring default disposition there would reopen the same gap.
    process.once('exit', cleanupSignalRoot);
    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => {
        let ownsSignalLock = false;
        try {
          // The review shell keeps this lock once terminal telemetry begins. A later signal is past
          // the command's finalization boundary and must not make the public status diverge.
          mkdirSync(signalLock);
          ownsSignalLock = true;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return;
        }
        requestedSignal ??= signal;
        if (ownsSignalLock) {
          try {
            writeFileSync(signalStatus, `${SIGNAL_STATUS[requestedSignal]}\n`, { mode: 0o600 });
          } catch {
            // Bash still receives the signal directly; this file only closes the cleanup handoff.
          } finally {
            rmSync(signalLock, { force: true, recursive: true });
          }
        }
        if (child) {
          try {
            forwardSignalToManagedGroup(child, signal);
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            console.error(`${command}: could not forward ${signal}: ${message}`);
          }
        }
      };
      process.on(signal, handler);
    }

    try {
      child = spawn('bash', [script, ...args], {
        cwd,
        env: { ...env, DEVKIT_MANAGED_SIGNAL_ROOT: signalRoot },
        stdio: 'inherit',
        // A dedicated process group lets a signal interrupt foreground setup helpers too.
        detached: process.platform !== 'win32',
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`${command}: ${message}`);
      finish(requestedSignal ? SIGNAL_STATUS[requestedSignal] : 1);
      return;
    }
    if (requestedSignal) forwardSignalToManagedGroup(child, requestedSignal);

    child.once('error', (error) => {
      console.error(`${command}: ${error.message}`);
      finish(requestedSignal ? SIGNAL_STATUS[requestedSignal] : 1);
    });
    child.once('close', (status, signal) => {
      if (requestedSignal) return finish(SIGNAL_STATUS[requestedSignal]);
      if (status !== null) return finish(status);
      const forwarded =
        signal && FORWARDED_SIGNALS.includes(signal as ForwardedSignal)
          ? (signal as ForwardedSignal)
          : undefined;
      finish(forwarded ? SIGNAL_STATUS[forwarded] : 1);
    });
  });
}
