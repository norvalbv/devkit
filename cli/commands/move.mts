#!/usr/bin/env node
/**
 * devkit move <src...> <dest-dir> — relocate source files and rewrite EVERY reference.
 *
 *   devkit move src/renderer/features/agents/utils/pr-message.ts src/renderer/lib/utils
 *   devkit move <a.ts> <b.ts> <dest-dir> [--dry-run] [--no-baseline] [--alias=PREFIX=DIR]
 *
 * What it does (deterministically, no AI):
 *   1. Move each source (+ its colocated *.test/*.spec sibling) to the destination. Tracked
 *      sources use `git mv` to preserve history; untracked sources move through an isolated
 *      temporary Git index without changing the caller's real index.
 *   2. Rewrite every importer's specifier across the project — import / export-from /
 *      dynamic import() / vi.mock|vi.doMock|jest.mock|require — to the moved file's new
 *      path, in the project's `@/` ALIAS style (the codebase convention).
 *   3. Re-anchor the MOVED file's own relative imports to alias form (they break on move).
 *   4. Surgically drop the moved files' OLD entries from the structure baseline
 *      (.devkit/baselines/structure/*.mjs) — NO whole-tree regen (never absorbs parallel work).
 *
 * Why not ts-morph's SourceFile.move(): it leaves `@/` alias importers stale (dangling)
 * and emits wrong relative paths. We use ts-morph only for AST-accurate editing and
 * compute specifiers ourselves so alias style is preserved and resolution is exact.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Node, Project, type SourceFile, SyntaxKind, ts } from 'ts-morph';
import {
  LEGACY_STRUCTURE_BASELINE_DIR,
  STRUCTURE_BASELINE_DIR,
} from '../../gate-engine/ratchets/baseline-paths.mts';
import { resolveBaselineRoots } from '../lib/generate/generate-structure-baseline.mts';
import {
  assertMovedSource,
  moveTrackedWithGit,
  moveUntrackedWithGit,
  trackedPathState,
  type SourceIdentity,
} from '../lib/git-tracked.mts';
import { reviewPathWithin } from '../lib/ship/review/runtime-paths.mts';

/**
 * `pathsBasePath` is absent from TypeScript's published CompilerOptions typings;
 * parseJsonConfigFileContent sets it to the directory of the config that declared `paths`.
 */
interface ResolvedPathOptions extends ts.CompilerOptions {
  pathsBasePath?: string;
}
/** A resolved `@/*` alias: its specifier prefix and the absolute src root it points at. */
interface Alias {
  prefix: string;
  root: string;
}
/** An editable module-specifier reference in a source file (get/set its literal value). */
interface SpecifierHandle {
  get: () => string;
  set: (v: string) => void;
}
/** A single planned file relocation (source file or its colocated test sibling). */
interface Move {
  oldAbs: string;
  newAbs: string;
  oldMod: string;
  newMod?: string;
}
/** One filesystem-level source move. Directories stay atomic; their files are mapped separately. */
interface PhysicalMove {
  oldAbs: string;
  newAbs: string;
  trackedAtPreflight: boolean;
  sourceIdentity: SourceIdentity;
}

const TEST_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];
const MOCK_CALLEES = new Set(['vi.mock', 'vi.doMock', 'jest.mock', 'require', 'import']);
const NO_ALIAS_HINT = 'no "@/*"-style path alias found in tsconfig — pass --alias @/=src/renderer';
// 18003 always fires because readDirectory is stubbed below, and 5023 fires on valid configs using
// an option this TypeScript predates. Every other diagnostic left `paths` genuinely unresolved.
const BENIGN_CONFIG_CODES = new Set([18003, 5023]);

const EXT_RE = /\.(ts|tsx|js|jsx)$/;
const STAR_END_RE = /\*$/;
const SLASH_END_RE = /\/$/;
const INDEX_SUFFIX_RE = /\/index$/;
const RE_META_RE = /[.*+?^${}()|[\]\\]/g;

const stripExt = (p: string): string => p.replace(EXT_RE, '');
const toPosix = (p: string): string => p.replaceAll('\\', '/');

