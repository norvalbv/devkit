import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { overlayInstall } from '../overlay-mode.mts';
import {
  assertBaselineTrackable,
  indexTracksBaseline,
  stageBaselineMigration,
  stageBaseline,
} from './git-index.mts';

export const FANOUT_BASELINE = '.devkit/baselines/fanout.json';
export const LINES_BASELINE = '.devkit/baselines/size-lines.json';
export const SIZE_BASELINE = '.devkit/baselines/size.json';
export const IMPORT_WALL_BASELINE = '.devkit/baselines/imports.mjs';
export const STRUCTURE_BASELINE_DIR = '.devkit/baselines/structure';
export const STRUCTURE_EXEMPT = '.devkit/structure/exempt.mjs';
// The legacy ESLint-owned generation is retired (sc-2256): gates neither read nor write these
// names. They survive only so init/upgrade migration can move a straggler repo's debt across.
const LEGACY_FANOUT_BASELINE = 'eslint/baselines/fanout.json';
const LEGACY_LINES_BASELINE = 'eslint/baselines/size-lines.json';
const LEGACY_SIZE_BASELINE = 'eslint/baselines/size.json';
export const LEGACY_IMPORT_WALL_BASELINE = 'eslint/baselines/imports.mjs';
export const LEGACY_STRUCTURE_BASELINE_DIR = 'eslint/baselines';
const LEGACY_STRUCTURE_EXEMPT = 'eslint/baselines/exempt.mjs';

const LEGACY_RATCHET_BASELINES = [
  { from: LEGACY_FANOUT_BASELINE, to: FANOUT_BASELINE },
  { from: LEGACY_LINES_BASELINE, to: LINES_BASELINE },
  { from: LEGACY_SIZE_BASELINE, to: SIZE_BASELINE },
] as const;

const LEGACY_BY_CANONICAL = new Map<string, string>(
  LEGACY_RATCHET_BASELINES.map(({ from, to }) => [to, from]),
);

// A retired copy left behind lets the next init/upgrade migration resurrect debt a gate just
// cleared, so every canonical write/clear disposes of the retired name THIS install owns (sc-2256).
function discardRetiredCopy(root: string, canonical: string, stage: boolean): void {
  const legacy = LEGACY_BY_CANONICAL.get(canonical);
  if (!legacy) return;
  // Overlay installs promise not to dirty the tree they land in, and `.git/info/exclude` cannot
  // hide a deletion: a TRACKED retired copy is the consumer's committed state, so leave it.
  if (overlayInstall(root) && indexTracksBaseline(root, legacy)) return;
  rmSync(join(root, legacy), { force: true });
  if (stage) stageBaseline(root, legacy);
}

function legacyDevkitBaselines(root: string) {
  const legacyDir = join(root, LEGACY_STRUCTURE_BASELINE_DIR);
  const canonicalDir = join(root, STRUCTURE_BASELINE_DIR);
  const modules = new Set(
    [legacyDir, canonicalDir].flatMap((dir) =>
      existsSync(dir)
        ? readdirSync(dir).filter(
            (name) => name.endsWith('.mjs') && name !== 'imports.mjs' && name !== 'exempt.mjs',
          )
        : [],
    ),
  );
  return [
    ...LEGACY_RATCHET_BASELINES,
    { from: LEGACY_IMPORT_WALL_BASELINE, to: IMPORT_WALL_BASELINE },
    { from: LEGACY_STRUCTURE_EXEMPT, to: STRUCTURE_EXEMPT },
    ...[...modules].sort().map((name) => ({
      from: `${LEGACY_STRUCTURE_BASELINE_DIR}/${name}`,
      to: `${STRUCTURE_BASELINE_DIR}/${name}`,
    })),
  ];
}

const BASELINE_SETTLE = new Int32Array(new SharedArrayBuffer(4));
const MODULE_TOKEN_RE =
  /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\s+|./g;

