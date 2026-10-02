#!/usr/bin/env node
/** Print ship's overlay root for `<root>` (see shipOverlayRoot); nothing when the repo is not overlay.
 * `--project` prints nothing: it projects that overlay into a borrowing `<root>`, exit 1 on a gap. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shipOverlayRoot } from './overlay-home.mjs';
import { projectBorrowedOverlay } from './projection-report.mjs';
const [root = process.cwd(), mode] = process.argv.slice(2);
// SAFETY: init records pkgRel ('' for a root install); shipOverlayRoot already parsed this file.
const pkgRelOf = (home) => JSON.parse(readFileSync(join(home, '.devkit/config.json'), 'utf8'))
    .pkgRel ?? '';
try {
    const overlay = shipOverlayRoot(root);
    if (mode !== '--project') {
        if (overlay)
            process.stdout.write(`${overlay}\n`);
    }
    else if (overlay && !projectBorrowedOverlay(root, overlay, pkgRelOf(overlay))) {
        console.error(`devkit: ${root} lacks the overlay's gate inputs listed above, so its gates cannot run — fix what they name, then retry (devkit doctor --fix re-checks)`);
        process.exitCode = 1;
    }
}
catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
