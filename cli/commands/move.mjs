#!/usr/bin/env node
/**
 * devkit move <src...> <dest-dir> — relocate source files and rewrite EVERY reference.
 *
 *   devkit move src/renderer/features/agents/utils/pr-message.ts src/renderer/lib/utils
 *   devkit move <a.ts> <b.ts> <dest-dir> [--dry-run] [--no-baseline] [--alias=PREFIX=DIR]
 *
 * What it does (deterministically, no AI):
 *   1. `git mv` each file (+ its colocated *.test/*.spec sibling) to the destination,
 *      preserving history.
 *   2. Rewrite every importer's specifier across the project — import / export-from /
 *      dynamic import() / vi.mock|vi.doMock|jest.mock|require — to the moved file's new
 *      path, in the project's `@/` ALIAS style (the codebase convention).
 *   3. Re-anchor the MOVED file's own relative imports to alias form (they break on move).
 *   4. Surgically drop the moved files' OLD entries from the structure baseline
 *      (eslint/baselines/*.mjs) — NO whole-tree regen (never absorbs parallel work).
 *
 * Why not ts-morph's SourceFile.move(): it leaves `@/` alias importers stale (dangling)
 * and emits wrong relative paths. We use ts-morph only for AST-accurate editing and
 * compute specifiers ourselves so alias style is preserved and resolution is exact.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';

const TEST_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];
const MOCK_CALLEES = new Set(['vi.mock', 'vi.doMock', 'jest.mock', 'require', 'import']);

const EXT_RE = /\.(ts|tsx|js|jsx)$/;
const LINE_COMMENT_RE = /\/\/.*$/gm;
const TRAILING_COMMA_RE = /,(\s*[}\]])/g;
const STAR_END_RE = /\*$/;
const SLASH_END_RE = /\/$/;
const INDEX_SUFFIX_RE = /\/index$/;
const RE_META_RE = /[.*+?^${}()|[\]\\]/g;

const stripExt = (p) => p.replace(EXT_RE, '');
const toPosix = (p) => p.replaceAll('\\', '/');

/** Read the consumer's `@/*` alias → { prefix:'@/', root:'<abs src dir>' } from tsconfig (+1 extends hop). */
function readAlias(cwd, override) {
  if (override) {
    const [prefix, dir] = override.split('=');
    return { prefix: prefix.replace(STAR_END_RE, ''), root: resolve(cwd, dir) };
  }
  const readJson = (f) =>
    JSON.parse(
      readFileSync(f, 'utf8').replace(LINE_COMMENT_RE, '').replace(TRAILING_COMMA_RE, '$1'),
    );
  let tsPath = join(cwd, 'tsconfig.json');
  const cfg = readJson(tsPath);
  let opts = cfg.compilerOptions ?? {};
  if (!opts.paths && cfg.extends) {
    const ext = resolve(dirname(tsPath), cfg.extends);
    const base = readJson(ext);
    opts = { ...(base.compilerOptions ?? {}), ...opts };
    tsPath = ext;
  }
  const baseUrl = opts.baseUrl ?? '.';
  const entry = Object.entries(opts.paths ?? {}).find(([k]) => k.endsWith('/*'));
  if (!entry)
    throw new Error('no "@/*"-style path alias found in tsconfig — pass --alias @/=src/renderer');
  const prefix = entry[0].replace(STAR_END_RE, ''); // '@/* ' -> '@/'
  const target = entry[1][0].replace(STAR_END_RE, '').replace(SLASH_END_RE, ''); // './src/renderer/*' -> './src/renderer'
  return { prefix, root: resolve(cwd, baseUrl, target) };
}

/** A specifier → absolute extensionless module path, or null if external/bare. */
function resolveSpec(spec, resolveDir, alias) {
  if (spec.startsWith(alias.prefix))
    return stripExt(join(alias.root, spec.slice(alias.prefix.length)));
  if (spec.startsWith('./') || spec.startsWith('../')) return stripExt(resolve(resolveDir, spec));
  return null;
}

/** Absolute extensionless module path → alias specifier ('@/lib/utils/x', drops trailing /index). */
function aliasFor(absMod, alias) {
  return alias.prefix + toPosix(relative(alias.root, absMod)).replace(INDEX_SUFFIX_RE, '');
}

