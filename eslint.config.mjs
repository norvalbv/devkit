/**
 * GENERATED SHIM — do not encode topology here. The folder-structure rules are compiled from the
 * `structure` block of guard.config.json by the devkit structure engine (the same spec that drives the
 * baseline walk), so the in-IDE squiggles + commit gate can't drift from the baseline. To change the
 * structure, edit guard.config.json `structure`, then regenerate baselines (`devkit init`).
 *
 * This is devkit dogfooding its own headline feature: it governs its own `.mjs` `cli/`+`gate-engine/`
 * layout via the SAME `buildStructureConfigs` the shipped universal shim uses — one source, no drift.
 */

import { buildStructureConfigs } from './gate-engine/structure/eslint-config.mts';

export default await buildStructureConfigs(process.cwd());
