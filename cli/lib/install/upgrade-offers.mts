/**
 * What `devkit upgrade` OFFERS a repo whose recorded selection predates a feature — the two steps
 * that ask a question rather than reconcile a fact, lifted out of upgrade.mts so that command stays
 * the flat orchestration pipeline its header describes.
 *
 * Both share one shape, and it is the shape that matters:
 *   dry-run → announce; TTY → ask; non-TTY → decide by the step's own policy;
 *   and the ANSWER is recorded, so a decline is never re-asked.
 *
 * They differ on exactly one axis, deliberately. The line-growth cap HEALS on a non-TTY run (it is a
 * recommended ratchet on an already-selected guard, so silence means "yes"), whereas an optional
 * component is only ever REPORTED (an opt-in component must not arrive because someone ran upgrade
 * in CI). Keeping them side by side is what makes that divergence legible instead of accidental.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { confirm, isCancel, multiselect } from '@clack/prompts';
import {
  enableLineGrowth,
  hasLineCap,
  LINE_CAP,
  previewGrandfather,
} from '../../../gate-engine/ratchets/size-disable.mts';
import type { ComponentToggleId, OptionalComponent } from '../components.mts';
import { type Selection, unofferedComponents } from '../components.mts';

const interactive = () => Boolean(process.stdout.isTTY && process.stdin.isTTY);

// Print the outcome of a line-growth enable — honest when an unreadable guard.config.json meant the
// cap was NOT written (enableLineGrowth skips rather than crashing on a corrupt file).
function reportLineGrowth({
  enabled,
  grandfathered,
}: {
  enabled: boolean;
  grandfathered: number;
}): void {
  console.log(
    enabled
      ? `  ✓ line-growth block enabled (maxLines ${LINE_CAP}); grandfathered ${grandfathered} file(s)`
      : '  • could not enable line-growth block — guard.config.json unreadable; skipped',
  );
}

/**
 * Step 3b — back-fill the per-file `maxLines` cap for repos that predate it. It is a CONFIG KNOB on
 * the already-selected `size` guard (not a guard id), so newBundledGates never surfaces it: offer it
 * when size runs but guard.config.json has no cap. `sel.lineGrowth` defaults true (a legacy repo
 * never recorded it) → the offer fires once; declining records false (no re-nag), enabling writes the
 * cap. Enabling here ALSO grandfathers current giants (lines-only freeze), since upgrade's init pass
 * never re-freezes an adopted repo — without it their over-cap files would hard-error.
 *
 * Mutates `sel.lineGrowth` on a decline; the caller's applyInit persists it.
 */
export async function offerLineGrowth(cwd: string, sel: Selection, dryRun: boolean): Promise<void> {
  if (
    !sel.husky ||
    !sel.guards.includes('size') ||
    !sel.lineGrowth ||
    !existsSync(join(cwd, 'guard.config.json')) ||
    hasLineCap(cwd)
  )
    return;

  console.log('\n3b. line-growth block');
  if (dryRun) {
    console.log(
      `  [dry-run] would enable per-file line-growth block (maxLines ${LINE_CAP}; grandfathers ${previewGrandfather(cwd)} file(s))`,
    );
    return;
  }
  if (!interactive()) {
    // Non-TTY: auto-enable + freeze (heal like a recommended gate).
    reportLineGrowth(enableLineGrowth(cwd));
    return;
  }
  const yes = await confirm({
    message: `Enable the per-file line-growth block? Caps source files at ${LINE_CAP} lines; current giants are grandfathered (shrink-only), new growth is blocked.`,
    initialValue: true,
  });
  if (isCancel(yes) || !yes) {
    sel.lineGrowth = false; // record the decline so upgrade never re-nags
    console.log('  • line-growth block not enabled');
  } else {
    reportLineGrowth(enableLineGrowth(cwd));
  }
}

/**
 * Step 3c — offer every optional component this repo has never been asked about. The component
 * analog of step 3's gate reconcile.
 *
 * `recorded` MUST be the raw `.devkit/config.json` components block, never the normalized selection:
 * normalizeSelection fills every optional component with its default `false`, which is
 * indistinguishable from a repo that already declined, and the offer would never fire for anyone.
 *
 * Mutates `sel` with the answers and RETURNS the ids nobody actually answered, for the caller to
 * pass to applyInit as `undecided` — otherwise step 4's broad refresh records the normalized `false`
 * as a decision nobody made and suppresses the offer permanently.
 */
export async function offerOptionalComponents(
  recorded: Partial<Selection> | undefined,
  sel: Selection,
  dryRun: boolean,
  { unavailable = [] }: { unavailable?: ComponentToggleId[] } = {},
): Promise<string[]> {
  const allUnoffered = unofferedComponents(recorded);
  const unavailableIds = allUnoffered
    .filter((component) => unavailable.includes(component.id))
    .map((component) => component.id as string);
  const unoffered = allUnoffered.filter((component) => !unavailable.includes(component.id));
  // Name what these ARE (skills, …) rather than "components" — that is the internal word for the
  // selection toggle, and telling a user they can install a "component" says nothing. See
  // OptionalComponent.kind.
  const kinds = [...new Set(unoffered.map((c) => `${c.kind}s`))].join(' / ') || 'add-ons';
  console.log(`\n3c. newly bundled optional ${kinds}`);
  if (!unoffered.length) {
    console.log('  • none — selection unchanged');
    return unavailableIds;
  }
  const ids = unoffered.map((c) => c.id as string);
  const describe = (c: OptionalComponent) => `the ${c.label} ${c.kind}`;
  if (dryRun) {
    for (const c of unoffered) console.log(`  [dry-run] would offer ${describe(c)} (${c.hint})`);
    return [...ids, ...unavailableIds];
  }
  if (!interactive()) {
    // Non-TTY: REPORT, never auto-add — the same policy as step 3. Deliberately leaves the keys
    // absent so the repo still gets a real offer the next time someone upgrades interactively.
    for (const c of unoffered)
      console.log(
        `  • devkit bundles ${describe(c)} (${c.hint}) — enable with 'devkit init ${c.flag}'`,
      );
    return [...ids, ...unavailableIds];
  }

  const picked = await multiselect({
    message: `New optional ${kinds} available since your last install — select any to add`,
    options: unoffered.map((c) => ({ value: c.id, label: `${c.label} ${c.kind}`, hint: c.hint })),
    // Nothing pre-checked: these are opt-in by definition, so Enter must mean "no thanks".
    initialValues: [],
    required: false,
  });
  if (isCancel(picked)) {
    // Leave every key ABSENT so the offer fires again — a cancel is "ask me later", not a decline.
    console.log('  • skipped — will offer again on the next upgrade');
    return [...ids, ...unavailableIds];
  }
  const chosen = new Set(picked as string[]);
  for (const c of unoffered) sel[c.id] = chosen.has(c.id);
  if (sel.antiSlop) sel.oxc = true;
  console.log(
    chosen.size
      ? `  ✓ added: ${[...chosen].join(', ')}`
      : '  • none selected (recorded — this will not be offered again)',
  );
  return unavailableIds; // answered eligible ids record; unavailable ids stay absent for the future
}
