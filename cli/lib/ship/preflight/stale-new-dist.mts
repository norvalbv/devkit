// A briefed NEW dist artifact must match a fresh build of its source; tracked dist stays release-only.
// Ship never builds: it compares, so a caller's stale or re-checked-out artifact cannot pass.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/** A full emit takes about a second; the bound only catches a hung compiler. */
const TSC_TIMEOUT_MS = 60_000;

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
function freshEmit(
  root: string,
  artifacts: string[],
  timeoutMs: number,
): Map<string, Buffer | undefined> {
  const out = mkdtempSync(path.join(os.tmpdir(), 'devkit-fresh-dist-'));
  try {
    // The exit code is ignored: noEmitOnError is unset, so another file's type error still emits.
    // SIGKILL, because native tsc ignores SIGTERM mid-compile and spawnSync waits for it to exit.
    const { error, signal } = spawnSync(
      process.execPath,
      [checkoutTsc(root), '-p', path.join(root, 'tsconfig.build.json'), '--outDir', out],
      { cwd: root, stdio: 'ignore', timeout: timeoutMs, killSignal: 'SIGKILL' },
    );
    if (error) {
      const timedOut = 'code' in error && error.code === 'ETIMEDOUT';
      throw new Error(
        timedOut
          ? `tsc did not finish within ${timeoutMs / 1000}s`
          : `tsc could not run: ${error.message}`,
      );
    }
    if (signal) throw new Error(`tsc was killed by ${signal}`);
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
  tscTimeoutMs = TSC_TIMEOUT_MS,
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
  const fresh = compiled.length > 0 ? freshEmit(root, compiled, tscTimeoutMs) : new Map();
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
