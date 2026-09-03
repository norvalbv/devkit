/** Shared by every bench script: a flag reader that never swallows a neighbouring flag, and the env
 * reset that makes a bench run a bench (DEVKIT_NO_TELEMETRY=1 is what silences emitGateEvent). */

/** `--name value`; a flag with no value (end of argv, or the next token is another flag) must
 * NOT silently consume its neighbour or bypass the fallback. */
export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) return fallback;
  return value;
}

export const argOr = (name: string, fallback: string): string => arg(name) ?? fallback;

/** A positive-integer flag; anything else (NaN, 0, '2x') aborts instead of becoming a silent no-op. */
export function argInt(name: string, fallback: number, min = 1): number {
  const raw = arg(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min) {
    console.error(`--${name} must be an integer >= ${min}; got ${raw ?? fallback}`);
    process.exit(2);
  }
  return value;
}

export function silenceBenchTelemetry(): void {
  process.env.DEVKIT_NO_TELEMETRY = '1';
  delete process.env.DEVKIT_GATE_EVENTS;
  delete process.env.DEVKIT_SHIP_ID;
  delete process.env.DEVKIT_RUN_MODE;
}
