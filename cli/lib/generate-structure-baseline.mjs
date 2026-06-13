#!/usr/bin/env node
/**
 * Folder-structure baseline generator — the grandfather lists for
 * eslint-plugin-project-structure's folder-structure rule, one per process tree
 * (renderer / main / shared / preload / socket / vercel).
 *
 * WHY A MANUAL TREE-WALKER (not eslint scan mode): the folder-structure rule
 * DEDUPS its findings by errorMessage. `enforceExistence` collapses N offending
 * files in one folder to a SINGLE message, so an eslint-scan generator
 * UNDER-REPORTS — it would miss every-file-but-one in a broken folder. This
 * walker reproduces the plugin's rules by hand so it can capture EVERY violator.
 * (The import-wall generator is the opposite case — its debugMode makes each
 * message file-unique, so scan mode is correct there.)
 *
 * PARAMETERIZED (W-3): the walk shapes are faithful to frink's
 * scripts/generate-eslint-baseline.mjs, but the structureRoots + lib-domain
 * registries + main root-folders are read from the CONSUMER's emitted config
 * (eslint/domains.mjs) and resolved against the CONSUMER cwd, never the package
 * dir. Each tree's walk is existsSync-guarded so a repo missing (say) a
 * socket-server still generates the trees it does have.
 *
 * Output: one `eslint/baselines/<tree>.mjs` per existing tree (overwritten).
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ─── Regexes (verbatim from frink's generate-eslint-baseline.mjs) ───────────────
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const HOOK_KEBAB = /^use-[a-z][a-z0-9-]*\.tsx?$/;
const HOOK_CAMEL = /^use[A-Z][a-zA-Z0-9]*\.tsx?$/;
const HOOK_PASCAL_FOLDER = /^use[A-Z][a-zA-Z0-9]*$/;
const TEST = /\.(test|spec)\.tsx?$/;
const ANY_CSS = /\.css$/;
const KEBAB_TS = /^[a-z][a-z0-9-]*\.ts$/;
const KEBAB_TEST = /^[a-z][a-z0-9-]*\.(test|spec)\.ts$/;
const KEBAB_FOLDER = /^[a-z][a-z0-9-]*$/;
const VERCEL_ROUTE = /^([a-z][a-z0-9-]*|\[[a-zA-Z][a-zA-Z0-9]*\])\.ts$/;
const KEBAB_TSX = /^[a-z][a-z0-9-]*\.tsx$/;
const KEBAB_TEST_TSX = /^[a-z][a-z0-9-]*\.(test|spec)\.tsx?$/;
const KEBAB_TEST_DOTTED = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\.(test|spec)\.ts$/;

const ALLOWED_TOP = new Set(['App.tsx', 'main.tsx', 'wdyr.ts', 'index.html', 'login.html']);
const ALLOWED_COMPONENT_SIBLINGS = new Set(['index.tsx', 'index.ts', 'constants.ts', 'types.ts']);

const IGNORED_DIRS = new Set(['assets', 'public', 'styles', 'icons']);
// FROZEN legacy dirs (eslint.config.mjs: children []) — every existing file is
// grandfathered debt; anything new fails lint until it migrates to lib//app/.
const FROZEN_DIRS = new Set(['contexts', 'constants', 'types', 'utils']);

// Per-tree default relative roots. A consumer's config can override (W-3) but
// these mirror the electron-stack layout the template ships.
export const DEFAULT_ROOTS = Object.freeze({
  renderer: 'src/renderer',
  main: 'src/main',
  shared: 'src/shared',
  preload: 'src/preload',
  socket: 'socket-server/src',
  vercel: 'vercel-serverless',
});

// (label, exportName) per tree — matches frink's committed baseline headers/exports.
const TREE_META = Object.freeze({
  renderer: { label: 'renderer', exportName: 'rendererStructureBaseline' },
  main: { label: 'src/main', exportName: 'mainStructureBaseline' },
  shared: { label: 'src/shared', exportName: 'sharedStructureBaseline' },
  preload: { label: 'src/preload', exportName: 'preloadStructureBaseline' },
  socket: { label: 'socket-server/src', exportName: 'socketStructureBaseline' },
  vercel: { label: 'vercel-serverless', exportName: 'vercelStructureBaseline' },
});

// Skip folder-level entries — grandfather EXISTING files only. New files added
// under the same legacy folder must still fail.
function add(out, p) {
  if (p.endsWith('/')) return;
  out.add(p);
}

function collect(walker) {
  const set = new Set();
  walker(set);
  return [...set].sort();
}

// ─── renderer ──────────────────────────────────────────────────────────────────
function makeRendererWalker(root, domains) {
  const RENDERER_LIB_DOMAINS = domains.RENDERER_LIB_DOMAINS ?? [];

  function walkRenderer(out) {
    const top = readdirSync(root, { withFileTypes: true });
    for (const e of top) {
      if (e.isFile()) {
        if (!ALLOWED_TOP.has(e.name)) add(out, `${e.name}`);
        continue;
      }
      if (IGNORED_DIRS.has(e.name)) continue;
      if (FROZEN_DIRS.has(e.name)) {
        walkFrozen(out, e.name);
        continue;
      }
      if (e.name === 'components') {
        walkComponentTree(out, `${e.name}`, false, false);
      } else if (e.name === 'features') {
        walkFeatures(out, `${e.name}`);
      } else if (e.name === 'hooks') {
        walkHooks(out, `${e.name}`);
      } else if (e.name === 'lib') {
        walkLib(out, `${e.name}`);
      } else {
        add(out, `${e.name}/`);
      }
    }
  }

  function walkFeatures(out, rel) {
    const abs = join(root, rel);
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const childRel = `${rel}/${e.name}`;
      if (e.isFile()) {
        add(out, childRel);
        continue;
      }
      if (!KEBAB_FOLDER.test(e.name)) {
        walkComponentTree(out, childRel, true, false);
        continue;
      }
      walkFeatureModule(out, childRel);
    }
  }

  function walkFeatureModule(out, rel) {
    const abs = join(root, rel);
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const childRel = `${rel}/${e.name}`;
      if (e.isFile()) {
        if (e.name === 'index.ts' || e.name === 'index.tsx' || e.name === 'constants.ts') continue;
        add(out, childRel);
        continue;
      }
      if (!PASCAL.test(e.name)) {
        walkComponentTree(out, childRel, true, false);
        continue;
      }
      walkComponentTree(out, childRel, false, false);
    }
  }

  function walkComponentTree(out, rel, ancestorKebab, ancestorBroken) {
    const abs = join(root, rel);
    const entries = readdirSync(abs, { withFileTypes: true });
    const isTopLevel = rel === 'components' || rel === 'features';
    const isComponentFolder = !ancestorKebab && !isTopLevel;
    const missingIndex =
      isComponentFolder && !entries.some((e) => e.isFile() && e.name === 'index.tsx');
    const broken = ancestorBroken || missingIndex;
    for (const e of entries) {
      const childRel = `${rel}/${e.name}`;
      if (e.isFile()) {
        if (rel.startsWith('components/ui')) continue;
        if (broken) {
          add(out, childRel);
          continue;
        }
        if (ancestorKebab) {
          add(out, childRel);
          continue;
        }
        if (isTopLevel) {
          add(out, childRel);
          continue;
        }
        if (TEST.test(e.name)) continue;
        if (ANY_CSS.test(e.name)) continue;
        if (ALLOWED_COMPONENT_SIBLINGS.has(e.name)) continue;
        add(out, childRel);
        continue;
      }
      if (e.name === '__tests__') {
        if (ancestorKebab || broken) {
          for (const t of readdirSync(join(root, childRel))) {
            if (TEST.test(t)) add(out, `${childRel}/${t}`);
          }
        }
        continue;
      }
      if (e.name === 'ui' && rel === 'components') continue;
      const childKebab = ancestorKebab || !PASCAL.test(e.name);
      if (!ancestorKebab && !PASCAL.test(e.name)) add(out, `${childRel}/`);
      walkComponentTree(out, childRel, childKebab, broken);
    }
  }

  function walkHooks(out, rel) {
    const abs = join(root, rel);
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const childRel = `${rel}/${e.name}`;
      if (e.isFile()) {
        if (TEST.test(e.name)) continue;
        if (HOOK_KEBAB.test(e.name)) continue;
        if (HOOK_CAMEL.test(e.name)) continue;
        add(out, childRel);
        continue;
      }
      if (HOOK_PASCAL_FOLDER.test(e.name)) {
        for (const h of readdirSync(join(root, childRel), { withFileTypes: true })) {
          if (h.isDirectory()) continue;
          if (h.name === 'index.ts' || h.name === 'index.tsx') continue;
          if (TEST.test(h.name)) continue;
          add(out, `${childRel}/${h.name}`);
        }
        continue;
      }
      add(out, `${childRel}/`);
    }
  }

  function walkLib(out, rel) {
    const abs = join(root, rel);
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isFile()) {
        if (e.name === 'index.ts') continue;
        add(out, `${rel}/${e.name}`);
        continue;
      }
      const broken = !RENDERER_LIB_DOMAINS.includes(e.name);
      walkKebabTree(out, root, `${rel}/${e.name}`, broken, libFileAllowed, KEBAB_TEST_TSX);
    }
  }

  function walkFrozen(out, rel) {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.isFile()) add(out, `${rel}/${e.name}`);
      else walkFrozen(out, `${rel}/${e.name}`);
    }
  }

  return walkRenderer;
}

function libFileAllowed(name) {
  return (
    name === 'index.ts' ||
    name === 'index.tsx' ||
    name === 'constants.ts' ||
    name === 'types.ts' ||
    KEBAB_TS.test(name) ||
    KEBAB_TSX.test(name) ||
    KEBAB_TEST_TSX.test(name) ||
    HOOK_KEBAB.test(name) ||
    ANY_CSS.test(name)
  );
}

// Shared recursive walker for the kebab-module trees (renderer lib + shared +
// socket): per-tree policy injected as the base dir + file-allow + __tests__ regex.
function walkKebabTree(out, base, rel, broken, fileAllowed, testRegex) {
  const abs = join(base, rel);
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const childRel = `${rel}/${e.name}`;
    if (e.isFile()) {
      if (!broken && fileAllowed(e.name)) continue;
      add(out, childRel);
      continue;
    }
    if (e.name === '__tests__') {
      for (const t of readdirSync(join(abs, e.name))) {
        if (!broken && testRegex.test(t)) continue;
        add(out, `${childRel}/${t}`);
      }
      continue;
    }
    walkKebabTree(
      out,
      base,
      childRel,
      broken || !KEBAB_FOLDER.test(e.name),
      fileAllowed,
      testRegex,
    );
  }
}

// ─── main ────────────────────────────────────────────────────────────────────
function makeMainWalker(root, domains) {
  const MAIN_ROOT_FOLDERS = domains.MAIN_ROOT_FOLDERS ?? [];
  const MAIN_LIB_DOMAINS = domains.MAIN_LIB_DOMAINS ?? [];

  function walkMain(out) {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isFile()) {
        if (e.name === 'index.ts' || e.name === 'constants.ts') continue;
        add(out, e.name);
        continue;
      }
      if (e.name === 'lib') {
        walkMainLib(out);
      } else if (MAIN_ROOT_FOLDERS.includes(e.name)) {
        walkMainDir(out, e.name, false, false);
      } else {
        walkMainDir(out, e.name, false, true);
      }
    }
  }

  function walkMainLib(out) {
    for (const e of readdirSync(join(root, 'lib'), { withFileTypes: true })) {
      const childRel = `lib/${e.name}`;
      if (e.isFile()) {
        if (e.name === 'index.ts') continue;
        add(out, childRel);
        continue;
      }
      const registered = MAIN_LIB_DOMAINS.includes(e.name);
      walkMainDir(out, childRel, false, !registered);
    }
  }

  function walkMainDir(out, rel, isRoot, ancestorBroken) {
    const abs = rel ? join(root, rel) : root;
    const entries = readdirSync(abs, { withFileTypes: true });
    const missingIndex = !entries.some((e) => e.isFile() && e.name === 'index.ts');
    const broken = ancestorBroken || missingIndex;
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile()) {
        if (broken) {
          add(out, childRel);
          continue;
        }
        if (e.name === 'index.ts' || e.name === 'constants.ts') continue;
        if (isRoot) {
          add(out, childRel);
          continue;
        }
        if (KEBAB_TS.test(e.name)) continue;
        if (KEBAB_TEST.test(e.name)) continue;
        add(out, childRel);
        continue;
      }
      if (e.name === '__tests__') {
        for (const t of readdirSync(join(abs, e.name))) {
          if (broken) {
            add(out, `${childRel}/${t}`);
            continue;
          }
          if (KEBAB_TEST.test(t)) continue;
          add(out, `${childRel}/${t}`);
        }
        continue;
      }
      if (!KEBAB_FOLDER.test(e.name)) add(out, `${childRel}/`);
      walkMainDir(out, childRel, false, broken);
    }
  }

  return walkMain;
}

// ─── shared ────────────────────────────────────────────────────────────────────
function makeSharedWalker(root) {
  function walkShared(out) {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isFile()) {
        if (sharedFileAllowed(e.name)) continue;
        add(out, e.name);
        continue;
      }
      const broken = !KEBAB_FOLDER.test(e.name);
      walkKebabTree(out, root, e.name, broken, sharedFileAllowed, KEBAB_TEST_DOTTED);
    }
  }
  return walkShared;
}

function sharedFileAllowed(name) {
  return (
    name === 'index.ts' ||
    name === 'constants.ts' ||
    name === 'types.ts' ||
    KEBAB_TS.test(name) ||
    KEBAB_TEST_DOTTED.test(name)
  );
}

// ─── preload ───────────────────────────────────────────────────────────────────
function makePreloadWalker(root) {
  function walkPreload(out) {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isFile()) {
        if (preloadFileAllowed(e.name)) continue;
        add(out, e.name);
        continue;
      }
      if (e.name === '__tests__') {
        for (const t of readdirSync(join(root, e.name))) {
          if (KEBAB_TEST_DOTTED.test(t)) continue;
          add(out, `${e.name}/${t}`);
        }
        continue;
      }
      walkPreloadBroken(out, e.name);
    }
  }

  function walkPreloadBroken(out, rel) {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const childRel = `${rel}/${e.name}`;
      if (e.isFile()) add(out, childRel);
      else walkPreloadBroken(out, childRel);
    }
  }

  return walkPreload;
}

function preloadFileAllowed(name) {
  return (
    name === 'index.ts' ||
    name === 'index.d.ts' ||
    name === 'constants.ts' ||
    KEBAB_TS.test(name) ||
    KEBAB_TEST_DOTTED.test(name)
  );
}

// ─── socket-server ───────────────────────────────────────────────────────────
function makeSocketWalker(root, domains) {
  const SOCKET_LIB_DOMAINS = domains.SOCKET_LIB_DOMAINS ?? [];

  function walkSocketServer(out) {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isFile()) {
        if (e.name === 'index.ts' || e.name === 'constants.ts') continue;
        if (KEBAB_TEST_DOTTED.test(e.name)) continue;
        add(out, e.name);
        continue;
      }
      if (e.name === 'types') {
        for (const t of readdirSync(join(root, 'types'))) {
          if (KEBAB_TS.test(t) || KEBAB_TEST_DOTTED.test(t)) continue;
          add(out, `types/${t}`);
        }
      } else if (e.name === 'api') {
        for (const a of readdirSync(join(root, 'api'), { withFileTypes: true })) {
          if (a.isFile()) {
            if (a.name === 'router.ts') continue;
            add(out, `api/${a.name}`);
          } else if (a.name === 'routes') {
            walkKebabTree(out, root, 'api/routes', false, socketFileAllowed, KEBAB_TEST_DOTTED);
          } else {
            walkKebabTree(out, root, `api/${a.name}`, true, socketFileAllowed, KEBAB_TEST_DOTTED);
          }
        }
      } else if (e.name === 'lib') {
        for (const l of readdirSync(join(root, 'lib'), { withFileTypes: true })) {
          const childRel = `lib/${l.name}`;
          if (l.isFile()) {
            if (l.name === 'index.ts') continue;
            add(out, childRel);
            continue;
          }
          const broken = !SOCKET_LIB_DOMAINS.includes(l.name);
          walkKebabTree(out, root, childRel, broken, socketFileAllowed, KEBAB_TEST_DOTTED);
        }
      } else {
        walkKebabTree(out, root, e.name, true, socketFileAllowed, KEBAB_TEST_DOTTED);
      }
    }
  }

  return walkSocketServer;
}

function socketFileAllowed(name) {
  return (
    name === 'index.ts' ||
    name === 'constants.ts' ||
    name === 'types.ts' ||
    KEBAB_TS.test(name) ||
    KEBAB_TEST_DOTTED.test(name)
  );
}

// ─── vercel-serverless ─────────────────────────────────────────────────────────
function makeVercelWalker(root, domains) {
  const VERCEL_LIB_DOMAINS = domains.VERCEL_LIB_DOMAINS ?? [];

  function walkVercel(out) {
    if (existsSync(join(root, 'api'))) walkVercelApi(out, 'api', false);
    if (!existsSync(join(root, 'lib'))) return;
    for (const l of readdirSync(join(root, 'lib'), { withFileTypes: true })) {
      const childRel = `lib/${l.name}`;
      if (l.isFile()) {
        if (l.name === 'index.ts') continue;
        add(out, childRel);
        continue;
      }
      const broken = !VERCEL_LIB_DOMAINS.includes(l.name);
      walkVercelLibDomain(out, childRel, broken);
    }
  }

  function walkVercelLibDomain(out, rel, broken) {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const childRel = `${rel}/${e.name}`;
      if (e.isFile()) {
        if (!broken && vercelLibFileAllowed(e.name)) continue;
        add(out, childRel);
        continue;
      }
      if (e.name === '__fixtures__' || e.name === '__snapshots__') {
        if (broken) walkAllFiles(out, childRel);
        continue;
      }
      if (e.name === '__tests__') {
        for (const t of readdirSync(join(root, childRel))) {
          if (!broken && KEBAB_TEST_DOTTED.test(t)) continue;
          add(out, `${childRel}/${t}`);
        }
        continue;
      }
      walkVercelLibDomain(out, childRel, broken || !KEBAB_FOLDER.test(e.name));
    }
  }

  function walkAllFiles(out, rel) {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.isFile()) add(out, `${rel}/${e.name}`);
      else walkAllFiles(out, `${rel}/${e.name}`);
    }
  }

  function walkVercelApi(out, rel, broken) {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const childRel = `${rel}/${e.name}`;
      if (e.isFile()) {
        if (!broken && (VERCEL_ROUTE.test(e.name) || KEBAB_TEST_DOTTED.test(e.name))) continue;
        add(out, childRel);
        continue;
      }
      walkVercelApi(out, childRel, broken || !KEBAB_FOLDER.test(e.name));
    }
  }

  return walkVercel;
}

function vercelLibFileAllowed(name) {
  return socketFileAllowed(name);
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute the grandfather list for ONE tree. Returns a sorted string[] of
 * tree-relative violator paths (empty if the tree doesn't exist on disk).
 *
 * @param {string} tree one of renderer|main|shared|preload|socket|vercel
 * @param {string} cwd consumer repo root
 * @param {{roots?:object, domains?:object}} [opts] roots override + domain registries
 */
