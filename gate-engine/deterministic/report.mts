/** The end-of-run reports of guard-deterministic: gates that opted out, and gates that failed. */
import { emitGateEvent } from '../judge/gate-events.mts';
import { GUARD_PREFIX_RE } from './command-gates.mts';
import { appendReviewNotice, type GateFailure, reasonDetail, reasonReport } from './reason.mts';
import { printRecheckFooter } from './recheck.mts';

/** The blocked_gate token the ship script publishes for this whole chain. */
export const DETERMINISTIC_FAMILY = 'deterministic';
// Exit 127 means the gate's binary never resolved: a dependency problem, not a code finding.
const NOT_FOUND_RE = /\(unexpected:127\)/;

/** A failing gate's bare name, and whether its exit code reached a verdict. */
export interface FailedGate {
  gate: string;
  verdict: boolean;
}

/** Names every gate that opted out, on a green run too: an opt-out proved nothing. */
export function reportOptedOut(skipped: string[]): void {
  if (skipped.length === 0) return;
  for (const label of skipped) {
    appendReviewNotice(`gate=${label} opted-out`);
    emitGateEvent({
      type: 'gate_result',
      gate: label.replace(GUARD_PREFIX_RE, ''),
      family: DETERMINISTIC_FAMILY,
      status: 'could_not_run',
      detail: `${label}(opted-out)`,
    });
  }
  const plural = skipped.length === 1 ? 'gate' : 'gates';
  console.error(
    `⚠ ${skipped.length} deterministic ${plural} opted out and did NOT run:${skipped.map((s) => ` ${s}`).join('')}`,
  );
  console.error('   The reason is printed above. A gate that opted out proved nothing.');
  console.error(
    '   `devkit doctor` reports whether that is a misconfiguration; GUARD_DETERMINISTIC_STRICT=1 makes it fatal.',
  );
}

/** One gate_result per failing gate, then the summary line ship's capture script greps and remedies. */
export function reportFailures(
  fails: readonly GateFailure[],
  failed: readonly FailedGate[],
  rechecks: string[],
): void {
  // A gate that never reached a verdict (`(unexpected:rc)`, `(could-not-run)`) is not a `fail`.
  // `family` lets a reader join this per-gate chain to the family-level blocked_gate.
  for (const [i, { label, reason }] of fails.entries()) {
    emitGateEvent({
      type: 'gate_result',
      gate: failed[i].gate,
      family: DETERMINISTIC_FAMILY,
      status: failed[i].verdict ? 'fail' : 'could_not_run',
      detail: reasonDetail(label, reason),
    });
  }
  console.error(`✗ deterministic gates failed:${fails.map((f) => ` ${f.label}`).join('')}`);
  for (const line of reasonReport(fails)) console.error(line);
  console.error('   Fix every failure above together, then commit once.');
  console.error('   On commit or ship, decision and reviewer gates run only after these pass.');
  printRecheckFooter(rechecks);
  if (fails.some((f) => f.label.startsWith('structure-lint'))) {
    console.error('   guard-structure blocks only violations your change adds, or all when');
    console.error('   it edits structure policy or deletes/renames. Fix those.');
    console.error('   GUARD_STRUCTURE_OK=1 is for base debt or a custom structure command.');
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
