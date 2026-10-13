#!/usr/bin/env node
// Usage: failing-test-files.mjs <results.json> <reference-file> <root>
// Prints the failing test files one per line, or exits 1 silently when there is nothing honest to say.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const fileVerdict = z.object({ failed: z.boolean() });

/** One flat-cache entry as a row; a key with no project yields an empty one. */
function flatRow([key, { failed }]: [string, { failed: boolean }]) {
  const separator = key.indexOf(':');
  return [key.slice(0, Math.max(separator, 0)), key.slice(separator + 1), failed] as const;
}

/** The slice of vitest's undocumented results cache this reader depends on, as [project, file, failed] rows. */
const resultsCacheSchema = z.union([
  z
    .object({ results: z.array(z.tuple([z.string(), fileVerdict])) })
    .transform((cache) => cache.results.map(flatRow)),
  // vitest 5.0.4 and later nest each file under its project instead.
  z
    .object({
      projects: z.record(z.string(), z.object({ files: z.record(z.string(), fileVerdict) })),
    })
    .transform((cache) =>
      Object.entries(cache.projects).flatMap(([project, { files }]) =>
        Object.entries(files).map(([file, { failed }]) => [project, file, failed] as const),
      ),
    ),
]);

// The cache is cumulative and shared by every vitest config, so a file counts only when every named
// project that recorded it says failed and it still exists. Any doubt returns [].
export function readFailingTestFiles(
  resultsPath: string,
  notBeforeMs: number,
  root: string,
): string[] {
  try {
    if (statSync(resultsPath).mtimeMs < notBeforeMs) return [];
    const rows = resultsCacheSchema.parse(JSON.parse(readFileSync(resultsPath, 'utf8')));
    const verdicts = new Map<string, boolean>();
    for (const [project, file, failed] of rows) {
      if (!project) continue;
      // A file moved between projects keeps its old key, so one passing entry makes it ambiguous.
      verdicts.set(file, failed && (verdicts.get(file) ?? true));
    }
    return [...verdicts]
      .filter(([file, failed]) => failed && existsSync(join(root, file)))
      .map(([file]) => file)
      .sort();
  } catch {
    return [];
  }
}

function main(argv: string[]): number {
  const [resultsPath, referencePath, root] = argv;
  if (!resultsPath || !referencePath || !root) return 1;
  let notBeforeMs: number;
  try {
    notBeforeMs = statSync(referencePath).mtimeMs;
  } catch {
    return 1;
  }
  const failing = readFailingTestFiles(resultsPath, notBeforeMs, root);
  if (failing.length === 0) return 1;
  console.log(failing.join('\n'));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
