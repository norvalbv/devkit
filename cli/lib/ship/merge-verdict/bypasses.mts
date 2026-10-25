// The GUARD_* bypasses and waived findings behind each PR commit's gate run, or why they cannot be
// read: an unread record must never read as "none".
import { z } from 'zod';
import { envBool, envVar } from '../../../../gate-engine/config.mts';
import { emitGateEvent } from '../../../../gate-engine/judge/gate-events.mts';
import { readShipEvents } from '../digest/gate-digest.mts';
import { scanBackward } from '../digest/tail.mts';

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
export const REAIM_FLAGS = ['REVIEW_SKIP', 'DECISIONS_DIR', 'ALLOWLIST_PATH'] as const;
/** Hard by default; an explicit =0 softens the gate to a warning. */
export const SOFTEN_FLAGS = ['COMPLETENESS_HARD', 'SENTRY_HARD'] as const;

/** review_skipped reasons a one-run control causes, under the control's own name. */
const SKIP_CONTROLS = new Map([
  ['gate_disabled', 'GUARD_NO_REVIEW'],
  ['GUARD_REVIEW_SKIP', 'GUARD_REVIEW_SKIP'],
]);

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

/** This attempt's bypasses, or undefined when its gate chain has not passed. */
export function attemptBypasses(sink: string, shipId: string): string[] | undefined {
  const all = readShipEvents(sink, shipId).map((event) => rowSchema.parse(event));
  const opened = all.map((row) => row.type).lastIndexOf('ship_attempt');
  const rows = opened < 0 ? [] : all.slice(opened);
  if (!rows.some((row) => row.type === 'ship_result' && row.exit_code === 0)) return undefined;
  return [...new Set([...envBypasses(), ...rowBypasses(rows)])];
}

/** One commit since the PR base, with its committer time bounding how far back its record can be. */
export interface PrCommit {
  sha: string;
  committedMs: number;
}

const GATED = 'ship_gated';
/** A record is written after its commit; the day absorbs clock skew between the two. */
const SKEW_MS = 24 * 60 * 60 * 1000;
const gatedSchema = z.object({
  type: text,
  ts: text,
  head: text,
  bypasses: z.array(z.string()).optional().catch(undefined),
});
type Gated = z.infer<typeof gatedSchema>;

// Records and ship_attempt rows parse (head is optional, so an attempt row keeps only its ts as
// the scan's clock); every other sink row is skipped.
function parseGated(line: string): Gated | undefined {
  if (!line.includes(`"${GATED}"`) && !line.includes('"ship_attempt"')) return undefined;
  try {
    return gatedSchema.parse(JSON.parse(line));
  } catch {
    return undefined;
  }
}

const recordsFor = (rows: Gated[], shas: Set<string>): Gated[] =>
  rows.filter((row) => row.type === GATED && shas.has(row.head ?? '') && row.bypasses);

/** Each PR commit's passing gate record, read by sha, with this process's own controls added. */
export function shipBypasses(
  sink: string | undefined,
  commits: PrCommit[],
): string[] | { unknown: string } {
  if (!sink) return { unknown: 'no devkit ship gate run' };
  if (!commits.length) return { unknown: 'no commits since the PR base' };
  const shas = new Set(commits.map((commit) => commit.sha));
  const floor = Math.min(...commits.map((commit) => commit.committedMs)) - SKEW_MS;
  const found = (kept: Gated[]) => new Set(recordsFor(kept, shas).map((row) => row.head)).size;
  const rows = scanBackward(
    sink,
    parseGated,
    (kept) => found(kept) === shas.size || Date.parse(kept[0]?.ts ?? '') < floor,
    Number.POSITIVE_INFINITY,
  );
  const records = recordsFor(rows, shas);
  const missing = commits.filter(({ sha }) => !records.some((row) => row.head === sha));
  if (missing.length) {
    const more = missing.length > 1 ? ` and ${missing.length - 1} more` : '';
    return {
      unknown: `no passing devkit ship gate record for ${missing[0].sha.slice(0, 12)}${more}`,
    };
  }
  return [...new Set([...envBypasses(), ...records.flatMap((row) => row.bypasses ?? [])])];
}

// CLI: `node bypasses.mjs record <head-sha>`. commit-with-gate-capture.sh calls it after a passing
// gate run, so the verdict can read this commit's record by sha.
if (/[/\\]bypasses\.m[jt]s$/.test(process.argv[1] ?? '') && process.argv[2] === 'record') {
  const head = process.argv[3] ?? '';
  const { DEVKIT_SHIP_ID: shipId, DEVKIT_GATE_EVENTS: sink } = process.env;
  const bypasses = shipId && sink ? attemptBypasses(sink, shipId) : undefined;
  if (bypasses && /^[0-9a-f]{40,64}$/.test(head)) emitGateEvent({ type: GATED, head, bypasses });
}