export function generateTreeBaseline(tree, cwd, opts = {}) {
  const roots = { ...DEFAULT_ROOTS, ...(opts.roots ?? {}) };
  const domains = opts.domains ?? {};
  const root = join(cwd, roots[tree]);
  if (!existsSync(root)) return [];
  const walker = {
    renderer: () => makeRendererWalker(root, domains),
    main: () => makeMainWalker(root, domains),
    shared: () => makeSharedWalker(root),
    preload: () => makePreloadWalker(root),
    socket: () => makeSocketWalker(root, domains),
    vercel: () => makeVercelWalker(root, domains),
  }[tree];
  if (!walker) throw new Error(`unknown structure tree "${tree}"`);
  return collect(walker());
}

/** The .mjs body for a baseline file — same header/shape as frink's committed ones. */
export function renderBaselineFile(tree, sorted) {
  const { label, exportName } = TREE_META[tree];
  return `// AUTO-GENERATED grandfather list of files violating the ${label}
// folder-structure rule at the time it was introduced.
//
// New files MUST follow the structure (see eslint.config.mjs). Existing
// violators stay in this list until they're touched. When you fix a file
// to match the new structure, REMOVE its entry here. Do NOT add new
// entries — the goal is to shrink this list to zero.
//
// For INTENTIONAL permanent exemptions (architectural choice, not legacy):
// use eslint/baselines/exempt.mjs instead. That file is hand-maintained and
// requires a reason per entry.
//
// Regenerate (only after a deliberate audit, NOT to silence new offenders):
//   bunx devkit init --stack electron   (re-runs the baseline generators)

export const ${exportName} = ${JSON.stringify(sorted, null, 2)};
`;
}

