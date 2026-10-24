#!/usr/bin/env node

/**
 * Self-host ship preflight for devkit's force-tracked, gitignored dist/ tree.
 *
 * The ephemeral ship worktree cannot see ignored files the caller forgot to brief. Inspect the
 * caller checkout before that worktree exists, while its physical build output and real Git index
 * are both available. Consumer repos no-op: this is devkit's own release topology, not a portable
 * guard.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { treeBlobsAtRef } from '../../../gate-engine/ratchets/tree-blobs.mts';
import { commitIndexEnv } from '../../../gate-engine/ratchets/commit-index.mts';
import { failLine } from '../../../gate-engine/deterministic/reason.mts';
import { inspectReleaseOnlyDist, printReleaseOnlyDist } from './preflight/release-only-dist.mts';
import { shellSourceEdges } from './preflight/shell-source-edges.mts';
import { staleNewDist } from './preflight/stale-new-dist.mts';
import {
  ANTI_SLOP_FILES,
  isDevOnly,
  MIRRORED_EXT,
  PACKAGED_ROOT_DIRS,
  PACKAGED_ROOT_FILES,
} from '../fs-helpers.mts';

/** One relative-import edge: who imports, what they wrote, and where it resolves in the repo. */
export interface ImportEdge {
  importer: string;
  specifier: string;
  target: string;
}

export interface DistIntegrityReport {
  active: boolean;
  unresolved: ImportEdge[];
  unbriefed: string[];
  untracked: string[];
  /**
   * Files whose dependencies could not be read: an ESM module the lexer rejected, or a shell script
   * carrying a `source` target this cannot resolve. Blocks, like the rest.
   */
  unlexable: string[];
  /** Artifacts of briefed new sources that exist nowhere: the build never ran for them. */
  missing: string[];
  /** Briefed new artifacts that differ from a fresh build of their source. */
  stale: string[];
}

const CLEAN_REPORT: DistIntegrityReport = {
  active: false,
  unresolved: [],
  unbriefed: [],
  untracked: [],
  unlexable: [],
  missing: [],
  stale: [],
};

function git(root: string, args: string[]): string[] {
  const raw = execFileSync('git', ['-C', root, '--no-optional-locks', ...args]);
  return raw.toString('utf8').split('\0').filter(Boolean);
}

function repoPath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

/**
 * A brief entry in the spelling `git ls-files` prints, so it can be compared with the index. Only
 * relative forms are folded: `./dist/x.mjs` is the same pathspec as `dist/x.mjs` to git AND the
 * same file to `$ROOT/$p` in reship.sh, so both callers really do stage it.
 *
 * An ABSOLUTE entry is deliberately left unfolded, even though git's pathspecs accept it.
 * reship.sh:126 probes `[ -e "$ROOT/$p" ]` by string concatenation, which for an absolute `$p`
 * builds `/repo//abs/path`, misses, and takes the `git rm` branch — the file never reaches the
 * commit. Folding it here would let this preflight vouch for an artifact reship silently drops.
 * Unfolded, it simply fails to match and the ship blocks, which is the safe direction. Teaching
 * reship.sh absolute paths is what unlocks folding them.
 */
function briefPath(briefed: string): string {
  const relative = briefed.split(path.sep).join('/');
  return relative.startsWith('./') ? relative.slice(2) : relative;
}

function filesUnder(root: string, relativeDir: string): string[] {
  const dir = path.join(root, relativeDir);
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(repoPath(root, child));
    }
  };
  walk(dir);
  return files.sort();
}

function packageName(root: string): string | undefined {
  try {
    return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name;
  } catch {
    return undefined;
  }
}

function importTarget(root: string, importer: string, specifier: string): string {
  const importerUrl = pathToFileURL(path.join(root, importer));
  return repoPath(root, fileURLToPath(new URL(specifier, importerUrl)));
}

/** The dist path the build emits for a source, `undefined` when it emits none. Only a NEW
 * artifact is ever demanded: a modified source's stale output stays release-only. */
