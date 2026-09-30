/** guard-deterministic's one exception to aggregation: coverage runs first and an absent artifact stops
 *  the suite, on the gate's own verdict. Why: docs/decisions/ship-gates-converge-not-restart.md. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ABSENT, ABSENT_SIGNAL_ENV } from '../coverage/absent-signal.mts';

interface RunnableGate {
  id?: string;
  label: string;
}

// By registry id, never by label: an --extra gate may be labelled anything, including guard-coverage.
const isCoverage = (gate: RunnableGate | undefined) => gate?.id === 'coverage';
// The signal file handed to the coverage gate's current run (one gate run at a time, sequentially).
let signalDir: string | null = null;

/** Sort the coverage gate to the front, in place, keeping every other gate's order. */
export function coverageFirst<T extends RunnableGate>(gates: T[]): T[] {
  return gates.sort((a, b) => Number(isCoverage(b)) - Number(isCoverage(a)));
}

/** The environment a gate runs under: the coverage gate alone also gets a fresh signal file. With no
 *  channel (an unwritable temp dir) it runs without one, so the runner aggregates as before sc-3712. */
export function gateEnv(gate: RunnableGate): NodeJS.ProcessEnv {
  signalDir = null;
  if (!isCoverage(gate)) return process.env;
  try {
    signalDir = mkdtempSync(path.join(tmpdir(), 'devkit-coverage-signal-'));
  } catch {
    return process.env;
  }
  return { ...process.env, [ABSENT_SIGNAL_ENV]: path.join(signalDir, 'reason') };
}

/** What the coverage gate's run just signalled, consuming the channel. */
function takeSignal(): string | null {
  if (!signalDir) return null;
  const dir = signalDir;
  signalDir = null;
  try {
    return readFileSync(path.join(dir, 'reason'), 'utf8');
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** True when `gates[index]` is the coverage gate that failed AND said the artifact is absent: its failure
 *  is recorded, the suite stops, and every later gate is named as NOT RUN so none reads as passed. */
export function stopOnAbsentCoverage(
  gates: ReadonlyArray<RunnableGate>,
  index: number,
  rc: number,
  fails: string[],
): boolean {
  if (!isCoverage(gates[index])) return false;
  if (takeSignal() !== ABSENT || rc !== 1) return false;
  fails.push(gates[index].label);
  const notRun = gates.slice(index + 1).map((g) => g.label);
  if (notRun.length > 0) {
    console.error(
      `⏭  No coverage data, so ${notRun.length} deterministic gate(s) did NOT run:${notRun.map((g) => ` ${g}`).join('')}`,
    );
    console.error(
      '   Generate coverage (remedy above), then re-run: these gates still have to pass.',
    );
  }
  return true;
}
