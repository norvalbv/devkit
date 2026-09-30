/** The coverage gate's explicit "I failed because the artifact is absent" signal to guard-deterministic,
 *  which stops the suite only on it — never on a later stat that could race the gate's own read. */
import { writeFileSync } from 'node:fs';

/** Set by the runner, for the coverage gate only, to a file the gate writes its reason into. */
export const ABSENT_SIGNAL_ENV = 'DEVKIT_COVERAGE_ABSENT_SIGNAL';
export const ABSENT = 'absent';

/** Best-effort: a runner that cannot read the signal just keeps aggregating, as before sc-3712. */
export function signalAbsent(): void {
  const file = process.env[ABSENT_SIGNAL_ENV];
  if (!file) return;
  try {
    writeFileSync(file, ABSENT);
  } catch {
    // Unwritable: no signal, so the runner aggregates — never a wrong stop.
  }
}
