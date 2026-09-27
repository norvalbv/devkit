// Review-gate clobbered-index tripwire (sc-3400): blocks a staged set that deletes most of HEAD.
import { execFileSync } from 'node:child_process';
import { envFlag } from '../../config.mts';
import { emitGateBypass } from '../../judge/gate-events.mts';
import { headHash } from '../evidence/staged-git.mts';

/** Below this many staged deletions the check never blocks: small cleanups are never a clobber. */
export const MASS_DELETION_FLOOR = 50;

export interface DeletionCensus {
  deleted: number;
  added: number;
  /** Files HEAD tracks; null when HEAD is unborn (nothing to clobber). */
  headTracked: number | null;
}

/**
 * Net deletions (D − A) covering at least half of what HEAD tracks. NET, so a move that rename
 * detection gave up on (diff.renameLimit) — reported as D+A pairs — is not a deletion.
 */
export function massDeletionVerdict({ deleted, added, headTracked }: DeletionCensus): boolean {
  if (headTracked === null || deleted < MASS_DELETION_FLOOR) return false;
  return 2 * (deleted - added) >= headTracked;
}

export type DeletionCounts = Pick<DeletionCensus, 'deleted' | 'added'>;

/** Count D and A records in `git diff --name-status -z` output. R/C records carry TWO paths. */
export function parseNameStatus(z: string): DeletionCounts {
  const fields = z.split('\0');
  let deleted = 0;
  let added = 0;
  for (let i = 0; i < fields.length;) {
    const status = fields[i] ?? '';
    if (status === '') break;
    if (status === 'D') deleted += 1;
    else if (status === 'A') added += 1;
    i += /^[RC]/.test(status) ? 3 : 2;
  }
  return { deleted, added };
}

const gitZ = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });

/** The staged D/A counts, plus HEAD's tracked-file count — read only when D reaches the floor. */
export function stagedDeletionCensus(cwd: string): DeletionCensus {
  const { deleted, added } = parseNameStatus(
    gitZ(cwd, ['diff', '--cached', '--name-status', '-z', '-M']),
  );
  if (deleted < MASS_DELETION_FLOOR) return { deleted, added, headTracked: null };
  const head = headHash(cwd);
  if (head === null) throw new Error('HEAD is unreadable — cannot size the staged deletion set');
  if (head.startsWith('unborn:')) return { deleted, added, headTracked: null };
  const headTracked = gitZ(cwd, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'])
    .split('\0')
    .filter(Boolean).length;
  return { deleted, added, headTracked };
}

/** 1 = blocked (message printed), 0 = clear or bypassed. Git failures throw to the caller. */
export function assertNoMassDeletion(cwd: string): 0 | 1 {
  const census = stagedDeletionCensus(cwd);
  if (!massDeletionVerdict(census)) return 0;
  const { deleted, added, headTracked } = census;
  if (envFlag('MASS_DELETION_OK')) {
    console.error(
      `guard-review: mass-deletion check BYPASSED (GUARD_MASS_DELETION_OK) — ${deleted} staged deletions of ${headTracked} tracked`,
    );
    emitGateBypass('review-mass-deletion', 'GUARD_MASS_DELETION_OK');
    return 0;
  }
  console.error(
    `guard-review: MASS DELETION — the staged set deletes ${deleted} of the ${headTracked} files HEAD tracks ` +
      `(net ${deleted - added} after ${added} additions). That is the signature of a clobbered index ` +
      "(a foreign GIT_INDEX_FILE / read-tree overwrote this repo's staged set), not a review finding. " +
      'Blocking. Inspect with `git diff --cached --stat`; restore with `git reset` and re-stage your ' +
      'intended changes. If this deletion is deliberate, re-run with GUARD_MASS_DELETION_OK=1.',
  );
  return 1;
}
