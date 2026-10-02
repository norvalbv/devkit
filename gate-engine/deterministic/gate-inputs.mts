/** The one registry of paths a gate reads that a clean checkout can lack; ship, review and overlay
 * projection derive from it. Rationale: docs/decisions/gate-inputs-single-registry.md. */

import { readdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { CONFIG_FILENAME, resolveFromCwd, resolveGuardConfig } from '../config.mts';
import {
  FANOUT_BASELINE,
  IMPORT_WALL_BASELINE,
  LINES_BASELINE,
  SIZE_BASELINE,
  STRUCTURE_BASELINE_DIR,
  STRUCTURE_EXEMPT,
} from '../ratchets/baseline-paths.mts';
import { FALLOW_CONFIG_FILES } from '../review/baseline-fallow-paths.mts';

type ConfigPathField = 'indexPath' | 'allowlistPath' | 'decisionsDir';

/** The `guard-review waive` store; the correctness override valve reads and writes it. */
export const CORRECTNESS_OVERRIDES_FILE = '.devkit/correctness-overrides.json';
/** qavis writes it on a QA pass for this checkout's HEAD; the qavis-advisory gate reads it. */
export const QAVIS_RECEIPT = '.qavis/receipt.json';

export interface GateInput {
  path: string;
  kind: 'file' | 'dir';
  /** Overlay worktree projection: `branch` copies, `clone` links to the home, `checkout` never projects. */
  share: 'branch' | 'clone' | 'checkout';
  /** A gate may rewrite it during a run, so review lets its private copy drift. */
  mutable?: true;
  /** Content-addressed: a committed copy is stale by construction and loses to the live one. */
  cache?: true;
  /** A machine-local cache devkit's own tools write: never commit-appropriate, linked or not. */
  localCache?: true;
  /** Churns under live writers, so review freezes it privately and skips the source drift check. */
  sourceVolatile?: true;
  /** devkit writes it, git-excluded, in an overlay install. */
  overlayWrites?: true;
  /** Each `*<suffix>` file is its own entry, so a tracked file cannot hide an untracked sibling. */
  eachFile?: string;
  /** Set when the location comes from this guard.config.json field. */
  field?: ConfigPathField;
}

const FIXED: readonly GateInput[] = [
  { path: CONFIG_FILENAME, kind: 'file', share: 'clone', overlayWrites: true },
  ...FALLOW_CONFIG_FILES.map((path): GateInput => ({ path, kind: 'file', share: 'clone' })),
  {
    path: '.fallow',
    kind: 'dir',
    share: 'clone',
    mutable: true,
    sourceVolatile: true,
    localCache: true,
  },
  { path: 'fallow-baselines', kind: 'dir', share: 'branch', mutable: true, overlayWrites: true },
  {
    path: '.decisions',
    kind: 'dir',
    share: 'clone',
    mutable: true,
    sourceVolatile: true,
    localCache: true,
  },
  // Ratchet freezes: absent, the fanout gate enforces against an empty freeze instead of failing
  // open. Per-file, not the directory, so a tracked freeze cannot hide an untracked sibling.
  ...[FANOUT_BASELINE, LINES_BASELINE, SIZE_BASELINE, IMPORT_WALL_BASELINE].map(
    (path): GateInput => ({ path, kind: 'file', share: 'branch', mutable: true }),
  ),
  { path: STRUCTURE_BASELINE_DIR, kind: 'dir', share: 'branch', mutable: true, eachFile: '.mjs' },
  { path: STRUCTURE_EXEMPT, kind: 'file', share: 'clone' },
  // Overlay git-excludes the Oxc capability; absent, the fail-closed anti-slop gate throws.
  { path: '.devkit/oxc', kind: 'dir', share: 'clone' },
  { path: '.devkit/anti-slop', kind: 'dir', share: 'clone' },
  // Branch-local: Node resolves a linked config's imports from the home.
  { path: 'eslint.config.devkit.mjs', kind: 'file', share: 'branch', overlayWrites: true },
  { path: 'biome.devkit.jsonc', kind: 'file', share: 'clone', overlayWrites: true },
  { path: 'oxlint.devkit.json', kind: 'file', share: 'clone', overlayWrites: true },
  // A ratchet ceiling lowered on one branch must not move the others. Only explicit anti-slop
  // commands write it, never a gate run, so it is not mutable.
  { path: '.anti-slop-baseline.json', kind: 'file', share: 'branch', overlayWrites: true },
  // File-level: `.qavis/` also holds the tracked recipe.json.
  { path: QAVIS_RECEIPT, kind: 'file', share: 'checkout', cache: true, localCache: true },
  // The correctness reconcile persists an override into it mid-run.
  { path: CORRECTNESS_OVERRIDES_FILE, kind: 'file', share: 'clone', mutable: true },
];

// Review flags the indexPath SQLite family (db, -wal, -shm) itself, via sqliteFamilyPath.
const CONFIG_INPUTS: readonly (Omit<GateInput, 'path'> & { field: ConfigPathField })[] = [
  { field: 'indexPath', kind: 'file', share: 'clone', localCache: true },
  // Branch-local, as a tracked allowlist is in package mode: an entry lands with the code it covers.
  { field: 'allowlistPath', kind: 'file', share: 'branch' },
  // Linked: records are append-only, so one clone-level store is safe.
  { field: 'decisionsDir', kind: 'dir', share: 'clone' },
];

function listEachFile(root: string, input: GateInput, suffix: string): GateInput[] {
  let names: string[];
  try {
    names = readdirSync(join(root, input.path));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(suffix) && !name.startsWith('.'))
    .sort()
    .map((name) => ({ ...input, path: `${input.path}/${name}`, kind: 'file' }));
}

function expand(root: string, input: GateInput): GateInput[] {
  return input.eachFile ? listEachFile(root, input, input.eachFile) : [input];
}

// `..cache` is a valid in-repo name, so only an actual parent segment escapes.
const PARENT_SEGMENT = /^\.\.(?:[\\/]|$)/;
const escapesRoot = (rel: string) => PARENT_SEGMENT.test(rel) || isAbsolute(rel);

/** The in-repo relative form of a configured path, or null for an unset or out-of-repo one. */
function repoRelative(root: string, abs: string | null): string | null {
  const rel = relative(root, abs ?? root);
  return rel && !escapesRoot(rel) ? rel : null;
}

/**
 * Every gate input under `root`. Fixed entries come first, so a caller streaming them keeps those
 * even when guard.config.json then fails to parse and the config-driven half throws.
 */
export function* gateInputs(root: string): Generator<GateInput> {
  for (const input of FIXED) yield* expand(root, input);
  const cfg = resolveGuardConfig(root);
  for (const input of CONFIG_INPUTS) {
    const path = repoRelative(root, resolveFromCwd(cfg, input.field));
    if (path) yield { ...input, path };
  }
}

/** The fixed entry at or above a projected `path`, for its flags. */
export function gateInputFor(path: string): GateInput | undefined {
  return FIXED.find((input) => path === input.path || path.startsWith(`${input.path}/`));
}
