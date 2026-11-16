/** How devkit invokes the consumer's vitest — binary, interrupt forwarding, consumer-owned flags.
 * Shared by coverage/produce.mts and cli/lib/baseline-status/produce.mts. */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Forwarded to the vitest child so a Ctrl-C'd run leaves no run directory and no stale report. */
const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** A detached group no longer receives the terminal's own signals, so group mode forwards these. */
const GROUP_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM'] as const;

/** 128 + SIGINT/SIGTERM: vitest traps both and exits with these instead of dying on the signal. */
const TRAPPED_SIGNAL_EXIT_CODES = new Set([130, 143]);

/** The consumer's vitest binary, or null when this repo doesn't have one. */
export function resolveVitest(cwd: string): string | null {
  const bin = join(cwd, 'node_modules', '.bin', 'vitest');
  return existsSync(bin) ? bin : null;
}

/** How a vitest run ended. `interrupted`: the host was signalled, the child died on a signal, or
 * the child exited with the code vitest uses after trapping SIGINT/SIGTERM. */
export interface VitestRun {
  code: number;
  interrupted: boolean;
}

/** Signal vitest, or its whole process group when it was spawned detached. */
function signalVitest(child: ChildProcess, signal: NodeJS.Signals, grouped: boolean): void {
  if (!grouped || child.pid === undefined) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH: the group is gone. EPERM: macOS reports it while still reaping the group.
  }
}

interface RunOptions {
  /** Run vitest as its own process group and signal the group: its fork workers outlive a
   * signal sent only to the main process. */
  group?: boolean;
}

/**
 * Run vitest to completion and report how it ended. `interrupted` exists so a caller never mistakes
 * a Ctrl-C for a failure worth acting on — the code alone cannot tell them apart once a test failed.
 */
export async function runVitestDetailed(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  { group = false }: RunOptions = {},
): Promise<VitestRun> {
  const grouped = group && process.platform !== 'win32';
  const child = spawn(bin, args, { cwd, env, stdio: 'inherit', detached: grouped });
  let interrupted = false;
  // Forwarded so a Ctrl-C leaves no run dir or stale report; removed in `finally`, since a leaked
  // listener stops the host answering SIGTERM (sc-2228).
  const forwarders = (grouped ? GROUP_SIGNALS : INTERRUPT_SIGNALS).map(
    (signal) =>
      [
        signal,
        () => {
          interrupted = true;
          signalVitest(child, signal, grouped);
        },
      ] as const,
  );
  for (const [signal, forward] of forwarders) process.on(signal, forward);
  try {
    return await new Promise<VitestRun>((done) => {
      child.on('error', (err) => {
        console.error(`🚫 could not start vitest: ${err.message}`);
        done({ code: 1, interrupted });
      });
      // `signal ? 1` matters: a killed child reports exitCode null, which `?? 1` alone would keep,
      // but an explicit 0 from a child that was ALSO signalled must not read as success.
      child.on('close', (exitCode, signal) =>
        done({
          code: signal ? 1 : (exitCode ?? 1),
          interrupted:
            interrupted || signal !== null || TRAPPED_SIGNAL_EXIT_CODES.has(exitCode ?? 0),
        }),
      );
    });
  } finally {
    for (const [signal, forward] of forwarders) process.off(signal, forward);
  }
}

/**
 * Run vitest to completion and return the code the caller should exit with.
 *
 * Shared with cli/lib/baseline-status/produce.mts, devkit's other vitest runner.
 */
export async function runVitest(bin: string, args: string[], cwd: string): Promise<number> {
  return (await runVitestDetailed(bin, args, cwd)).code;
}

/** `vitest run` ignores every token after a `--`, so a forwarded one would silently drop the filters. */
export function withoutSeparators(argv: string[]): string[] {
  return argv.filter((arg) => arg !== '--');
}

/** ANY retry spelling means the consumer owns it (`--retry=0` is the opt-out); vitest 4.1.10 crashes
 * on `--retry=1` alongside `--retry.condition`, so every spelling must count. */
export function ownsRetry(argv: string[]): boolean {
  return argv.some((arg) => /^--(?:no-)?retry(?:[.=]|$)/.test(arg));
}

/**
 * The consumer already set the budget the re-run would change, so the re-run is theirs to decide.
 * Both vitest spellings count (cac accepts camelCase and kebab-case), with `=` or a separate value.
 */
export function ownsTimeoutBudget(argv: string[]): boolean {
  return argv.some((arg) =>
    /^--(?:testTimeout|test-timeout|hookTimeout|hook-timeout|maxWorkers|max-workers)(?:=|$)/.test(
      arg,
    ),
  );
}

/** Same courtesy for reporters: a consumer who chose their own output does not get ours bolted on. */
export function ownsReporter(argv: string[]): boolean {
  return argv.some((arg) => /^--(?:reporter|outputFile)(?:[.=]|$)/.test(arg));
}
