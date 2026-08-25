import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LEGACY_STRUCTURE_BASELINE_DIR, STRUCTURE_BASELINE_DIR, } from '../../../gate-engine/ratchets/baseline-paths.mjs';
/** Write generated placement debt canonically and retire its legacy ESLint-owned name. */
export function persistStructureBaseline(cwd, tree, contents) {
    const canonical = join(cwd, STRUCTURE_BASELINE_DIR, `${tree}.mjs`);
    if (contents === null)
        rmSync(canonical, { force: true });
    else {
        mkdirSync(dirname(canonical), { recursive: true });
        writeFileSync(canonical, contents);
    }
    rmSync(join(cwd, LEGACY_STRUCTURE_BASELINE_DIR, `${tree}.mjs`), { force: true });
}
