/** Grandfather the current tree into the structure + import-wall baselines; package and overlay share it. */
import { loadImportWallExempt } from '../../../gate-engine/structure/load-baseline.mjs';
import { firstLine } from '../standalone.mjs';
import { generateImportWallBaseline } from './generate-import-wall-baseline.mjs';
import { generateStructureBaselines } from './generate-structure-baseline.mjs';
/** A generator failure is printed, never thrown: the install around it must still finish. */
export async function cutStructureBaselines(cwd, stack) {
    const opts = { log: (m) => console.log(m) };
    try {
        await generateStructureBaselines(cwd, opts);
    }
    catch (e) {
        console.log(`  ! structure baseline generator failed: ${firstLine(e)}`);
    }
    try {
        // An exempt file is a permanent allowance, not a violator: never grandfather it.
        generateImportWallBaseline(cwd, {
            ...opts,
            exemptPatterns: await loadImportWallExempt(cwd),
        });
    }
    catch (e) {
        console.log(`  ! import-wall baseline generator skipped: ${firstLine(e)}`);
        console.log(`    (install deps — bun install — then re-run \`devkit init --stack ${stack}\`)`);
    }
}