/** Reads the `@/*` alias the way tsc does: whole `extends` chain, real tsconfig JSONC. */
function readAlias(cwd: string, override?: string): Alias | null {
  const tsPath = join(cwd, 'tsconfig.json');
  // Checked even under --alias: the rewrite pass below builds a ts-morph Project from this file
  // AFTER git mv, so an absent one would abort mid-run and strand a half-moved tree.
  if (!existsSync(tsPath))
    throw new Error(`could not read ${relative(cwd, tsPath)}: file not found`);
  if (override) {
    const [prefix, dir] = override.split('=');
    if (!dir) throw new Error(`--alias needs PREFIX=DIR, got --alias=${override}`);
    return { prefix: prefix.replace(STAR_END_RE, ''), root: resolve(cwd, dir) };
  }
  const read = ts.readConfigFile(tsPath, (p) => ts.sys.readFile(p));
  if (read.error)
    throw new Error(
      `could not read ${relative(cwd, tsPath)}: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`,
    );
  // readDirectory is stubbed: only compilerOptions is wanted, and the include glob would walk the repo.
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: () => [],
    fileExists: (p) => ts.sys.fileExists(p),
    readFile: (p) => ts.sys.readFile(p),
  };
  const parsed = ts.parseJsonConfigFileContent(read.config, host, cwd, undefined, tsPath);
  const opts: ResolvedPathOptions = parsed.options;
  const entry = Object.entries(opts.paths ?? {}).find(([k, v]) => k.endsWith('/*') && v[0]);
  if (!entry) {
    // Only consulted once nothing resolved: these same diagnostics fire harmlessly when the root
    // config's own paths win, so they are the diagnosis only when there is nothing else to report.
    const fault = parsed.errors.find((d) => !BENIGN_CONFIG_CODES.has(d.code));
    if (fault) {
      const where = fault.file ? relative(cwd, fault.file.fileName) : relative(cwd, tsPath);
      throw new Error(
        `could not read ${where}: ${ts.flattenDiagnosticMessageText(fault.messageText, ' ')}`,
      );
    }
    return null;
  }
  const prefix = entry[0].replace(STAR_END_RE, ''); // '@/*' -> '@/'
  const target = entry[1][0].replace(STAR_END_RE, '').replace(SLASH_END_RE, ''); // './src/renderer/*' -> './src/renderer'
  // tsc resolves `paths` against baseUrl when declared, else against the declaring config's dir.
  return { prefix, root: resolve(opts.baseUrl ?? opts.pathsBasePath ?? cwd, target) };
}

/** A specifier → absolute extensionless module path, or null if external/bare. */
function resolveSpec(spec: string, resolveDir: string, alias: Alias): string | null {
  if (spec.startsWith(alias.prefix))
    return stripExt(join(alias.root, spec.slice(alias.prefix.length)));
  if (spec.startsWith('./') || spec.startsWith('../')) return stripExt(resolve(resolveDir, spec));
  return null;
}

/** Absolute extensionless module path → alias specifier ('@/lib/utils/x', drops trailing /index). */
function aliasFor(absMod: string, alias: Alias): string {
  return alias.prefix + toPosix(relative(alias.root, absMod)).replace(INDEX_SUFFIX_RE, '');
}

function testSiblings(fileAbs: string): string[] {
  const base = stripExt(fileAbs);
  return TEST_SUFFIXES.map((s) => base + s).filter(existsSync);
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return null;
    throw error;
  }
}

function nearestExistingAncestor(path: string) {
  let cursor = path;
  while (!lstatOrNull(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { canonical: realpathSync(cursor), lexical: cursor };
}

/** Logical leaf mappings for AST/baseline work; nested repositories are deliberately opaque. */
function mapDirectoryLeaves(
  oldDir: string,
  newDir: string,
  addMove: (oldAbs: string, newAbs: string) => void,
): void {
  if (lstatOrNull(join(oldDir, '.git'))) return;
  const entries = readdirSync(oldDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const oldAbs = join(oldDir, entry.name);
    const newAbs = join(newDir, entry.name);
    const stat = lstatSync(oldAbs);
    if (stat.isDirectory() && !stat.isSymbolicLink()) mapDirectoryLeaves(oldAbs, newAbs, addMove);
    else addMove(oldAbs, newAbs);
  }
}

function shouldRewriteSourceFile(fileAbs: string, worktreeRoot: string, gitDir: string): boolean {
  let parent = dirname(fileAbs);
  while (parent !== worktreeRoot) {
    if (lstatOrNull(join(parent, '.git'))) return false;
    const next = dirname(parent);
    if (next === parent) return false;
    parent = next;
  }
  const stat = lstatOrNull(fileAbs);
  if (!stat || stat.isSymbolicLink()) return false;
  const canonicalParent = realpathSync(dirname(fileAbs));
  return (
    reviewPathWithin(worktreeRoot, canonicalParent) && !reviewPathWithin(gitDir, canonicalParent)
  );
}

/** Every editable module specifier in a file: import/export-from + import()/vi.mock/require string args. */
function specifierHandles(sf: SourceFile): SpecifierHandle[] {
  const out: SpecifierHandle[] = [];
  for (const d of [...sf.getImportDeclarations(), ...sf.getExportDeclarations()]) {
    const lit = d.getModuleSpecifier();
    if (lit)
      out.push({ get: () => lit.getLiteralValue(), set: (v: string) => lit.setLiteralValue(v) });
  }
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!MOCK_CALLEES.has(call.getExpression().getText())) continue;
    const arg = call.getArguments()[0];
    if (arg && Node.isStringLiteral(arg))
      out.push({ get: () => arg.getLiteralValue(), set: (v: string) => arg.setLiteralValue(v) });
  }
  return out;
}

