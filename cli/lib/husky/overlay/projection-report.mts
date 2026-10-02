/** The one projection repair and its report, shared by doctor, the overlay pre-commit (devkit
 * sync-worktree) and devkit review and ship. Rationale: docs/decisions/overlay-self-heal.md. */

import { sameDir } from '../../doctor/hooks-path.mts';
import { hasOwnOverlay, projectionGaps, repairProjection } from './overlay-home.mts';

const MAX_LISTED = 5;
const listed = (paths: string[]) =>
  paths.length > MAX_LISTED
    ? `${paths.slice(0, MAX_LISTED).join(', ')} +${paths.length - MAX_LISTED} more`
    : paths.join(', ');

/** Report `path`'s projection gaps, or with `fix` close them (links the shared inputs, copies the
 * branch-local ones); false while any gap stays open. */
export function printProjectionGaps(
  path: string,
  home: string,
  pkgRel: string,
  fix: boolean,
): boolean {
  try {
    const { owed, unlinkable } = fix
      ? repairProjection(path, home, pkgRel)
      : projectionGaps(path, home, pkgRel);
    if (owed.length && fix) console.log(`  ✓ ${path}: projected ${listed(owed)} from the overlay`);
    else if (owed.length)
      console.log(
        `  ⚠ ${path}: ${listed(owed)} not projected from the overlay — gates there run without them; run \`devkit doctor --fix\``,
      );
    if (unlinkable.length)
      console.log(
        `  ⚠ ${path}: ${listed(unlinkable)} cannot be linked from the overlay — git ignores it only as a directory (a line ending in "/"), and a link is not one; add a line without the slash, such as \`${unlinkable[0]}\`, to .git/info/exclude`,
      );
    return (fix || !owed.length) && !unlinkable.length;
  } catch (e) {
    console.log(
      `  ⚠ ${path}: could not ${fix ? 'repair' : 'check'} the projection: ${e instanceof Error ? e.message : e}`,
    );
    return false;
  }
}

/** Project `home`'s overlay into the checkout `wt` that borrows it; false while a gap stays open. The
 * home itself, and a checkout with an overlay of its own, are left as they are. */
export function projectBorrowedOverlay(wt: string, home: string, pkgRel: string): boolean {
  return sameDir(home, wt) || hasOwnOverlay(wt) || printProjectionGaps(wt, home, pkgRel, true);
}
