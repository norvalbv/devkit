/**
 * The aggregated report of a red guard-deterministic run: one gate_result per failing gate, the
 * summary line ship's capture script greps, each gate's reason, and the remedy footer.
 */
import { emitGateEvent } from '../judge/gate-events.mts';
import { type GateFailure, reasonDetail, reasonReport } from './reason.mts';
import { printRecheckFooter } from './recheck.mts';

/** The blocked_gate token the ship script publishes for this whole chain. */
export const DETERMINISTIC_FAMILY = 'deterministic';
// Exit 127 means the gate's binary never resolved: a dependency problem, not a code finding.
const NOT_FOUND_RE = /\(unexpected:127\)/;

/** Whether a failing gate reached a verdict, keyed by its bare telemetry name. */
export interface FailedGate {
  gate: string;
  verdict: boolean;
}

/**
 * Print the red-run report. `notRun` lists afterGreen gates skipped because an earlier gate failed:
 * they get no gate_result, since the ship digest would read one as the gate that blocked the run.
 */
export function reportFailures(
  fails: readonly GateFailure[],
  failed: readonly FailedGate[],
  rechecks: string[],
  notRun: readonly string[],
): void {
  // A gate that never reached a verdict (unexpected exit, could-not-run) is not a finding.
  for (const [i, { label, reason }] of fails.entries()) {
    emitGateEvent({
      type: 'gate_result',
      gate: failed[i].gate,
      // Per-gate rows need the family to join the ship's family-level blocked_gate.
      family: DETERMINISTIC_FAMILY,
      status: failed[i].verdict ? 'fail' : 'could_not_run',
      detail: reasonDetail(label, reason),
    });
  }
  // Keep this line byte-stable: the ship capture script anchors on its end.
  console.error(`✗ deterministic gates failed:${fails.map((f) => ` ${f.label}`).join('')}`);
  for (const line of reasonReport(fails)) console.error(line);
  if (notRun.length > 0) {
    console.error(
      `   NOT run (an earlier gate failed): ${notRun.join(' ')} — they run on the next attempt once the failures above are fixed.`,
    );
    console.error('   Fix every failure above together, then commit again.');
  } else {
    console.error('   Fix every failure above together, then commit once.');
  }
  console.error('   On commit or ship, decision and reviewer gates run only after these pass.');
  printRecheckFooter(rechecks);
  if (fails.some((f) => f.label.startsWith('structure-lint'))) {
    console.error(
      '   Base branch structure debt that your diff did not cause? Re-run with the explicit',
    );
    console.error('   one-run assertion:  export GUARD_STRUCTURE_OK=1');
    console.error('   A structure violation introduced by your own change must be fixed instead.');
  }
  if (fails.some((f) => NOT_FOUND_RE.test(f.label))) {
    console.error(
      '   exit 127 = command not found: the gate ran, but its BINARY did not resolve — a',
    );
    console.error(
      '   dependency problem, not a code finding. Under `devkit ship` the gates run in an',
    );
    console.error(
      '   ephemeral worktree whose dependencies are symlinked in; check the "↳ linked …" lines',
    );
    console.error('   above for where each one actually resolved to.');
  }
}
