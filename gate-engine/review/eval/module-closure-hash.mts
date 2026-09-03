/** Deterministically fingerprint a local ESM module and every relative module it reaches. */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initSync, parse } from 'es-module-lexer';

const EXTENSIONS = ['.mts', '.mjs', '.ts', '.js', '.cts', '.cjs', '.tsx', '.jsx'] as const;

initSync();

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function resolutionCandidates(base: string): string[] {
  const extension = path.extname(base);
  const candidates = [base];

  if (extension) {
    const stem = base.slice(0, -extension.length);
    for (const alias of extensionAliases(extension)) candidates.push(`${stem}${alias}`);
  } else {
    for (const candidateExtension of EXTENSIONS) candidates.push(`${base}${candidateExtension}`);
    for (const candidateExtension of EXTENSIONS)
      candidates.push(path.join(base, `index${candidateExtension}`));
  }

  return [...new Set(candidates)];
}

function extensionAliases(extension: string): readonly string[] {
  switch (extension) {
    case '.mjs':
      return ['.mts', '.ts'];
    case '.js':
      return ['.ts', '.tsx', '.mts'];
    case '.cjs':
      return ['.cts', '.ts'];
    case '.mts':
      return ['.mjs'];
    case '.ts':
      return ['.js'];
    case '.cts':
      return ['.cjs'];
    default:
      return [];
  }
}

function resolveRelativeModule(importer: string, specifier: string): string {
  const base = fileURLToPath(new URL(specifier, pathToFileURL(importer)));
  const resolved = resolutionCandidates(base).find(isFile);
  if (resolved) return path.normalize(resolved);
  throw new Error(
    `Cannot resolve relative module ${JSON.stringify(specifier)} imported by ${importer}`,
  );
}

function commonRootDirectory(files: readonly string[]): string {
  let candidate = path.dirname(files[0]);
  while (
    !files.every((file) => {
      const relative = path.relative(candidate, path.dirname(file));
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
    })
  ) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

function canonicalPath(anchor: string, file: string): string {
  return path.relative(anchor, file).split(path.sep).join('/');
}

/**
 * Hash the sorted canonical path + content pairs in the transitive local-module closure.
 *
 * Bare/package imports are deliberately outside the closure. Relative imports, re-exports, and
 * literal dynamic imports are followed; unresolved relative references fail instead of silently
 * producing an identity that omits executable code.
 */
export function hashLocalModuleClosure(
  rootFiles: readonly string[],
  readSource: (file: string, encoding: 'utf8') => string = (file, encoding) =>
    readFileSync(file, encoding),
): string {
  if (rootFiles.length === 0)
    throw new TypeError('Local module closure requires at least one root');

  const roots = [...new Set(rootFiles.map((file) => path.resolve(file)))].sort();
  for (const root of roots) {
    if (!isFile(root)) throw new Error(`Cannot read local module root ${root}`);
  }

  const anchor = commonRootDirectory(roots);
  let previous = captureLocalModuleClosure(roots, readSource);
  for (let capture = 1; capture < 3; capture += 1) {
    const current = captureLocalModuleClosure(roots, readSource);
    if (sameClosure(previous, current)) return hashClosure(anchor, current);
    previous = current;
  }
  throw new Error('Local module closure changed while hashing; retry after writes settle');
}

function captureLocalModuleClosure(
  roots: readonly string[],
  readSource: (file: string, encoding: 'utf8') => string,
): Map<string, string> {
  const pending = [...roots];
  const contents = new Map<string, string>();

  while (pending.length > 0) {
    const file = pending.pop();
    if (!file) continue;
    if (contents.has(file)) continue;
    const source = readSource(file, 'utf8');
    contents.set(file, source);
    if (path.extname(file) === '.json') continue;

    let imports: ReturnType<typeof parse>[0];
    try {
      [imports] = parse(source, file);
    } catch (error) {
      throw new Error(
        `Cannot parse local module ${file}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    for (const imported of imports) {
      const specifier = imported.n;
      if (specifier === undefined) continue;
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      const dependency = resolveRelativeModule(file, specifier);
      if (!contents.has(dependency)) pending.push(dependency);
    }
  }

  return contents;
}

function sameClosure(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [file, source] of left) if (right.get(file) !== source) return false;
  return true;
}

function hashClosure(anchor: string, contents: Map<string, string>): string {
  const pairs = [...contents]
    .map(([file, source]) => [canonicalPath(anchor, file), source] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex').slice(0, 12);
}
