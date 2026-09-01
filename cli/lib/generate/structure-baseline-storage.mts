import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  LEGACY_STRUCTURE_BASELINE_DIR,
  STRUCTURE_BASELINE_DIR,
} from '../../../gate-engine/ratchets/baseline-paths.mts';

/** Write generated placement debt canonically and discard any stale retired copy. */
export function persistStructureBaseline(cwd: string, tree: string, contents: string | null): void {
  const canonical = join(cwd, STRUCTURE_BASELINE_DIR, `${tree}.mjs`);
  if (contents === null) rmSync(canonical, { force: true });
  else {
    mkdirSync(dirname(canonical), { recursive: true });
    writeFileSync(canonical, contents);
  }
  // A surviving retired copy would be migrated back by the next init/upgrade (sc-2256).
  rmSync(join(cwd, LEGACY_STRUCTURE_BASELINE_DIR, `${tree}.mjs`), { force: true });
}
