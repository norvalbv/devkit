/** Specifier math for `devkit move`: read the tsconfig `@/*` alias, resolve a specifier to an
 * absolute module path, and choose alias or relative form for a rewritten one. */
import { dirname, join, relative, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ts } from 'ts-morph';
import { reviewPathWithin } from '../ship/review/runtime-paths.mts';

/**
 * `pathsBasePath` is absent from TypeScript's published CompilerOptions typings;
 * parseJsonConfigFileContent sets it to the directory of the config that declared `paths`.
 */
interface ResolvedPathOptions extends ts.CompilerOptions {
  pathsBasePath?: string;
}
/** A resolved `@/*` alias: its specifier prefix and the absolute src root it points at. */
export interface Alias {
  prefix: string;
  root: string;
}
// 18003 always fires because readDirectory is stubbed below, and 5023 fires on valid configs using
// an option this TypeScript predates. Every other diagnostic left `paths` genuinely unresolved.
const BENIGN_CONFIG_CODES = new Set([18003, 5023]);

const EXT_RE = /\.(ts|tsx|js|jsx)$/;
const STAR_END_RE = /\*$/;
const SLASH_END_RE = /\/$/;

export const stripExt = (p: string): string => p.replace(EXT_RE, '');
export const toPosix = (p: string): string => p.replaceAll('\\', '/');

/** Reads the `@/*` alias the way tsc does: whole `extends` chain, real tsconfig JSONC. */
export function readAlias(cwd: string, override?: string): Alias | null {
  const tsPath = join(cwd, 'tsconfig.json');
  // Checked even under --alias: `devkit move`'s rewrite pass builds a ts-morph Project from this file
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
export function resolveSpec(spec: string, resolveDir: string, alias: Alias): string | null {
  if (spec.startsWith(alias.prefix))
    return stripExt(join(alias.root, spec.slice(alias.prefix.length)));
  if (spec.startsWith('./') || spec.startsWith('../')) return stripExt(resolve(resolveDir, spec));
  return null;
}

/** Absolute extensionless module path → alias specifier ('@/lib/utils/x'). An explicit `/index`
 * stays: `foo` could resolve to a sibling `foo.*` instead of `foo/index`. */
function aliasFor(absMod: string, alias: Alias): string {
  return alias.prefix + toPosix(relative(alias.root, absMod));
}

/**
 * Alias form only when the importer AND the target sit under the alias root; otherwise a relative
 * path from the importer — an alias reaching outside its root (`@/../main/x`) crosses import walls.
 */
export function specifierFor(absMod: string, importerAbs: string, alias: Alias): string {
  if (reviewPathWithin(alias.root, absMod) && reviewPathWithin(alias.root, importerAbs))
    return aliasFor(absMod, alias);
  const rel = toPosix(relative(dirname(importerAbs), absMod));
  return rel.startsWith('../') ? rel : `./${rel}`;
}
