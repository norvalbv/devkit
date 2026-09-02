#!/usr/bin/env node
/**
 * Post-build asset copy: `tsc -p tsconfig.build.json` emits ONLY the compiled .mjs (cli/ +
 * gate-engine/). The shipped package must be self-contained under dist/ — because devkit runs from a
 * consumer's node_modules and `packageDir()` resolves to dist/ there, EVERY non-TS asset it reads
 * (templates, skills, agents, agent-hooks, the shared biome/tsconfig configs, package.json for the
 * version) plus every .sh/.json a gate spawns/reads must be mirrored into dist/. Ships nothing but
 * dist/ (package.json `files`), so exports/bin all point under dist/.
 *
 * Run by `bun run build` after tsc. Idempotent.
 */
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT_DIRS, shippedTreeFiles } from './shipped-assets.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'cli')) || !existsSync(join(dist, 'gate-engine'))) {
  console.error('copy-dist-assets: dist/ is missing compiled output — run `tsc -p tsconfig.build.json` first.');
  process.exit(1);
}

const ROOT_FILES = ['package.json', 'README.md'];
for (const d of ROOT_DIRS) {
  // These are mirrors, not overlays. Clear the destination first so renamed or removed templates
  // cannot survive in the published package after disappearing from the source tree.
  rmSync(join(dist, d), { recursive: true, force: true });
  cpSync(join(root, d), join(dist, d), { recursive: true });
}
for (const f of ROOT_FILES) if (existsSync(join(root, f))) cpSync(join(root, f), join(dist, f));
for (const f of ['LICENSE', 'UPSTREAM.md'])
  cpSync(join(root, 'anti-slop', f), join(dist, 'anti-slop', f));
for (const entry of readdirSync(join(dist, 'anti-slop', 'src'), {
  recursive: true,
  withFileTypes: true,
})) {
  if (entry.isFile() && entry.name.endsWith('.ts')) rmSync(join(entry.parentPath, entry.name));
}

// Non-TS files that live UNDER cli/ or gate-engine/ (the .sh ship scripts, config .json) — mirror
// each to its dist/ path. tsc never emits these. Skip tests + eval (dev-only, not shipped-run).
const COPY_EXT = /\.(sh|json|jsonc)$/;
for (const rel of shippedTreeFiles(root, COPY_EXT)) cpSync(join(root, rel), join(dist, rel));

console.log('copy-dist-assets: dist/ is now a self-contained package.');
