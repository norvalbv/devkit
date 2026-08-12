import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sourceMatchers } from "../config.mjs";
import { LINES_BASELINE } from "./size-policy.mjs";
export function freezeLinesBaseline(root, config, oversized, mode) {
    const baselineFile = join(root, LINES_BASELINE);
    const previous = existsSync(baselineFile)
        ? JSON.parse(readFileSync(baselineFile, 'utf8')).files
        : {};
    const match = sourceMatchers(config.sourceExtensions);
    const cap = (file) => (match.isTest(file) ? config.maxTestLines : config.maxLines);
    const raised = mode === 'refresh'
        ? oversized.filter((file) => file.lines > Math.max(cap(file.file), previous[file.file] ?? 0))
        : [];
    const files = Object.fromEntries(oversized.map((file) => [
        file.file,
        mode === 'refresh' ? file.lines : Math.min(previous[file.file] ?? file.lines, file.lines),
    ]));
    if (Object.keys(files).length > 0) {
        mkdirSync(dirname(baselineFile), { recursive: true });
        writeFileSync(baselineFile, `${JSON.stringify({ maxLines: config.maxLines, maxTestLines: config.maxTestLines, files }, null, 2)}\n`);
    }
    else {
        rmSync(baselineFile, { force: true });
    }
    if (raised.length > 0) {
        console.log(`  ⚠ ${raised.length} file(s) grew since the last freeze:`);
        for (const file of raised) {
            console.log(`     ${file.file}: ${Math.max(cap(file.file), previous[file.file] ?? 0)} → ${file.lines}`);
        }
    }
    return oversized.length;
}