export function distArtifact(briefedPath: string): string | undefined {
  const normalized = briefedPath.split(path.sep).join('/');
  if (normalized.startsWith('dist/')) return normalized;
  const under = (dir: string): boolean => normalized.startsWith(`${dir}/`);
  if (PACKAGED_ROOT_FILES.includes(normalized) || PACKAGED_ROOT_DIRS.some(under)) {
    return `dist/${normalized}`;
  }
  if (under('anti-slop')) {
    const rel = normalized.slice('anti-slop/'.length);
    if (ANTI_SLOP_FILES.includes(rel)) return `dist/${normalized}`;
    return rel.startsWith('src/') && normalized.endsWith('.ts')
      ? `dist/${normalized.slice(0, -'.ts'.length)}.js`
      : undefined;
  }
  if (!normalized.startsWith('cli/') && !normalized.startsWith('gate-engine/')) return undefined;
  if (isDevOnly(normalized) || /\.(test|d)\.mts$/.test(normalized)) return undefined;
  if (normalized.endsWith('.mts')) return `dist/${normalized.slice(0, -'.mts'.length)}.mjs`;
  return MIRRORED_EXT.test(normalized) ? `dist/${normalized}` : undefined;
}

/**
 * Relative-import edges of ONE emitted module. `undefined` means unparseable — a hole every caller
 * must fail on. Shared so the preflight and the tracked-dist test cannot disagree about an edge.
 */
export async function moduleImportEdges(
  root: string,
  importer: string,
  source: string,
): Promise<ImportEdge[] | undefined> {
  // This dependency is dev-only and intentionally loaded only for devkit self-hosting. Installed
  // consumer copies short-circuit before any caller reaches here and never need it at runtime.
  const { init, parse } = await import('es-module-lexer');
  await init;
  let imports: ReturnType<typeof parse>[0];
  try {
    [imports] = parse(source, importer);
  } catch {
    return undefined;
  }
  const edges: ImportEdge[] = [];
  for (const item of imports) {
    // `n` is populated for static and string-literal dynamic imports. It is undefined for
    // expressions/templates such as import(`./${name}.mjs`), which cannot be resolved here.
    const specifier = item.n;
    if (!specifier?.startsWith('.')) continue;
    edges.push({ importer, specifier, target: importTarget(root, importer, specifier) });
  }
  return edges;
}

/** What this ship commits under dist/: the caller's briefing, disk and BASE tree. */
interface DistView {
  root: string;
  briefed: Set<string>;
  /** Briefed dist paths whose deletion this ship lands. */
  deleted: Set<string>;
  atBase: Map<string, Buffer | null>;
  physicalSet: Set<string>;
}

/** A briefed path ships as the caller's file; every unbriefed one lands exactly as BASE has it. */
function willShip(view: DistView, file: string): boolean {
  if (!view.briefed.has(file)) return view.atBase.has(file);
  return !view.deleted.has(file) && existsSync(path.join(view.root, file));
}

function walkable(file: string): boolean {
  return file.endsWith('.mjs') || file.endsWith('.sh');
}

/** The bytes this ship commits for `importer`; `undefined` when there are none to read. */
function importerText(view: DistView, importer: string): string | undefined {
  // A deleted artifact is deliberately not a discovery root: its dependencies are leaving with it,
  // not candidates to add back.
  if (view.deleted.has(importer)) return undefined;
  if (!view.briefed.has(importer)) {
    const committed = view.atBase.get(importer)?.toString('utf8');
    if (committed !== undefined) return committed;
  }
  const absolute = path.join(view.root, importer);
  return view.physicalSet.has(importer) && existsSync(absolute)
    ? readFileSync(absolute, 'utf8')
    : undefined;
}

/** Shell walks transitively too: ship-branch.sh -> review/worktrees.sh -> its own siblings. */
function enqueueable(view: DistView, target: string): boolean {
  const present = view.physicalSet.has(target) || Boolean(view.atBase.get(target));
  return walkable(target) && present && !view.deleted.has(target);
}

/**
 * Follow the dist import graph from `seeds`, through every reachable physical dist module, so one
 * report names the whole omitted closure. `reached` holds every edge target the walk saw.
 */
async function walkDistGraph(
  view: DistView,
  seeds: Set<string>,
): Promise<{ reached: Set<string>; unresolved: ImportEdge[]; unlexable: string[] }> {
  const reached = new Set<string>();
  const unresolved: ImportEdge[] = [];
  const unlexable: string[] = [];
  const queue = [...seeds].filter(walkable).sort();
  const queued = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    const importer = queue[i]!;
    const text = importerText(view, importer);
    if (text === undefined) continue;
    const edges = importer.endsWith('.sh')
      ? await shellSourceEdges(importer, text)
      : await moduleImportEdges(view.root, importer, text);
    if (edges === undefined) {
      // Recorded, not thrown: it still blocks via `unlexable`, and finishing the queue lets one
      // report name the file instead of main()'s catch aborting with a message naming nothing.
      unlexable.push(importer);
      continue;
    }
    for (const { specifier, target } of edges) {
      reached.add(target);
      if (!willShip(view, target)) unresolved.push({ importer, specifier, target });
      if (!queued.has(target) && enqueueable(view, target)) {
        queued.add(target);
        queue.push(target);
      }
    }
  }
  return { reached, unresolved, unlexable };
}

