/**
 * E2E harness — proves the SHIPPED CLI works, not the source.
 *
 * The unit suites run `cli/index.mts` via type-stripping; they never exercise the `dist/*.mjs` bins a
 * consumer installs, so bin-resolution / dist-asset / pin bugs are invisible to them. This harness
 * closes that gap: build → `bun pm pack` → install the tarball into an isolated prefix → symlink that
 * prefix's node_modules into a throwaway git repo → run the REAL installed `devkit`/`guard-*` bins.
 *
 * Shared by the `*.e2e.test.mts` suites and by `scripts/playground.mts` (same bootstrap, one an
 * asserted run, the other an interactive shell).
 */
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root: two dirs up from e2e/lib/. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Where installed prefixes are cached across runs, keyed by a source-tree hash. */
export const CACHE_ROOT = join(tmpdir(), 'devkit-e2e-cache');

/**
 * User-facing marker strings the suites assert on. Kept here (not inline) so a source rename is
 * caught by one cheap grep test (cli/__tests__/e2e-markers.test.mts) instead of a slow e2e failure.
 * These are corroboration only — exit codes + on-disk artifacts are the primary signals.
 */
export const MARKERS = {
  detGates: '🚧 Deterministic gates',
  // The fan-out ratchet is the reliable deterministic block: a folder over its cap trips exit 1
  // deterministically, with no index / jscpd / network and no baseline-grandfather escape for a
  // folder created after init. (The eslint structure gate does NOT forbid unlisted/misnamed files.)
  fanoutExceeded: '🚫 Folder fan-out exceeded',
  doctorClean: 'All checks OK.',
  doctorHuskyMissing: '✗ .husky/pre-commit: MISSING',
  doctorUninitialized: '.devkit/config.json: not initialized',
} as const;

/** Absolute path to a binary on the current PATH, or throw a clear precondition error. */
export function whichAbs(bin: string): string {
  try {
    return execFileSync('which', [bin], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`e2e harness precondition: '${bin}' not found on PATH — install it and retry.`);
  }
}

const BUN = whichAbs('bun');
const GIT = whichAbs('git');
const BUN_BIN_DIR = dirname(BUN);

/** Source roots whose bytes determine whether a rebuild is needed. Covers everything the tarball
 *  ships (copy-dist-assets mirrors templates/skills/agents into dist/) plus the build inputs. */
const SOURCE_ROOTS = ['cli', 'gate-engine', 'scripts', 'templates', 'skills', 'agents', 'agents-hooks'];
const SOURCE_FILES = ['package.json', 'tsconfig.json', 'tsconfig.build.json'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '__tests__', 'coverage']);

/** Recursively collect files under a dir, skipping build/vcs/test noise. */
export function collectFiles(abs: string, rel: string, out: string[]): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return; // a root that doesn't exist (e.g. agents/) simply contributes nothing
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.gitignore') continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collectFiles(join(abs, e.name), `${rel}/${e.name}`, out);
    } else if (e.isFile()) {
      out.push(`${rel}/${e.name}`);
    }
  }
}

