/** Names a judge whose PASS keeps degrading in this repo, on the digest row that already reports it.
 * Narration only, like trend.mts: no exit, never fed to a reviewer, silent when it cannot key. */
import { z } from 'zod';
import {
  DEGRADED_KINDS,
  type DegradedKind,
} from '../../../../gate-engine/review/contracts/degraded-kinds.mts';
import type { DigestRow } from './gate-digest.mts';
import { scanBackward } from './tail.mts';
import type { ShipKey } from './trend.mts';

/** Attempts per judge the rate is taken over. */
const WINDOW = 10;
/** Attempts read back per repo: some attempts never reach a given judge (an earlier gate stopped them). */
const HISTORY_CAP = 2 * WINDOW;
/** Below this many degraded attempts in the window, a degradation is an incident, not a pattern. */
const MIN_DEGRADED = 5;

/** Printed once per kind; empty where no hint is known to be right — a wrong one costs trust. */
const HINTS = {
  'mcp-missing': 'codebase MCP did not reach the judge — the environment, not this diff',
  denied: "the judge's search-code call was refused by the headless permission gate",
  skipped: 'the judge chose not to search — a brief/judge issue, not this diff',
  unrecorded: '',
  unclassified: '',
} satisfies Record<DegradedKind, string>;

// Untrusted JSONL: a wrong-typed field degrades to absent instead of discarding the whole row.
const text = z.string().optional().catch(undefined);
const rowSchema = z.object({
  type: text,
  ship_id: z.string().min(1),
  repo: text,
  judge: text,
  reviewer: text,
  gate: text,
  kind: z.enum(DEGRADED_KINDS).optional().catch(undefined),
});
export type RecurrenceRow = z.infer<typeof rowSchema>;

interface Recurrence {
  degraded: number;
  window: number;
  kind: DegradedKind;
}

/** The I/O boundary: one sink line in, a row of `repo` carrying a ship_id, or nothing. */
function parseRow(line: string, repo: string): RecurrenceRow | undefined {
  try {
    const parsed = rowSchema.safeParse(JSON.parse(line));
    return parsed.success && parsed.data.repo === repo ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Rows grouped by attempt, oldest first, plus each ship_id's LATEST attempt. Every marker opens a
 * new one — a resumed ship reuses its id. An attempt whose marker the backward read cut is dropped. */
function attemptsOf(rows: RecurrenceRow[]) {
  const all: RecurrenceRow[][] = [];
  const latest = new Map<string, RecurrenceRow[]>();
  for (const row of rows) {
    if (row.type === 'ship_attempt') {
      const opened: RecurrenceRow[] = [];
      all.push(opened);
      latest.set(row.ship_id, opened);
    } else latest.get(row.ship_id)?.push(row);
  }
  return { all, latest };
}

/** The judge a row records a verdict (or a degraded verdict) for; skips and spawns are not verdicts. */
function verdictJudge(row: RecurrenceRow): string | undefined {
  if (row.type === 'review_result') return row.reviewer;
  if (row.type === 'gate_result') return row.gate;
  if (row.type === 'cache_hit') return row.judge?.replace(/^review:/, '');
  return row.type === 'gate_degraded' ? row.judge : undefined;
}

/** undefined = not degraded; null = degraded by an emitter that predates `kind`. */
function degradedKind(rows: RecurrenceRow[], judge: string): DegradedKind | null | undefined {
  const kinds = rows.filter((r) => r.type === 'gate_degraded' && r.judge === judge);
  if (kinds.length === 0) return undefined;
  return DEGRADED_KINDS.find((k) => kinds.some((r) => r.kind === k)) ?? null;
}

/** Pure: repo rows → the judges degraded on THIS ship that also degraded on most recent attempts. */
export function summariseRecurrence(rows: RecurrenceRow[], key: ShipKey): Map<string, Recurrence> {
  const found = new Map<string, Recurrence>();
  const attempts = attemptsOf(rows);
  const current = attempts.latest.get(key.shipId);
  if (!key.repo || !current) return found;
  const newestFirst = [...attempts.all].reverse();
  const judges = new Set(current.filter((r) => r.type === 'gate_degraded').map((r) => r.judge));
  for (const judge of judges) {
    // THIS ship's kind names the note, so its hint matches the cause printed on the same row; a
    // kind-less one (sentry's diff-specific downgrade, an older emitter) is never annotated.
    const kind = judge ? degradedKind(current, judge) : undefined;
    if (!judge || !kind) continue;
    const window = newestFirst
      .filter((rs) => rs.some((r) => verdictJudge(r) === judge))
      .slice(0, WINDOW);
    const degraded = window.filter((rs) => degradedKind(rs, judge) !== undefined).length;
    if (degraded >= MIN_DEGRADED) found.set(judge, { degraded, window: window.length, kind });
  }
  return found;
}

/** The newest HISTORY_CAP attempts of this ship's repo, read backward. Never throws. */
export function readRepoHistory(sink: string, key: ShipKey): RecurrenceRow[] {
  // Never key on an empty repo: that would blend every unkeyed ship on the machine.
  if (!key.shipId || !key.repo) return [];
  return scanBackward(
    sink,
    (line) => parseRow(line, key.repo),
    (kept) => attemptsOf(kept).all.length > HISTORY_CAP,
  );
}

/** Pure: appends each recurrence to the unverified row its judge already printed, hint once per kind. */
export function annotateRecurrence(rows: DigestRow[], found: Map<string, Recurrence>): DigestRow[] {
  const hinted = new Set<DegradedKind>();
  return rows.map((row) => {
    const rec = row.state === 'unverified' ? found.get(row.gate) : undefined;
    if (!rec) return row;
    const hint = HINTS[rec.kind] && !hinted.has(rec.kind) ? ` — ${HINTS[rec.kind]}` : '';
    hinted.add(rec.kind);
    const note = `degraded on ${rec.degraded} of the last ${rec.window} ships in this repo (${rec.kind})`;
    return { ...row, detail: `${row.detail} · ${note}${hint}` };
  });
}

/** The digest's one call: this ship's rows, annotated from the repo's recent history. */
export function withRecurrence(rows: DigestRow[], sink: string, key: ShipKey): DigestRow[] {
  return annotateRecurrence(rows, summariseRecurrence(readRepoHistory(sink, key), key));
}
