#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { runCliEntry } from './cli.mts';
import type { MeasurementRequest, MeasurementResult } from './time.mts';
import { parseTimeOutput, timeArguments } from './time.mts';

function readRequest(path: string): MeasurementRequest {
  const value = JSON.parse(readFileSync(path, 'utf8')) as MeasurementRequest;
  if (!isAbsolute(value.executable) || !isAbsolute(value.cwd))
    throw new Error('Measurement executable and cwd must be absolute');
  for (const output of [value.stdoutPath, value.stderrPath, value.timingPath]) {
    if (!isAbsolute(output)) throw new Error('Measurement output paths must be absolute');
  }
  return value;
}

async function measure(request: MeasurementRequest): Promise<MeasurementResult> {
  const stdout = openSync(request.stdoutPath, 'w');
  const stderr = openSync(request.stderrPath, 'w');
  const started = process.hrtime.bigint();
  try {
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const ownershipToken = process.env.DEVKIT_REVIEW_GATE_OWNER;
        const child = spawn('/usr/bin/time', timeArguments(request), {
          cwd: request.cwd,
          env: {
            ...request.environment,
            ...(ownershipToken ? { DEVKIT_REVIEW_GATE_OWNER: ownershipToken } : {}),
          },
          stdio: ['ignore', stdout, stderr],
        });
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );
    const wallSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
    const timing = parseTimeOutput(request.platform, readFileSync(request.timingPath, 'utf8'));
    return {
      wallSeconds,
      exitCode: outcome.code ?? 128,
      signal: outcome.signal,
      ...timing,
    };
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 2)
    throw new Error('Usage: measurement-child.mts <request.json> <result.json>');
  const request = readRequest(args[0] as string);
  const result = await measure(request);
  writeFileSync(args[1] as string, `${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}

runCliEntry({ importMetaUrl: import.meta.url, errorPrefix: '', errorExitCode: 125, main });
