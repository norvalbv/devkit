// @ts-nocheck — emitted config: imports eslint-plugin-project-structure (peer-installed in THIS repo)
// + devkit's structure engine. ESLint configs aren't type-checked. Biome owns code/style; this governs
// folder/file PLACEMENT only. File/function SIZE is the guard-size ratchet's job (guard.config.json).
//
// THE UNIVERSAL SHIM — identical in every repo, regardless of "stack". It encodes NO topology. The
// folder-structure rules are COMPILED from the `structure` block of guard.config.json by devkit's
// engine (the same spec that drives the grandfather baseline walk), so the IDE squiggles + commit gate
// can't drift from the baseline. To change what's governed, edit guard.config.json `structure` (declare
// your trees + grammar) and regenerate baselines (`devkit init`). A layout devkit has never seen
// self-governs by declaring its grammar here — no per-stack template needed.
// See: node_modules/@norvalbv/devkit/docs/structure-governance.md.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStructureConfigs } from '@norvalbv/devkit/gate-engine/structure/eslint-config';

// This config sits at the repo root, so its own dir IS the repo root (cwd-independent).
export default await buildStructureConfigs(dirname(fileURLToPath(import.meta.url)));
