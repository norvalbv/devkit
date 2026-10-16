// The GUARD_* bypasses and waived findings behind this ship's gate run, or why they cannot be read:
// an unread record must never read as "none".
import { z } from 'zod';
import { envBool, envVar } from '../../../../gate-engine/config.mts';
import { readShipEvents } from '../digest/gate-digest.mts';
import { SKIP_CONTROLS } from '../digest/skip-controls.mts';

/** Where this ship's gate rows live, captured before the evidence run clears DEVKIT_* from env. */
export interface ShipRecord {
  shipId: string | undefined;
  sink: string | undefined;
}

export const shipRecord = (env: NodeJS.ProcessEnv): ShipRecord => ({
  shipId: env.DEVKIT_SHIP_ID,
  sink: env.DEVKIT_GATE_EVENTS,
});

/** One-run controls that skip a gate, each read as GUARD_<name> or FRINK_<name>. */
export const BYPASS_FLAGS = [
  'NO_LOG',
  'DECISION_NO_LLM',
  'NO_REVIEW',
  'NO_COMPLETENESS',
  'NO_SENTRY_JUDGE',
  'SENTRY_NO_LLM',
  'COVERAGE_OK',
  'NO_COVERAGE',
  'STRUCTURE_OK',
  'NO_STRUCTURE',
  'MASS_DELETION_OK',
  'SHIP_BASE_OK',
  'SHIP_REPLACE_OK',
  'HOOK_PARITY_OK',
  'DECISIONS_INTEGRITY_OK',
  'DECISION_CHECKS_OK',
] as const;
/** Set to any value, these re-aim a gate or the verdict's own path classes. */
const REAIM_FLAGS = ['REVIEW_SKIP', 'DECISIONS_DIR', 'ALLOWLIST_PATH'] as const;
/** Hard by default; an explicit =0 softens the gate to a warning. */
const SOFTEN_FLAGS = ['COMPLETENESS_HARD', 'SENTRY_HARD'] as const;

// Untrusted JSONL from several emitters: a wrong-typed field reads as absent, the row is kept.
const text = z.string().optional().catch(undefined);
const list = z.array(z.unknown()).optional().catch(undefined);
const rowSchema = z.object({
  type: text,
  exit_code: z.number().optional().catch(undefined),
  bypass: text,
  reason: text,
  reviewer: text,
  judge: text,
  waivers: list,
  items: list,
});
type Row = z.infer<typeof rowSchema>;
const waivedItem = z.object({ disposition: z.literal('waived') });

function envBypasses(): string[] {
  return [
    ...BYPASS_FLAGS.filter((name) => envBool(name)).map((name) => `GUARD_${name}`),
    ...REAIM_FLAGS.filter((name) => envVar(name)?.trim()).map((name) => `GUARD_${name}`),
    ...SOFTEN_FLAGS.filter((name) => envBool(name) === false).map((name) => `GUARD_${name}=0`),
    // Husky's runner exits 0 before any hook runs.
    ...(process.env.HUSKY === '0' ? ['HUSKY=0'] : []),
  ];
}

const waived = (row: Row): boolean =>
  Boolean(row.waivers?.length) ||
  Boolean(row.items?.some((item) => waivedItem.safeParse(item).success));

function rowBypasses(rows: Row[]): string[] {
  return rows.flatMap((row) => {
    const skipped = row.type === 'review_skipped' && SKIP_CONTROLS.get(row.reason ?? '');
    return [
      ...(row.bypass ? [row.bypass] : []),
      ...(skipped ? [skipped] : []),
      ...(waived(row) ? [`waived:${row.reviewer ?? row.judge}`] : []),
    ];
  });
}

/**
 * Only a one-commit PR gated to a pass under this process's ship id has a record here: an earlier
 * commit was gated by a ship whose environment and id are gone.
 */
export function shipBypasses(
  { shipId, sink }: ShipRecord,
  commits: number,
): string[] | { unknown: string } {
  if (!shipId || !sink) return { unknown: 'no devkit ship gate run' };
  if (commits !== 1)
    return { unknown: `${commits} commits since the PR base, only a one-commit run is on record` };
  const all = readShipEvents(sink, shipId).map((event) => rowSchema.parse(event));
  const opened = all.map((row) => row.type).lastIndexOf('ship_attempt');
  const rows = opened < 0 ? [] : all.slice(opened);
  if (!rows.some((row) => row.type === 'ship_result' && row.exit_code === 0))
    return { unknown: 'no passing gate run on record for this ship' };
  return [...new Set([...envBypasses(), ...rowBypasses(rows)])];
}
