#!/usr/bin/env node
// Usage: failing-test-files.mjs <results.json> <reference-file> <root>
// Prints the failing test files one per line, or exits 1 silently when there is nothing honest to say.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
/** The slice of vitest's undocumented results cache (format 1, vitest 5.0.4+) read here. */
const resultsCacheSchema = z.object({
    version: z.literal(1),
    projects: z.record(z.string(), z.object({ files: z.record(z.string(), z.object({ failed: z.boolean() })).optional() })),
});
// The cache is cumulative across this checkout's vitest runs, so a file counts only when every named
// project that recorded it says failed and it still exists. Any doubt returns [].
export function readFailingTestFiles(resultsPath, notBeforeMs, root) {
    try {
        if (statSync(resultsPath).mtimeMs < notBeforeMs)
            return [];
        const { projects } = resultsCacheSchema.parse(JSON.parse(readFileSync(resultsPath, 'utf8')));
        const verdicts = new Map();
        for (const [project, { files = {} }] of Object.entries(projects)) {
            if (project === '')
                continue;
            // A file moved between projects keeps its old entry, so one passing entry makes it ambiguous.
            for (const [file, { failed }] of Object.entries(files)) {
                verdicts.set(file, failed && (verdicts.get(file) ?? true));
            }
        }
        return [...verdicts]
            .filter(([file, failed]) => failed && existsSync(join(root, file)))
            .map(([file]) => file)
            .sort();
    }
    catch {
        return [];
    }
}
function main(argv) {
    const [resultsPath, referencePath, root] = argv;
    if (!resultsPath || !referencePath || !root)
        return 1;
    let notBeforeMs;
    try {
        notBeforeMs = statSync(referencePath).mtimeMs;
    }
    catch {
        return 1;
    }
    const failing = readFailingTestFiles(resultsPath, notBeforeMs, root);
    if (failing.length === 0)
        return 1;
    console.log(failing.join('\n'));
    return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    process.exitCode = main(process.argv.slice(2));
}