/** A briefed source on disk whose artifact is nowhere was never built. A source absent from disk is
 *  a deletion, whose stale artifact waits for the release. */
function neverBuilt(view: DistView): string[] {
  return [...view.briefed]
    .filter((file) => !file.startsWith('dist/') && existsSync(path.join(view.root, file)))
    .map(distArtifact)
    .filter((file): file is string => file !== undefined && !view.physicalSet.has(file))
    .filter((file) => !willShip(view, file))
    .sort();
}

/**
 * Inspect the caller's physical dist tree, Git index, and ship briefing.
 * `base` is the commit the ship worktree would be cut from.
 */
export async function inspectDistIntegrity(
  root: string,
  base: string,
  briefedPaths: string[],
): Promise<DistIntegrityReport> {
  if (packageName(root) !== '@norvalbv/devkit') return { ...CLEAN_REPORT };

  const physical = filesUnder(root, 'dist');
  const briefed = new Set(briefedPaths.map(briefPath));
  // A briefed DELETION is not committed (ship-branch.sh skips its force-add). Judged at the fork point
  // staging anchors at (patch-anchor.sh), not BASE: an append's BASE is the PR tip, new dist and all.
  const fork = spawnSync('git', ['-C', root, 'merge-base', base, 'HEAD'], { encoding: 'utf8' });
  const anchor = fork.stdout.trim() || base;
  // Plumbing: porcelain `git diff` refreshes and REWRITES the shared index.
  const deleted = new Set(
    git(root, ['diff-index', '--name-only', '-z', '--diff-filter=D', anchor, '--', 'dist']).filter(
      (file) => briefed.has(file),
    ),
  );
  // Index membership is not the property that matters — presence in the commit this ship is about
  // to create is. ship-branch.sh and reship.sh `git add -f` every briefed path, so briefing one IS
  // shipping it, and demanding it be pre-staged rejects the artifact a release just generated.
  const atBase = treeBlobsAtRef(root, base, ['dist']);
  if (atBase === null) throw new Error(`cannot read dist/ at ${base}`);
  const view: DistView = { root, briefed, deleted, atBase, physicalSet: new Set(physical) };
  // Shared checkouts can contain another agent's generated output. Seed the scan from this ship's
  // explicit source/dist paths, then follow only their reachable physical dist import graph.
  const seeds = new Set(
    [...briefed].map(distArtifact).filter((file): file is string => file !== undefined),
  );
  const { reached, unresolved, unlexable } = await walkDistGraph(view, seeds);
  const required = new Set([...seeds, ...reached]);

  const added = git(root, [
    'diff-index',
    '--name-only',
    '-z',
    '--diff-filter=A',
    base,
    '--',
    'dist',
  ]);
  // A file already staged needs briefing, not `git add -f`, so `unbriefed` alone names it.
  const staged = new Set(added);
  // `willShip`, never `required`: a briefed source maps its dist into `required` without shipping it.
  const untracked = physical.filter(
    (file) => required.has(file) && !willShip(view, file) && !staged.has(file),
  );
  const unbriefed = added.filter((file) => required.has(file) && !briefed.has(file)).sort();
  unresolved.sort((a, b) =>
    `${a.importer}\0${a.specifier}`.localeCompare(`${b.importer}\0${b.specifier}`),
  );
  return {
    active: true,
    unresolved,
    unbriefed,
    untracked,
    unlexable: unlexable.sort(),
    missing: neverBuilt(view),
    stale: staleNewDist(
      root,
      [...briefed].filter((file) => !deleted.has(file)),
      atBase,
      distArtifact,
    ),
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function printDistIntegrityFailure(report: DistIntegrityReport): number {
  if (!report.active) return 0;
  const failed =
    report.untracked.length > 0 ||
    report.unbriefed.length > 0 ||
    report.unresolved.length > 0 ||
    report.unlexable.length > 0 ||
    report.missing.length > 0 ||
    report.stale.length > 0;
  if (!failed) return 0;

  console.error('✗ devkit ship: dist integrity preflight failed.');
  if (report.unlexable.length > 0) {
    console.error(
      '  Generated dist artifacts could not be read, so their dependencies are unchecked:',
    );
    for (const file of report.unlexable) console.error(`    ${file}`);
  }
  if (report.untracked.length > 0) {
    console.error('  Generated dist artifacts this ship would not commit:');
    for (const file of report.untracked) console.error(`    ${file}`);
    console.error(`  Fix: git add -f -- ${report.untracked.map(shellQuote).join(' ')}`);
    console.error('  …or drop the path from this ship if you meant its deletion to land.');
  }
  if (report.unbriefed.length > 0) {
    console.error('  Newly tracked dist artifacts are omitted from this ship:');
    for (const file of report.unbriefed) console.error(`    ${file}`);
  }
  if (report.unresolved.length > 0) {
    console.error(
      '  Relative imports and shell source targets do not resolve to tracked dist files:',
    );
    for (const item of report.unresolved) {
      console.error(`    ${item.importer}: ${item.specifier} -> ${item.target}`);
    }
  }
  if (report.missing.length > 0) {
    console.error('  New sources whose build output exists nowhere:');
    for (const file of report.missing) console.error(`    ${file}`);
    console.error(
      `  Fix: run \`bun run build\`, then brief ONLY these (ordinary dist churn stays release-only): -- ${report.missing.map(shellQuote).join(' ')}`,
    );
  }
  if (report.stale.length > 0) {
    console.error('  New dist artifacts that differ from a fresh build of their source:');
    for (const file of report.stale) console.error(`    ${file}`);
    console.error(
      `  Fix: run \`bun run build\`, then re-brief these: -- ${report.stale.map(shellQuote).join(' ')}`,
    );
  }
  if (report.untracked.length > 0 || report.unbriefed.length > 0) {
    const paths = [...new Set([...report.untracked, ...report.unbriefed])];
    console.error(`  Include after -- in the next devkit ship: ${paths.map(shellQuote).join(' ')}`);
  }
  return 1;
}

interface Args {
  base: string;
  branch: string | undefined;
  paths: string[];
  root: string;
  target?: string;
  tree: string | undefined;
}

const FLAG = /^--(root|base|branch|tree|target)$/;

function parseArgs(argv: string[]): Args {
  const flags: Partial<Record<string, string>> = {};
  let i = 0;
  for (; i < argv.length && argv[i] !== '--'; i++) {
    const name = FLAG.exec(argv[i]!)?.[1];
    if (!name || !argv[i + 1]) throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    flags[name] = argv[++i];
  }
  const { base, branch, root, target, tree } = flags;
  if (!root || !base)
    throw new Error(
      'usage: dist-integrity --root <root> --base <sha> [--branch <name>] [--tree|--target <sha>] -- <paths>',
    );
  return { base, branch, paths: argv.slice(i + 1), root, target, tree };
}

/** `--ship-staged`: the self-host hook's run inside the ship worktree, judging the staged tree with
 *  that tree's own copy of this script, as CI does. Without CI's PR base exported it no-ops. */
function shipStagedArgs(): Args | undefined {
  const base = process.env.DEVKIT_SHIP_PR_BASE_SHA;
  if (!base) return undefined;
  const root = process.cwd();
  // The hook scrubs GIT_INDEX_FILE; a pathspec commit's index arrives through the commit-index carrier.
  const tree = execFileSync('git', ['-C', root, 'write-tree'], {
    encoding: 'utf8',
    env: commitIndexEnv(root),
  }).trim();
  return { base, branch: process.env.DEVKIT_SHIP_BRANCH || undefined, paths: [], root, tree };
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    const args = argv[0] === '--ship-staged' ? shipStagedArgs() : parseArgs(argv);
    if (args === undefined) return;
    const { base, branch, paths, root, tree } = args;
    // --tree (CI, on a PR's committed tree) judges release-only only: integrity reads the
    // caller's physical build, which a committed tree does not have.
    const report = tree !== undefined ? undefined : await inspectDistIntegrity(root, base, paths);
    const integrity = report === undefined ? 0 : printDistIntegrityFailure(report);
    const releaseOnly = printReleaseOnlyDist(inspectReleaseOnlyDist(root, base, branch, args));
    process.exitCode = integrity || releaseOnly;
  } catch (error) {
    failLine(
      `✗ devkit ship: dist integrity preflight could not run — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main();
}