/** A short digest of the source tree. Unchanged source → identical digest → skip build + install. */
export function hashSourceTree(root: string = REPO_ROOT): string {
  const files: string[] = [];
  for (const r of SOURCE_ROOTS) collectFiles(join(root, r), r, files);
  for (const f of SOURCE_FILES) if (existsSync(join(root, f))) files.push(f);
  files.sort();
  const h = createHash('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    h.update(readFileSync(join(root, rel)));
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * Whether to force a from-scratch rebuild. DEVKIT_E2E_FRESH honored ONLY in the main process
 * (globalSetup / playground) — NEVER inside a vitest worker, or every worker would concurrently
 * rm+rebuild the shared prefix and corrupt the in-flight tarball (observed: ZlibError). Workers
 * always cache-hit what globalSetup built.
 */
export function shouldRebuildFresh(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.DEVKIT_E2E_FRESH && !env.VITEST_WORKER_ID;
}

function runOrThrow(bin: string, args: string[], cwd: string, label: string): void {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(
      `e2e harness: ${label} failed (exit ${r.status}).\n${r.stdout ?? ''}\n${r.stderr ?? ''}`,
    );
  }
}

let prefixPromise: Promise<string> | undefined;

/**
 * Build devkit, pack it, and install the tarball into an isolated prefix — ONCE. Memoized per
 * process and cached across runs on the source-tree hash. On a cache hit the build is skipped
 * entirely (fast). On a miss the build runs and THROWS on failure, so a broken source can never fall
 * through to a stale dist and pass green — a cached key always means "this source built cleanly".
 *
 * @returns the realpath'd prefix dir; its node_modules/.bin holds the installed devkit + guard-* bins.
 */
export function ensureInstalledPrefix(): Promise<string> {
  if (prefixPromise) return prefixPromise;
  prefixPromise = (async () => {
    const key = hashSourceTree();
    const prefix = join(CACHE_ROOT, key);
    const marker = join(prefix, 'node_modules', '.bin', 'devkit');
    if (existsSync(marker) && !shouldRebuildFresh()) return realpathSync(prefix);

    // Miss (or forced fresh): rebuild from scratch under this key.
    rmSync(prefix, { recursive: true, force: true });
    mkdirSync(prefix, { recursive: true });

    // Build FIRST, throw on failure — the B1 fix. Never proceed to pack against a stale/partial dist.
    runOrThrow(BUN, ['run', 'build'], REPO_ROOT, 'bun run build');

    // Pack — --ignore-scripts stops the `prepare:husky` lifecycle mutating the dev repo.
    runOrThrow(BUN, ['pm', 'pack', '--ignore-scripts', '--destination', prefix], REPO_ROOT, 'bun pm pack');
    const tgz = readdirSync(prefix).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error(`e2e harness: no .tgz produced in ${prefix}`);

    // Isolated consumer-real install (never machine-global).
    writeFileSync(
      join(prefix, 'package.json'),
      `${JSON.stringify({ name: 'devkit-e2e-host', private: true, type: 'module' }, null, 2)}\n`,
    );
    runOrThrow(BUN, ['add', join(prefix, tgz)], prefix, 'bun add <tgz>');

    return realpathSync(prefix);
  })();
  return prefixPromise;
}

export interface Fixture {
  /** The throwaway git repo the CLI runs against. */
  repoDir: string;
  /** The prefix-scoped env used for every run() (bins on PATH, git config isolated). */
  env: NodeJS.ProcessEnv;
  /** Run an installed bin (devkit / guard-*) or `git` in the fixture; returns the spawn result. */
  run: (bin: string, args: string[], opts?: { input?: string }) => SpawnSyncReturns<string>;
  /** Convenience: run `git` in the fixture. */
  git: (...args: string[]) => SpawnSyncReturns<string>;
  /** Remove the fixture repo (the symlink entry only — never the shared prefix target). */
  cleanup: () => void;
}

/**
 * A fresh throwaway git repo with the installed prefix's node_modules symlinked in (instant — no
 * per-test install). Cheap; call once per test. The prefix must already exist (globalSetup builds it).
 */
export async function makeFixture(dirPrefix = 'devkit-e2e-repo-'): Promise<Fixture> {
  const prefix = await ensureInstalledPrefix();
  const binDir = join(prefix, 'node_modules', '.bin');
  const repoDir = realpathSync(mkdtempSync(join(tmpdir(), dirPrefix)));

  writeFileSync(
    join(repoDir, 'package.json'),
    `${JSON.stringify({ name: 'fixture', version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`,
  );
  writeFileSync(join(repoDir, '.gitignore'), 'node_modules\n');
  // Symlink the whole installed node_modules — bins + prod deps, resolved via the symlink at commit
  // time exactly as a consumer would. The gate scan target is cwd (repoDir), never the prefix.
  symlinkSync(join(prefix, 'node_modules'), join(repoDir, 'node_modules'), 'dir');

  // A dev-set DEVKIT_REPO (git+ssh / local-path) would flow into the init pin and fail flow (a);
  // GIT_DIR-family + JSCPD_BIN are already stripped by vitest.setup.mjs.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${BUN_BIN_DIR}:${process.env.PATH ?? ''}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  delete env.DEVKIT_REPO;

  const resolve = (bin: string) => (bin === 'git' ? GIT : join(binDir, bin));
  const run: Fixture['run'] = (bin, args, opts = {}) =>
    spawnSync(resolve(bin), args, { cwd: repoDir, encoding: 'utf8', input: opts.input, env });
  const git: Fixture['git'] = (...args) => run('git', args);

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  git('config', 'commit.gpgsign', 'false');

  return {
    repoDir,
    env,
    run,
    git,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

/** Combined stdout+stderr of a spawn result — hook output routing is git-version-dependent. */
export const out = (r: SpawnSyncReturns<string>): string => `${r.stdout ?? ''}${r.stderr ?? ''}`;

/** `git rev-list --count HEAD` as a number (0 if no commits yet). */
export function headCount(fx: Fixture): number {
  const r = fx.git('rev-list', '--count', 'HEAD');
  return r.status === 0 ? Number.parseInt(r.stdout.trim(), 10) : 0;
}

/** Exposed for the grep test / callers that just need paths without building. */
export function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile();
}