/** Drop moved files' OLD paths from the structure baselines (surgical — no regen). */
function pruneBaselines(cwd: string, oldRelPaths: string[], dryRun: boolean): number {
  const canonicalDir = join(cwd, STRUCTURE_BASELINE_DIR);
  const legacyDir = join(cwd, LEGACY_STRUCTURE_BASELINE_DIR);
  if (!existsSync(canonicalDir) && !existsSync(legacyDir)) return 0;
  // structureRoot prefixes → baseline file, resolved from guard.config.json so the prune
  // follows whatever roots the baseline writer used (config trees or the electron default).
  const ROOTS = resolveBaselineRoots(cwd);
  let removed = 0;
  for (const [prefix, file] of ROOTS) {
    const canonical = join(canonicalDir, file);
    const legacy = join(legacyDir, file);
    const abs = existsSync(canonical) ? canonical : legacy;
    if (!existsSync(abs)) continue;
    const keys = oldRelPaths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
    if (!keys.length) continue;
    const text = readFileSync(abs, 'utf8');
    let next = text;
    for (const k of keys) {
      const line = new RegExp(`^\\s*"${k.replace(RE_META_RE, '\\$&')}",?\\n`, 'm');
      if (line.test(next)) {
        next = next.replace(line, '');
        removed++;
      }
    }
    if (next !== text && !dryRun) writeFileSync(abs, next);
  }
  return removed;
}

export const meta = {
  name: 'move',
  summary: 'Relocate source files + rewrite every reference.',
  help: `devkit move — relocate source files + rewrite EVERY reference to the new path.

Usage:
  devkit move <src...> <dest-dir> [--dry-run] [--no-baseline] [--alias=@/=src/renderer]

Rewrites import / export-from / dynamic import() / vi.mock|jest.mock|require in the repo's @/ alias
style, moves colocated *.test siblings, re-anchors the moved file's own relative imports, and
surgically prunes the moved entries from .devkit/baselines/structure (no whole-tree regen). Tracked
sources preserve history through git mv; untracked sources move without requiring a first commit.
  --dry-run        Preview only.
  --no-baseline    Skip the baseline prune.
  --alias=@/=DIR   Override tsconfig alias auto-detect.`,
};

