// A briefed NEW dist artifact must match a fresh build of its source; tracked dist stays release-only.
// Ship never builds: it compares, so a caller's stale or re-checked-out artifact cannot pass.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/** The source a dist path is built from: the inverse of `distArtifact` for compiled trees. */
function distSource(artifact: string): string {
  const rel = artifact.slice('dist/'.length);
  if (rel.startsWith('anti-slop/src/') && rel.endsWith('.js')) return `${rel.slice(0, -3)}.ts`;
  if (/^(cli|gate-engine)\/.*\.mjs$/.test(rel)) return `${rel.slice(0, -4)}.mts`;
  return rel;
}

/** The checkout's own tsc: the global install that runs this preflight carries no compiler. */
function checkoutTsc(root: string): string {
  try {
    const pkg = createRequire(path.resolve(root, 'package.json')).resolve(
      '@typescript/native/package.json',
    );
    return path.join(path.dirname(pkg), 'bin', 'tsc');
  } catch {
    throw new Error(`no TypeScript compiler in ${root} — run \`bun install\` there`);
  }
}

/** Compiles the checkout into a tmp dir and returns each wanted artifact's emitted bytes. */
function freshEmit(root: string, artifacts: string[]): Map<string, Buffer | undefined> {
  const out = mkdtempSync(path.join(os.tmpdir(), 'devkit-fresh-dist-'));
  try {
    // The exit code is ignored: noEmitOnError is unset, so another file's type error still emits.
    spawnSync(
      process.execPath,
      [checkoutTsc(root), '-p', path.join(root, 'tsconfig.build.json'), '--outDir', out],
      { cwd: root, stdio: 'ignore' },
    );
    const emitted = (file: string): Buffer | undefined => {
      const absolute = path.join(out, file.slice('dist/'.length));
      return existsSync(absolute) ? readFileSync(absolute) : undefined;
    };
    return new Map(artifacts.map((file) => [file, emitted(file)]));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Briefed new dist artifacts whose bytes differ from a fresh build of their on-disk source. */
export function staleNewDist(
  root: string,
  shipping: string[],
  atBase: Map<string, unknown>,
  distArtifact: (source: string) => string | undefined,
): string[] {
  const pairs = shipping
    .filter((file) => file.startsWith('dist/') && !atBase.has(file))
    .filter((file) => existsSync(path.join(root, file)))
    .map((artifact) => ({ artifact, source: distSource(artifact) }))
    .filter(({ artifact, source }) => distArtifact(source) === artifact)
    .filter(({ source }) => existsSync(path.join(root, source)));
  const compiled = pairs
    .filter(({ artifact, source }) => artifact !== `dist/${source}`)
    .map(({ artifact }) => artifact);
  const fresh = compiled.length > 0 ? freshEmit(root, compiled) : new Map();
  return pairs
    .filter(({ artifact, source }) => {
      const expected = fresh.has(artifact)
        ? fresh.get(artifact)
        : readFileSync(path.join(root, source));
      return expected === undefined || !readFileSync(path.join(root, artifact)).equals(expected);
    })
    .map(({ artifact }) => artifact)
    .sort();
}

/** A path this writer may create: canonical, built from a source on disk, and untracked at base. */
function writable(
  root: string,
  artifact: string,
  atBase: Map<string, unknown>,
  distArtifact: (source: string) => string | undefined,
): boolean {
  const source = distSource(artifact);
  return (
    artifact.startsWith('dist/') &&
    path.posix.normalize(artifact) === artifact &&
    distArtifact(source) === artifact &&
    existsSync(path.join(root, source)) &&
    !atBase.has(artifact)
  );
}

/**
 * Writes exactly the named NEW dist artifacts from the same fresh build the stale check compares
 * against, so the result passes it. Tracked dist is refused: rebuilding it is release-only.
 */
export function writeNewDist(
  root: string,
  artifacts: string[],
  atBase: Map<string, unknown>,
  distArtifact: (source: string) => string | undefined,
): void {
  const refused = artifacts.filter((file) => !writable(root, file, atBase, distArtifact));
  if (refused.length > 0) {
    throw new Error(
      `not a new dist artifact with a source on disk (tracked dist is release-only): ${refused.join(', ')}`,
    );
  }
  const compiled = artifacts.filter((file) => file !== `dist/${distSource(file)}`);
  const fresh = compiled.length > 0 ? freshEmit(root, compiled) : new Map();
  const unemitted = compiled.filter((file) => fresh.get(file) === undefined);
  if (unemitted.length > 0) throw new Error(`tsc emitted nothing for: ${unemitted.join(', ')}`);
  for (const file of artifacts) {
    const dest = path.join(root, file);
    mkdirSync(path.dirname(dest), { recursive: true });
    // copyFileSync keeps the source's mode, as the release build's cpSync does for shell scripts.
    if (fresh.has(file)) writeFileSync(dest, fresh.get(file));
    else copyFileSync(path.join(root, distSource(file)), dest);
  }
}
