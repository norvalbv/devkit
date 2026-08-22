import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  assertBaselineTrackable,
  indexTracksBaseline,
  stageBaselineMigration,
  stageBaseline,
} from './git-index.mts';

export const FANOUT_BASELINE = '.devkit/baselines/fanout.json';
export const LINES_BASELINE = '.devkit/baselines/size-lines.json';
export const SIZE_BASELINE = '.devkit/baselines/size.json';
export const LEGACY_FANOUT_BASELINE = 'eslint/baselines/fanout.json';
export const LEGACY_LINES_BASELINE = 'eslint/baselines/size-lines.json';
export const LEGACY_SIZE_BASELINE = 'eslint/baselines/size.json';

const LEGACY_RATCHET_BASELINES = [
  { from: LEGACY_FANOUT_BASELINE, to: FANOUT_BASELINE },
  { from: LEGACY_LINES_BASELINE, to: LINES_BASELINE },
  { from: LEGACY_SIZE_BASELINE, to: SIZE_BASELINE },
] as const;

const BASELINE_SETTLE = new Int32Array(new SharedArrayBuffer(4));

function sameBaselineDebt(left: Buffer, right: Buffer): boolean {
  if (left.equals(right)) return true;
  try {
    return isDeepStrictEqual(JSON.parse(left.toString('utf8')), JSON.parse(right.toString('utf8')));
  } catch {
    return false;
  }
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

/** Read debt across a concurrent legacy→canonical move without observing a false missing state. */
export function readRatchetBaseline(
  root: string,
  canonical: string,
  legacy: string,
): ReadRatchetBaseline | null {
  const read = (relativePath: string): ReadRatchetBaseline | null => {
    const bytes = readExisting(join(root, relativePath));
    return bytes ? { contents: bytes.toString('utf8'), relativePath } : null;
  };
  return read(canonical) ?? read(legacy) ?? read(canonical);
}

/** Persist current debt canonically; removing the legacy copy makes a concurrent migration safe. */
export function writeRatchetBaseline(
  root: string,
  canonical: string,
  legacy: string,
  contents: string,
  { stage = false }: { stage?: boolean } = {},
): void {
  const overlay = (() => {
    if (process.env.DEVKIT_OVERLAY === '1') return true;
    try {
      // SAFETY: init owns this local JSON marker; strict equality treats absent values as false.
      return (
        (
          JSON.parse(readFileSync(join(root, '.devkit/config.json'), 'utf8')) as {
            overlay?: boolean;
          }
        ).overlay === true
      );
    } catch {
      return false;
    }
  })();
  if (!overlay) assertBaselineTrackable(root, canonical);
  const canonicalFile = join(root, canonical);
  const legacyFile = join(root, legacy);
  mkdirSync(dirname(canonicalFile), { recursive: true });
  if (hasStableBaselineConflict(canonicalFile, legacyFile)) {
    throw new Error(
      `Devkit ratchet baseline write stopped: ${legacy} and ${canonical} contain different debt ceilings.`,
    );
  }
  const canonicalBytes = readExisting(canonicalFile);
  const legacyBytes = readExisting(legacyFile);
  if (canonicalBytes === null && legacyBytes !== null) {
    // Update the legacy inode first. A simultaneous migration hard-links this same inode, so both
    // names are identical for their entire overlap and the newer write cannot be stranded.
    writeFileSync(legacyFile, contents);
    try {
      linkSync(legacyFile, canonicalFile);
    } catch (error) {
      const concurrentCanonical = readExisting(canonicalFile);
      if (concurrentCanonical === null) throw error;
      writeFileSync(canonicalFile, contents);
    }
  } else {
    writeFileSync(canonicalFile, contents);
  }
  rmSync(legacyFile, { force: true });
  if (stage) {
    stageBaseline(root, canonical);
    stageBaseline(root, legacy);
  }
}

/** Clear debt from both storage generations so migration cannot preserve a stale copy. */
export function removeRatchetBaseline(
  root: string,
  canonical: string,
  legacy: string,
  { stage = false }: { stage?: boolean } = {},
): void {
  rmSync(join(root, canonical), { force: true });
  rmSync(join(root, legacy), { force: true });
  if (stage) {
    stageBaseline(root, canonical);
    stageBaseline(root, legacy);
  }
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
  { dryRun = false }: { dryRun?: boolean } = {},
): RatchetBaselineMigration[] {
  const present = LEGACY_RATCHET_BASELINES.flatMap(({ from, to }) => {
    const bytes = readExisting(join(root, from));
    return bytes ? [{ bytes, from, to }] : [];
  });
  // Recover cleanly if a prior run moved the file but Git staging was interrupted: the old index
  // entry still protects the debt, and this pass finishes the tracked rename.
  const pendingIndexMoves = LEGACY_RATCHET_BASELINES.flatMap(({ from, to }) =>
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
        linkSync(legacy, canonical);
      } catch (error) {
        const concurrentCanonical = readExisting(canonical);
        const concurrentLegacy = readExisting(legacy);
        if (concurrentCanonical === null && concurrentLegacy === null) {
          stageBaseline(root, action.from);
          continue;
        }
        if (
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
  console.log('0. ratchet baseline storage');
  for (const migration of migrations) {
    const action = migration.kind === 'moved' ? 'move' : 'remove duplicate';
    console.log(`  ${dryRun ? '[dry-run] ' : '✓ '}${action} ${migration.from} → ${migration.to}`);
  }
  console.log('');
}