function comparableModuleTokens(contents: Buffer): string {
  return (contents.toString('utf8').match(MODULE_TOKEN_RE) ?? [])
    .filter((token) => !/^\s|^\/\//.test(token) && !token.startsWith('/*'))
    .join('');
}

function sameBaselineDebt(left: Buffer, right: Buffer): boolean {
  if (left.equals(right)) return true;
  try {
    return isDeepStrictEqual(JSON.parse(left.toString('utf8')), JSON.parse(right.toString('utf8')));
  } catch {
    // MJS baselines are declarative exports. Ignore comments and formatting while retaining every
    // executable token, so a generated-header change cannot masquerade as different debt.
    return comparableModuleTokens(left) === comparableModuleTokens(right);
  }
}

function canCopyAfterLinkFailure(error: NodeJS.ErrnoException): boolean {
  return error.code === 'EXDEV' || error.code === 'EPERM';
}

type BaselineLink = (existingPath: string, newPath: string) => void;
type BaselineCreate = (path: string, contents: Buffer) => void;

function createBaselineExclusively(path: string, contents: Buffer): void {
  writeFileSync(path, contents, { flag: 'wx' });
}

export interface RatchetBaselineMigration {
  from: string;
  to: string;
  kind: 'moved' | 'removed-duplicate';
}

export interface ReadRatchetBaseline {
  contents: string;
  relativePath: string;
}

function hasStableBaselineConflict(canonicalFile: string, legacyFile: string): boolean {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const canonical = readExisting(canonicalFile);
    const legacy = readExisting(legacyFile);
    if (canonical === null || legacy === null || sameBaselineDebt(canonical, legacy)) return false;
    if (attempt < 19) Atomics.wait(BASELINE_SETTLE, 0, 0, 5);
  }
  return true;
}

function concurrentBaselineCreateSettled(
  canonicalFile: string,
  legacyFile: string,
  expected: Buffer,
): boolean {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const canonical = readExisting(canonicalFile);
    const legacy = readExisting(legacyFile);
    if (canonical !== null) {
      if (sameBaselineDebt(canonical, expected)) return true;
      if (legacy !== null && sameBaselineDebt(canonical, legacy)) return true;
      if (legacy === null) {
        try {
          JSON.parse(canonical.toString('utf8'));
          return true;
        } catch {
          // The exclusive creator has published the name but is still writing its bytes.
        }
      }
    }
    if (attempt < 19) Atomics.wait(BASELINE_SETTLE, 0, 0, 5);
  }
  return false;
}

let replaceCounter = 0;

/** Replace canonical by rename: a truncating write would rewrite the inode a hard-linked retired
 * copy still shares, changing a tracked path this install must not touch. */
