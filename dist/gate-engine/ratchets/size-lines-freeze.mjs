import { sourceMatchers } from '../config.mjs';
import { LEGACY_LINES_BASELINE, readRatchetBaseline, removeRatchetBaseline, writeRatchetBaseline, } from './baseline-paths.mjs';
import { LINES_BASELINE } from './size-policy.mjs';
import { lineBaselineFilesOrExit } from './size-line-authority.mjs';
export function freezeLinesBaseline(root, config, oversized, mode) {
    const baseline = readRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE);
    const previous = lineBaselineFilesOrExit(baseline?.contents ?? null, baseline?.relativePath ?? LINES_BASELINE, 'guard-size freeze unavailable');
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
        writeRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE, `${JSON.stringify({ maxLines: config.maxLines, maxTestLines: config.maxTestLines, files }, null, 2)}\n`);
    }
    else {
        removeRatchetBaseline(root, LINES_BASELINE, LEGACY_LINES_BASELINE);
    }
    if (raised.length > 0) {
        console.log(`  ⚠ ${raised.length} file(s) grew since the last freeze:`);
        for (const file of raised) {
            console.log(`     ${file.file}: ${Math.max(cap(file.file), previous[file.file] ?? 0)} → ${file.lines}`);
        }
    }
    return oversized.length;
}