export default async function move(args: string[], cwd: string): Promise<number> {
  const flags = new Set(args.filter((a) => a.startsWith('--') && !a.startsWith('--alias=')));
  const positionals = args.filter((a) => !a.startsWith('--'));
  const dryRun = flags.has('--dry-run');
  const noBaseline = flags.has('--no-baseline');
  // --alias=@/=src/renderer (split on the FIRST '=' only → prefix '@/', dir 'src/renderer')
  const aliasArg = args.find((a) => a.startsWith('--alias='))?.slice('--alias='.length);
  if (positionals.length < 2) {
    console.error(
      'usage: devkit move <src...> <dest-dir> [--dry-run] [--no-baseline] [--alias=@/=src/renderer]',
    );
    return 1;
  }
  cwd = realpathSync(cwd);
  const destDir = resolve(cwd, positionals[positionals.length - 1]);
  const srcRels = positionals.slice(0, -1);

  const worktreeRoot = realpathSync(
    execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim(),
  );
  const gitDir = realpathSync(
    execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' }).trim(),
  );
  const trackedPaths = trackedPathState(worktreeRoot, { realIndex: true });
  const gitMarker = join(worktreeRoot, '.git');

  // Expand sources into physical operations and concrete logical file mappings. Directories move
  // once; their descendants exist only in `moves`, where the AST and baseline passes need them.
  const physicalMoves: PhysicalMove[] = [];
  const moves: Move[] = [];
  const seenPhysical = new Set<string>();
  const seenLogical = new Set<string>();
  const addMove = (oldAbs: string, newAbs: string) => {
    if (seenLogical.has(oldAbs)) return;
    seenLogical.add(oldAbs);
    moves.push({ oldAbs, newAbs, oldMod: stripExt(oldAbs) });
  };
  const addPhysicalMove = (oldAbs: string) => {
    if (seenPhysical.has(oldAbs)) return;
    seenPhysical.add(oldAbs);
    const stat = lstatOrNull(oldAbs);
    if (!stat) throw new Error(`not found: ${relative(cwd, oldAbs)}`);
    const canonicalParent = realpathSync(dirname(oldAbs));
    const canonicalSource = stat.isSymbolicLink() ? null : realpathSync(oldAbs);
    if (!reviewPathWithin(worktreeRoot, canonicalParent))
      throw new Error(`source resolves outside the Git worktree: ${relative(cwd, oldAbs)}`);
    if (canonicalParent !== dirname(oldAbs))
      throw new Error(`source traverses a symlinked directory: ${relative(cwd, oldAbs)}`);
    if (
      oldAbs === worktreeRoot ||
      reviewPathWithin(gitMarker, oldAbs) ||
      reviewPathWithin(gitDir, canonicalParent) ||
      (canonicalSource != null && reviewPathWithin(gitDir, canonicalSource))
    )
      throw new Error(`source is Git worktree metadata: ${relative(cwd, oldAbs)}`);
    const newAbs = join(destDir, basename(oldAbs));
    const oldGitRel = toPosix(relative(worktreeRoot, oldAbs));
    const trackedAtPreflight = trackedPaths.contains(oldGitRel);
    const sourceIdentity = {
      dev: stat.dev,
      ino: stat.ino,
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
    };
    physicalMoves.push({ oldAbs, newAbs, trackedAtPreflight, sourceIdentity });
    if (!stat.isDirectory() || stat.isSymbolicLink()) addMove(oldAbs, newAbs);
  };
  for (const r of srcRels) {
    const oldAbs = resolve(cwd, r);
    const stat = lstatOrNull(oldAbs);
    if (!stat) {
      console.error(`✗ not found: ${r}`);
      return 1;
    }
    addPhysicalMove(oldAbs);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      for (const t of testSiblings(oldAbs)) addPhysicalMove(t);
  }
  const fail = (message: string): number => {
    console.error(`✗ ${message}`);
    return 1;
  };
  const physicalTargets = new Set<string>();
  for (const m of physicalMoves) {
    if (m.oldAbs === m.newAbs)
      return fail(`destination matches source: ${relative(cwd, m.oldAbs)}`);
    if (physicalTargets.has(m.newAbs))
      return fail(`duplicate destination: ${relative(cwd, m.newAbs)}`);
    physicalTargets.add(m.newAbs);
    if (lstatOrNull(m.newAbs))
      return fail(`destination already exists: ${relative(cwd, m.newAbs)}`);
    if (trackedPaths.conflictsTarget(toPosix(relative(worktreeRoot, m.newAbs))))
      return fail(`destination exists in the Git index: ${relative(cwd, m.newAbs)}`);
    const targetAncestor = nearestExistingAncestor(m.newAbs);
    if (
      !reviewPathWithin(worktreeRoot, targetAncestor.canonical) ||
      reviewPathWithin(gitMarker, m.newAbs) ||
      reviewPathWithin(gitDir, targetAncestor.canonical)
    )
      return fail(`destination resolves outside the Git worktree: ${relative(cwd, m.newAbs)}`);
    if (targetAncestor.canonical !== targetAncestor.lexical)
      return fail(`destination traverses a symlinked directory: ${relative(cwd, m.newAbs)}`);
    if (reviewPathWithin(m.oldAbs, m.newAbs))
      return fail(
        `destination cannot be inside source: ${relative(cwd, m.newAbs)} is inside ${relative(cwd, m.oldAbs)}`,
      );
  }
  for (let i = 0; i < physicalMoves.length; i++) {
    for (let j = i + 1; j < physicalMoves.length; j++) {
      const left = physicalMoves[i];
      const right = physicalMoves[j];
      if (
        reviewPathWithin(left.oldAbs, right.oldAbs) ||
        reviewPathWithin(right.oldAbs, left.oldAbs)
      )
        return fail(
          `sources overlap: ${relative(cwd, left.oldAbs)} and ${relative(cwd, right.oldAbs)}`,
        );
    }
  }
  for (const source of physicalMoves) {
    for (const target of physicalMoves) {
      if (source !== target && reviewPathWithin(source.oldAbs, target.newAbs))
        return fail(
          `destination cannot be inside source: ${relative(cwd, target.newAbs)} is inside ${relative(cwd, source.oldAbs)}`,
        );
    }
  }
  const preview = () => {
    for (const m of physicalMoves)
      console.log(
        `${dryRun ? '[dry] ' : ''}mv ${relative(cwd, m.oldAbs)} → ${relative(cwd, m.newAbs)}`,
      );
  };

  if (dryRun) {
    const shown = readAlias(cwd, aliasArg);
    preview();
    console.log('[dry] would rewrite importers + prune baselines (run without --dry-run to apply)');
    if (shown) return 0;
    console.error(NO_ALIAS_HINT);
    return 1;
  }

  const alias = readAlias(cwd, aliasArg);
  if (!alias) {
    console.error(NO_ALIAS_HINT);
    return 1;
  }
  preview();
  for (const m of physicalMoves) {
    if (m.trackedAtPreflight) {
      mkdirSync(dirname(m.newAbs), { recursive: true });
      moveTrackedWithGit(worktreeRoot, m.oldAbs, m.newAbs);
    } else moveUntrackedWithGit(worktreeRoot, gitDir, m.oldAbs, m.newAbs, m.sourceIdentity);
    assertMovedSource(m.newAbs, m.oldAbs, m.sourceIdentity);
    const movedParent = realpathSync(dirname(m.newAbs));
    if (
      movedParent !== dirname(m.newAbs) ||
      !reviewPathWithin(worktreeRoot, movedParent) ||
      reviewPathWithin(gitDir, movedParent)
    )
      throw new Error(
        `destination changed during move; source is at ${realpathSync(m.newAbs)}; imports were not rewritten`,
      );
    if (m.sourceIdentity.isDirectory && !m.sourceIdentity.isSymbolicLink)
      mapDirectoryLeaves(m.newAbs, m.oldAbs, (current, previous) => addMove(previous, current));
  }
  moves.forEach((m) => {
    m.newMod = stripExt(m.newAbs);
  });

  const project = new Project({ tsConfigFilePath: join(cwd, 'tsconfig.json') });
  const movedByNew = new Map(moves.map((m) => [m.newAbs, m]));

  let rewrites = 0;
  for (const sf of project.getSourceFiles()) {
    const fileAbs = sf.getFilePath();
    if (!shouldRewriteSourceFile(fileAbs, worktreeRoot, gitDir)) continue;
    const moved = movedByNew.get(fileAbs);
    const resolveDir = moved ? dirname(moved.oldAbs) : dirname(fileAbs); // moved file's relatives anchored to OLD dir
    let touched = false;
    for (const h of specifierHandles(sf)) {
      const spec = h.get();
      const absMod = resolveSpec(spec, resolveDir, alias);
      if (absMod == null) continue;
      const hit = moves.find((m) => m.oldMod === absMod);
      if (hit) {
        h.set(aliasFor(hit.newMod ?? stripExt(hit.newAbs), alias)); // → a moved file's new home
        touched = true;
        rewrites++;
      } else if (moved && !spec.startsWith(alias.prefix)) {
        h.set(aliasFor(absMod, alias)); // moved file's own relative → re-anchor to alias
        touched = true;
        rewrites++;
      }
    }
    if (touched) sf.saveSync();
  }

  const removed = noBaseline
    ? 0
    : pruneBaselines(
        cwd,
        moves.map((m) => toPosix(relative(cwd, m.oldAbs))),
        false,
      );

  console.log(
    `✓ moved ${moves.length} file(s), rewrote ${rewrites} specifier(s)${noBaseline ? '' : `, pruned ${removed} baseline entr${removed === 1 ? 'y' : 'ies'}`}`,
  );
  console.log('  next: bunx tsc --noEmit && bun run lint:structure && bun run test:run');
  return 0;
}
