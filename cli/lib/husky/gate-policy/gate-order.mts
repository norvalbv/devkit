/** Gate run order across pre-commit then commit-msg for `devkit doctor`, from the builders' emit-order
 * constants (never selection order); gate-order.test.mts pins it to the generated hooks. */

import { DETERMINISTIC } from '../../../../gate-engine/deterministic/registry.mts';
import { normalizeSelection, type Selection } from '../../components.mts';
import { commitMsgGuards } from '../commit-msg-block.mts';
import { AI_GUARD_IDS, QAVIS_ADVISORY_ID } from '../husky-block.mts';
import { SELF_HOST_EXTRAS } from '../self-host.mts';

/** The install modes whose generated hooks order or prewarm gates differently. */
export type InstallMode = 'package' | 'standalone' | 'overlay' | 'self-host';

export type GateOrderSelection = Pick<
  Partial<Selection>,
  'guards' | 'antiSlop' | 'structure' | 'biome' | 'fallow'
>;

export interface GateOrder {
  preCommit: string[];
  commitMsg: string[];
}

// Only the package-bin review fragment (package, and self-host which rewrites it) starts the
// completeness judge in parallel on a ship; standalone/overlay call the global bin directly.
const COMPLETENESS_PREWARM_INSTALLS: InstallMode[] = ['package', 'self-host'];

// guard-deterministic's own run order (gate-engine/deterministic/run.mts): registry gates in
// registry order, then `--extra` commands, then structure — overlay never wires it, self-host always.
function deterministicParts(sel: Selection, install: InstallMode): string[] {
  const parts = DETERMINISTIC.filter((gate) => {
    const component = 'configComponent' in gate ? gate.configComponent : undefined;
    return component ? Boolean(sel[component]) : sel.guards.includes(gate.id);
  }).map((gate) => gate.id);
  if (install === 'self-host') parts.push(...SELF_HOST_EXTRAS.map((extra) => extra.label));
  if (install === 'self-host' || (sel.structure && install !== 'overlay')) parts.push('structure');
  return parts;
}

/** `recorded` is normalized exactly as the installers do, so a partial config reports the defaults
 * its generated hook actually runs. `pkgRel` set: a monorepo package block, which skips formatting. */
export function gateRunOrder(
  recorded: GateOrderSelection,
  install: InstallMode,
  pkgRel = '',
): GateOrder {
  const sel = normalizeSelection(recorded);
  const guards = sel.guards;
  const deterministic = deterministicParts(sel, install);
  // Package-bin blocks format first so the deterministic cache keys hash the post-format index.
  const formats = sel.biome && !pkgRel && (install === 'package' || install === 'self-host');
  const preCommit = formats ? ['format (biome)'] : [];
  if (deterministic.length) preCommit.push(`deterministic(${deterministic.join(',')})`);
  // Overlay's cheap blocking lint overlay runs before the judges (commit/ship, not review).
  if (install === 'overlay')
    preCommit.push(`lint overlay (eslint,biome${sel.fallow ? ',fallow' : ''})`);
  for (const id of AI_GUARD_IDS.filter((g) => guards.includes(g)))
    preCommit.push(
      id === 'review' && COMPLETENESS_PREWARM_INSTALLS.includes(install)
        ? 'review [+completeness prewarm on ship]'
        : id,
    );
  // Overlay deliberately carries no sentry prewarm: its commit-msg judge runs sentry after the advisory.
  if (guards.includes('sentry') && install !== 'overlay') preCommit.push('sentry [ship prewarm]');
  if (guards.includes(QAVIS_ADVISORY_ID)) preCommit.push(QAVIS_ADVISORY_ID);
  if (install === 'self-host') preCommit.push('fallow [advisory]', 'skill-projection [advisory]');
  const commitMsg =
    install === 'self-host'
      ? []
      : commitMsgGuards(guards).map((id) => (id === 'review' ? 'completeness' : id));
  return { preCommit, commitMsg };
}

/** `commitMsgVerified: false` — the installed commit-msg hook is missing or stale, so its order is
 * not claimed (that hook's own doctor row names the repair). */
export function formatGateOrder(
  { preCommit, commitMsg }: GateOrder,
  { commitMsgVerified = true }: { commitMsgVerified?: boolean } = {},
): string {
  const msg =
    commitMsg.length && !commitMsgVerified ? ['not verified (hook missing or stale)'] : commitMsg;
  return (
    [
      ['pre-commit', preCommit],
      ['commit-msg', msg],
    ] as const
  )
    .filter(([, rows]) => rows.length)
    .map(([hook, rows]) => `${hook}: ${rows.join(' → ')}`)
    .join(' · ');
}
