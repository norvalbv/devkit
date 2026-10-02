#!/usr/bin/env node
/**
 * Post-build asset copy: `tsc -p tsconfig.build.json` emits ONLY the compiled .mjs (cli/ +
 * gate-engine/). The shipped package must be self-contained under dist/ — because devkit runs from a
 * consumer's node_modules and `packageDir()` resolves to dist/ there, EVERY non-TS asset it reads
 * (templates, skills, agents, agent-hooks, the shared biome/tsconfig configs, package.json for the
 * version) plus every .sh/.json a gate spawns/reads must be mirrored into dist/. Ships nothing but
 * dist/ (package.json `files`), so exports/bin all point under dist/.
 *
 * Run by `bun run build` after tsc. Idempotent. `--out <dir>` retargets every write (sources are
 * always read from the repo): the e2e harness builds into a tmp stage with it, because the repo's
 * dist/ is committed on release commits only and a test run must not rewrite it (sc-3220).
 */
import { cpSync, existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ANTI_SLOP_FILES, ROOT_DIRS, ROOT_FILES, shippedTreeFiles } from './shipped-assets.mjs';

/** `p` with symlinks resolved through its nearest existing ancestor (the rest may not exist yet). */
function physicalPath(p) {
  const missing = [];
  let head = p;
  while (!existsSync(head) && dirname(head) !== head) {
    missing.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync(head), ...missing);
}

/** Whether `child` is `parent` or lies beneath it. Both absolute. */
function within(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The directory every write targets: `--out <dir>` resolved against `cwd`, else `<root>/dist`.
 * Throws on an unknown argument or an option-shaped value (a mistyped `--out=x` or `--out --x` must
 * not fall back to, or land somewhere beside, the repo's dist) and on an out dir that overlaps the
 * repo other than `<root>/dist` itself — the mirrors `rm -rf` their destination, so `--out .`,
 * `--out templates/x`, or a parent of the repo would delete or recurse into source. The overlap is
 * judged on physical paths, so a symlink pointing into the repo cannot slip past it.
 */
export function resolveDistDir(argv, root, cwd = process.cwd()) {
  let out;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--out') throw new Error(`unknown argument '${argv[i]}' (usage: [--out <dir>])`);
    const value = argv[++i];
    if (!value || value.startsWith('-')) throw new Error(`--out needs a directory, got '${value ?? ''}'`);
    out = resolve(cwd, value);
  }
  const fallback = join(root, 'dist');
  if (out === undefined) return fallback;
  const realRoot = physicalPath(root);
  const realOut = physicalPath(out);
  if (realOut === join(realRoot, 'dist')) return fallback;
  if (within(realRoot, realOut) || within(realOut, realRoot)) {
    throw new Error(
      `--out ${out} overlaps the repo (${realOut}); use ${fallback} or a directory outside it`,
    );
  }
  return out;
}

/** Mirror every non-TS shipped asset from `root` into `dist`, which tsc has already emitted into. */
export function copyDistAssets(root, dist) {
  for (const compiled of ['cli', 'gate-engine', join('anti-slop', 'src')]) {
    if (!existsSync(join(dist, compiled))) {
      throw new Error(
        `${join(dist, compiled)} is missing compiled output — run \`tsc -p tsconfig.build.json\` first.`,
      );
    }
  }

  for (const d of ROOT_DIRS) {
    // These are mirrors, not overlays. Clear the destination first so renamed or removed templates
    // cannot survive in the published package after disappearing from the source tree.
    rmSync(join(dist, d), { recursive: true, force: true });
    cpSync(join(root, d), join(dist, d), { recursive: true });
  }
  for (const f of ROOT_FILES) if (existsSync(join(root, f))) cpSync(join(root, f), join(dist, f));
  for (const f of ANTI_SLOP_FILES)
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const dist = resolveDistDir(process.argv.slice(2), root);
    copyDistAssets(root, dist);
    console.log(`copy-dist-assets: ${dist} is now a self-contained package.`);
  } catch (err) {
    console.error(`copy-dist-assets: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