function testSiblings(fileAbs) {
  const base = stripExt(fileAbs);
  return TEST_SUFFIXES.map((s) => base + s).filter(existsSync);
}

/** Every editable module specifier in a file: import/export-from + import()/vi.mock/require string args. */
function specifierHandles(sf) {
  const out = [];
  for (const d of [...sf.getImportDeclarations(), ...sf.getExportDeclarations()]) {
    const lit = d.getModuleSpecifier();
    if (lit) out.push({ get: () => lit.getLiteralValue(), set: (v) => lit.setLiteralValue(v) });
  }
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!MOCK_CALLEES.has(call.getExpression().getText())) continue;
    const arg = call.getArguments()[0];
    if (arg?.getKind() === SyntaxKind.StringLiteral)
      out.push({ get: () => arg.getLiteralValue(), set: (v) => arg.setLiteralValue(v) });
  }
  return out;
}

function gitMv(cwd, from, to) {
  execFileSync('git', ['mv', relative(cwd, from), relative(cwd, to)], { cwd });
}

/** Drop moved files' OLD paths from the structure baselines (surgical — no regen). */
function pruneBaselines(cwd, oldRelPaths, dryRun) {
  const baselineDir = join(cwd, 'eslint', 'baselines');
  if (!existsSync(baselineDir)) return 0;
  // structureRoot prefixes → baseline file (mirrors eslint.config.mjs structureRoots).
  const ROOTS = [
    ['src/renderer/', 'renderer.mjs'],
    ['src/main/', 'main.mjs'],
    ['src/shared/', 'shared.mjs'],
    ['src/preload/', 'preload.mjs'],
    ['socket-server/src/', 'socket.mjs'],
    ['vercel-serverless/', 'vercel.mjs'],
  ];
  let removed = 0;
  for (const [prefix, file] of ROOTS) {
    const abs = join(baselineDir, file);
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

export default async function move(args, cwd) {
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
  const destDir = resolve(cwd, positionals[positionals.length - 1]);
  const srcRels = positionals.slice(0, -1);
  const alias = readAlias(cwd, aliasArg);

  // Expand sources + colocated tests into concrete moves.
  const moves = [];
  const seen = new Set();
  const addMove = (oldAbs) => {
    if (seen.has(oldAbs)) return;
    seen.add(oldAbs);
    moves.push({ oldAbs, newAbs: join(destDir, basename(oldAbs)), oldMod: stripExt(oldAbs) });
  };
  for (const r of srcRels) {
    const oldAbs = resolve(cwd, r);
    if (!existsSync(oldAbs)) {
      console.error(`✗ not found: ${r}`);
      return 1;
    }
    addMove(oldAbs);
    for (const t of testSiblings(oldAbs)) addMove(t);
  }
  moves.forEach((m) => {
    m.newMod = stripExt(m.newAbs);
  });

  for (const m of moves)
    console.log(
      `${dryRun ? '[dry] ' : ''}mv ${relative(cwd, m.oldAbs)} → ${relative(cwd, m.newAbs)}`,
    );
  if (dryRun) {
    console.log('[dry] would rewrite importers + prune baselines (run without --dry-run to apply)');
    return 0;
  }

  mkdirSync(destDir, { recursive: true });
  for (const m of moves) gitMv(cwd, m.oldAbs, m.newAbs);

  const project = new Project({ tsConfigFilePath: join(cwd, 'tsconfig.json') });
  const movedByNew = new Map(moves.map((m) => [m.newAbs, m]));

  let rewrites = 0;
  for (const sf of project.getSourceFiles()) {
    const fileAbs = sf.getFilePath();
    const moved = movedByNew.get(fileAbs);
    const resolveDir = moved ? dirname(moved.oldAbs) : dirname(fileAbs); // moved file's relatives anchored to OLD dir
    let touched = false;
    for (const h of specifierHandles(sf)) {
      const spec = h.get();
      const absMod = resolveSpec(spec, resolveDir, alias);
      if (absMod == null) continue;
      const hit = moves.find((m) => m.oldMod === absMod);
      if (hit) {
        h.set(aliasFor(hit.newMod, alias)); // → a moved file's new home
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
