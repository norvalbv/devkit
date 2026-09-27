/** How devkit invokes the consumer's vitest — binary, interrupt forwarding, consumer-owned flags.
 * Shared by coverage/produce.mts and cli/lib/baseline-status/produce.mts. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Forwarded to the vitest child so a Ctrl-C'd run leaves no run directory and no stale report. */
const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** The consumer's vitest binary, or null when this repo doesn't have one. */
export function resolveVitest(cwd: string): string | null {
  const bin = join(cwd, 'node_modules', '.bin', 'vitest');
  return existsSync(bin) ? bin : null;
}

/** How a vitest run ended. `interrupted`: the host was signalled, or the child died on a signal. */
export interface VitestRun {
  code: number;
  interrupted: boolean;
}

/**
 * Run vitest to completion and report how it ended. `interrupted` exists so a caller never mistakes
 * a Ctrl-C for a failure worth acting on — the exit code alone cannot tell them apart.
 */
export async function runVitestDetailed(
  bin: string,
  args: string[],
  cwd: string,
): Promise<VitestRun> {
  const child = spawn(bin, args, { cwd, stdio: 'inherit' });
  let interrupted = false;
  // Forwarded so a Ctrl-C leaves no run dir or stale report; removed in `finally`, since a leaked
  // listener stops the host answering SIGTERM (sc-2228).
  const forwarders = INTERRUPT_SIGNALS.map(
    (signal) =>
      [
        signal,
        () => {
          interrupted = true;
          child.kill(signal);
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
        done({ code: signal ? 1 : (exitCode ?? 1), interrupted: interrupted || signal !== null }),
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