function replaceCanonical(canonicalFile: string, contents: string): void {
  // Ship projects .devkit/baselines into its worktree as a symlink whose write must reach the real
  // root file (git-index.mts), so rename beside the RESOLVED target instead of over the link.
  const target = resolvedTarget(canonicalFile);
  replaceCounter += 1;
  const temp = `${target}.devkit-${process.pid}-${replaceCounter}`;
  try {
    writeFileSync(temp, contents);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** The real path a canonical name resolves to; the name itself when nothing exists there yet. */
function resolvedTarget(canonicalFile: string): string {
  try {
    return realpathSync(canonicalFile);
  } catch {
    return join(realpathSync(dirname(canonicalFile)), basename(canonicalFile));
  }
}

/** Read the canonical debt ceiling; the legacy generation is retired (sc-2256). */
export function readRatchetBaseline(root: string, canonical: string): ReadRatchetBaseline | null {
  const bytes = readExisting(join(root, canonical));
  return bytes ? { contents: bytes.toString('utf8'), relativePath: canonical } : null;
}

/** Persist the current debt ceiling canonically. */
export function writeRatchetBaseline(
  root: string,
  canonical: string,
  contents: string,
  { stage = false }: { stage?: boolean } = {},
): void {
  if (!overlayInstall(root)) assertBaselineTrackable(root, canonical);
  const canonicalFile = join(root, canonical);
  mkdirSync(dirname(canonicalFile), { recursive: true });
  replaceCanonical(canonicalFile, contents);
  // Canonical is staged before the retired copy is discarded, so an interruption between the two
  // steps leaves the index carrying the new debt rather than a deletion without its replacement.
  if (stage) stageBaseline(root, canonical);
  discardRetiredCopy(root, canonical, stage);
}

/** Clear the debt ceiling from the canonical name and any stale retired copy. */
export function removeRatchetBaseline(
  root: string,
  canonical: string,
  { stage = false }: { stage?: boolean } = {},
): void {
  // The retired copy goes first where THIS install owns it, so migration cannot hard-link stale
  // debt back. An overlay's tracked copy is exempt above and stays for the next full install.
  discardRetiredCopy(root, canonical, stage);
  rmSync(join(root, canonical), { force: true });
  if (stage) stageBaseline(root, canonical);
}

function readExisting(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    // SAFETY: Node filesystem failures carry ErrnoException.code; unknown failures are rethrown.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Move Devkit-owned ratchet state out of the ESLint policy directory without re-snapshotting it.
 * Every conflict is checked before the first write so a partial migration cannot split authority.
 */
export function migrateRatchetBaselines(
  root: string,
  {
    dryRun = false,
    link = linkSync,
    create = createBaselineExclusively,
  }: { dryRun?: boolean; link?: BaselineLink; create?: BaselineCreate } = {},
): RatchetBaselineMigration[] {
  const legacyBaselines = legacyDevkitBaselines(root);
  const present = legacyBaselines.flatMap(({ from, to }) => {
    const bytes = readExisting(join(root, from));
    return bytes ? [{ bytes, from, to }] : [];
  });
  // Recover cleanly if a prior run moved the file but Git staging was interrupted: the old index
  // entry still protects the debt, and this pass finishes the tracked rename.
  const pendingIndexMoves = legacyBaselines.flatMap(({ from, to }) =>
    !existsSync(join(root, from)) && existsSync(join(root, to)) && indexTracksBaseline(root, from)
      ? [{ from, to }]
      : [],
  );
  const conflicts = present.filter(({ from, to }) => {
    return hasStableBaselineConflict(join(root, to), join(root, from));
  });
  if (conflicts.length > 0) {
    const details = conflicts
      .map(({ from, to }) => `both ${from} and ${to} exist with different contents`)
      .join('; ');
    throw new Error(
      `Devkit ratchet baseline migration stopped: ${details}. Keep the intended debt ceiling, remove the other copy, then rerun.`,
    );
  }

  const planned = [
    ...present.map(({ from, to }) => ({
      reconcileIndexOnly: false,
      action: {
        from,
        to,
        kind: existsSync(join(root, to)) ? 'removed-duplicate' : 'moved',
      } satisfies RatchetBaselineMigration,
    })),
    ...pendingIndexMoves.map(({ from, to }) => ({
      reconcileIndexOnly: true,
      action: { from, to, kind: 'moved' } satisfies RatchetBaselineMigration,
    })),
  ];
  const actions = planned.map(({ action }) => action);
  if (dryRun) return actions;

  // Preflight every destination before the first filesystem mutation.
  for (const { action } of planned) assertBaselineTrackable(root, action.to);

  for (const { action, reconcileIndexOnly } of planned) {
    if (reconcileIndexOnly) {
      stageBaselineMigration(root, action.from, action.to);
      continue;
    }
    const legacy = join(root, action.from);
    const canonical = join(root, action.to);
    const currentLegacy = readExisting(legacy);
    const currentCanonical = readExisting(canonical);
    if (currentLegacy === null) {
      if (currentCanonical === null) stageBaseline(root, action.from);
      else stageBaselineMigration(root, action.from, action.to);
      continue;
    }
    if (currentCanonical !== null) {
      if (!sameBaselineDebt(currentLegacy, currentCanonical)) {
        throw new Error(
          `Devkit ratchet baseline migration stopped: both ${action.from} and ${action.to} exist with different debt ceilings.`,
        );
      }
      rmSync(legacy, { force: true });
    } else {
      mkdirSync(dirname(canonical), { recursive: true });
      try {
        link(legacy, canonical);
      } catch (error) {
        const concurrentCanonical = readExisting(canonical);
        const concurrentLegacy = readExisting(legacy);
        if (concurrentCanonical === null && concurrentLegacy === null) {
          stageBaseline(root, action.from);
          continue;
        }
        // SAFETY: link() follows Node's filesystem contract and reports failures as ErrnoException.
        const linkFailure = error as NodeJS.ErrnoException;
        if (
          concurrentCanonical === null &&
          concurrentLegacy !== null &&
          canCopyAfterLinkFailure(linkFailure)
        ) {
          try {
            // Exclusive creation prevents a migration from overwriting a writer that won the race.
            create(canonical, concurrentLegacy);
          } catch (createError) {
            // SAFETY: create() follows Node's filesystem contract and reports failures as ErrnoException.
            const createFailure = createError as NodeJS.ErrnoException;
            if (
              createFailure.code !== 'EEXIST' ||
              !concurrentBaselineCreateSettled(canonical, legacy, concurrentLegacy)
            ) {
              throw createError;
            }
          }
        } else if (
          concurrentCanonical === null ||
          (concurrentLegacy !== null && !sameBaselineDebt(concurrentLegacy, concurrentCanonical))
        ) {
          throw error;
        }
      }
      rmSync(legacy, { force: true });
    }
    stageBaselineMigration(root, action.from, action.to);
  }
  return actions;
}

/** Migrate and print the lifecycle action in the init/upgrade progress stream. */
export function reportRatchetBaselineMigration(root: string, dryRun: boolean): void {
  const migrations = migrateRatchetBaselines(root, { dryRun });
  if (migrations.length === 0) return;
  console.log('0. devkit baseline storage');
  for (const migration of migrations) {
    const action = migration.kind === 'moved' ? 'move' : 'remove duplicate';
    console.log(`  ${dryRun ? '[dry-run] ' : '✓ '}${action} ${migration.from} → ${migration.to}`);
  }
  console.log('');
}
