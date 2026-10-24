/**
 * A throwaway consumer, built from this checkout, that a `devkit ship --dry-gates` can run in:
 * seeded, initialised, committed as the base, with a change overlaid on top. It exists so a ship or
 * deterministic-gate change can show its real blocked-ship output without a hand-built harness.
 *
 * Used by `bun run playground --change <dir>` and by e2e/ship-proof.e2e.test.mts.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { missingDeclaredDependencies } from '../../gate-engine/coverage/dependencies.mts';
import { type Fixture, makeFixture, out } from './harness.mts';

export interface ShipProofOptions {
  /** Directory copied in as the base commit. Default: a README and `src/index.ts`. */
  seed?: string;
  /** Directory overlaid on the base; every file in it becomes a briefed ship path. */
  change: string;
  stack?: string;
  guards?: string;
}

export interface ShipProof {
  fx: Fixture;
  /** Holds the ship's TMPDIR (its gate worktree) and its telemetry sink and logs. */
  root: string;
  /** The briefed paths, relative to the repo. */
  paths: string[];
  /** The fixture env, with TMPDIR and DEVKIT_GATE_EVENTS scoped under `root`. */
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/** The base the playground seeds when no `--seed` is given. */
export function writeDefaultSeed(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# playground\n');
  writeFileSync(join(dir, 'src', 'index.ts'), 'export {};\n');
}

/** The fixture's node_modules symlinks the shared cached prefix, so a copy must never write into it. */
function copyInto(from: string, to: string): void {
  const skip = new Set(['node_modules', '.git']);
  cpSync(from, to, { recursive: true, filter: (src) => !skip.has(basename(src)) });
}

/** The fixture's node_modules is the devkit prefix, not a consumer install: drop what init declared that it lacks. */
function dropUninstalledDeps(repoDir: string): void {
  const manifest = join(repoDir, 'package.json');
  const missing = missingDeclaredDependencies(manifest, join(repoDir, 'node_modules'));
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  for (const section of [pkg.dependencies, pkg.devDependencies]) {
    for (const name of missing) if (section && Object.hasOwn(section, name)) delete section[name];
  }
  writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
}

function changedFiles(change: string): string[] {
  return readdirSync(change, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(change, join(entry.parentPath, entry.name)))
    .filter((path) => !path.split('/').some((part) => part === 'node_modules' || part === '.git'));
}

export async function prepareShipProof(options: ShipProofOptions): Promise<ShipProof> {
  const { seed, change, stack = 'generic', guards = 'size,fanout' } = options;
  const fx = await makeFixture('devkit-ship-proof-');
  const root = mkdtempSync(join(tmpdir(), 'devkit-ship-proof-root-'));
  const cleanup = () => {
    fx.cleanup();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    mkdirSync(join(root, 'tmp'));
    // Seeded before init, so init keeps a seeded guard.config.json rather than writing its own.
    if (seed) copyInto(seed, fx.repoDir);
    else writeDefaultSeed(fx.repoDir);
    const init = fx.run('devkit', [
      'init',
      '--stack',
      stack,
      '--guards',
      guards,
      '--yes',
    ]);
    if (init.status !== 0) throw new Error(`devkit init failed:\n${out(init)}`);
    dropUninstalledDeps(fx.repoDir);
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'base');
    fx.git('config', 'core.hooksPath', '.husky');
    // Ship needs an owner/repo origin; --dry-gates never contacts it.
    fx.git('remote', 'add', 'origin', 'git@github.com:acme/app.git');
    copyInto(change, fx.repoDir);
  } catch (error) {
    cleanup();
    throw error;
  }
  const env = {
    ...fx.env,
    TMPDIR: join(root, 'tmp'),
    DEVKIT_GATE_EVENTS: join(root, 'telemetry', 'gate-events.jsonl'),
  };
  return { fx, root, paths: changedFiles(change), env, cleanup };
}