/**
 * Read the consumer's domain registries from its emitted eslint/domains.mjs.
 * Returns {} when absent (a fresh repo has none yet — every lib folder is then
 * "unregistered" and grandfathered, which is the safe pre-baseline posture).
 */
export async function loadDomains(cwd) {
  const file = join(cwd, 'eslint', 'domains.mjs');
  if (!existsSync(file)) return {};
  const mod = await import(pathToFileURL(file).href);
  return {
    RENDERER_LIB_DOMAINS: mod.RENDERER_LIB_DOMAINS,
    MAIN_ROOT_FOLDERS: mod.MAIN_ROOT_FOLDERS,
    MAIN_LIB_DOMAINS: mod.MAIN_LIB_DOMAINS,
    SOCKET_LIB_DOMAINS: mod.SOCKET_LIB_DOMAINS,
    VERCEL_LIB_DOMAINS: mod.VERCEL_LIB_DOMAINS,
  };
}

const TREES = ['renderer', 'main', 'shared', 'preload', 'socket', 'vercel'];

/**
 * Generate every existing tree's baseline into <cwd>/eslint/baselines/. Returns
 * a per-tree summary [{tree, count, written}] (written=false when tree absent).
 *
 * @param {string} cwd consumer repo root
 * @param {{roots?:object, dryRun?:boolean, log?:Function}} [opts]
 */
export async function generateStructureBaselines(cwd = process.cwd(), opts = {}) {
  const domains = await loadDomains(cwd);
  const roots = { ...DEFAULT_ROOTS, ...(opts.roots ?? {}) };
  const log = opts.log ?? (() => {});
  const summary = [];
  for (const tree of TREES) {
    const root = join(cwd, roots[tree]);
    if (!existsSync(root)) {
      summary.push({ tree, count: 0, written: false });
      continue;
    }
    const sorted = generateTreeBaseline(tree, cwd, { roots, domains });
    const out = join(cwd, 'eslint', 'baselines', `${tree}.mjs`);
    if (!opts.dryRun) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, renderBaselineFile(tree, sorted));
    }
    log(
      `  ${opts.dryRun ? '[dry-run] ' : '✓ '}eslint/baselines/${tree}.mjs: ${sorted.length} grandfathered file(s)`,
    );
    summary.push({ tree, count: sorted.length, written: !opts.dryRun });
  }
  return summary;
}

// CLI entry: `node generate-structure-baseline.mjs [cwd]`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cwd = process.argv[2] ? join(process.cwd(), process.argv[2]) : process.cwd();
  generateStructureBaselines(cwd, { log: (m) => console.log(m) }).then(() => {});
}
