#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { canonicalJson, writeAtomically } from '../history.mts';
import { runCliEntry } from './cli.mts';
import { runPerformanceExperiment } from './runner.mts';

const DEFAULT_SPEC = 'gate-engine/eval/performance/spec.json';
const DEFAULT_OUTPUT = 'gate-engine/eval/performance/results.baseline.json';

function repositoryPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith('../'))
    throw new Error(`Path escapes repository: ${path}`);
  return absolute;
}

function formattedArtifact(root: string, outputPath: string, value: unknown): string {
  const formatter = resolve(root, 'node_modules/.bin/biome');
  const result = spawnSync(formatter, ['format', '--stdin-file-path', outputPath], {
    cwd: root,
    encoding: 'utf8',
    input: canonicalJson(value),
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`Could not format benchmark artifact: ${result.stderr.trim()}`);
  return result.stdout;
}

export async function main(args: string[], cwd = process.cwd()): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      spec: { type: 'string', default: DEFAULT_SPEC },
      output: { type: 'string', default: DEFAULT_OUTPUT },
    },
    strict: true,
  });
  const root = realpathSync(resolve(cwd));
  const specPath = repositoryPath(root, parsed.values.spec as string);
  const outputPath = repositoryPath(root, parsed.values.output as string);
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as unknown;
  const result = await runPerformanceExperiment(spec, {
    sourceRoot: root,
    onProgress: (message) => console.log(`quality-gate-bench: ${message}`),
  });
  writeAtomically(outputPath, formattedArtifact(root, outputPath, result));
  console.log(`quality-gate-bench: wrote ${relative(root, outputPath)}`);
}

runCliEntry({
  importMetaUrl: import.meta.url,
  errorPrefix: 'quality-gate-bench: ',
  errorExitCode: 1,
  main,
});
