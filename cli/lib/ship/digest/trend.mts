/** sc-2165: names a reviewer whose blocks on this branch are not converging. Narration only — no exit,
 * never fed to a reviewer; why it exists: decision ship-gates-converge-not-restart. */
import { z } from 'zod';
import { emitGateEvent } from '../../../../gate-engine/judge/gate-events.mts';
import { scanBackward } from './tail.mts';

/** Below this many consecutive blocks a re-ship is ordinary iteration, not a loop. */
const MIN_STREAK = 3;
/** How far back one branch is walked; also bounds the backward read. */
const HISTORY_CAP = 20;
/** Counts shown before the series is elided at its old end. */
const SHOWN = 8;

// Untrusted JSONL: a wrong-typed field degrades to absent instead of discarding the whole row.
const text = z.string().optional().catch(undefined);
// Strict per lens: a lens that does not parse makes its round's count unknown, never blocking.
const lensSchema = z.object({
  lens: text,
  status: z.enum(['pending', 'pass', 'fail']),
  disposition: z.enum(['blocking', 'waived', 'dropped_out_of_charter']).optional(),
  issues: z.array(z.string()).optional(),
});
const trendRowSchema = z.object({
  type: text,
  ship_id: z.string().min(1),
  reviewer: text,
  status: text,
  judge: text,
  repo: text,
  branch: text,
  exit_code: z.number().optional().catch(undefined),
  items: z.array(z.unknown()).optional().catch(undefined),
});
export type TrendRow = z.infer<typeof trendRowSchema>;

/** One reviewer's streak on this branch, oldest first. `null` = the count was not recorded. */
export interface TrendLine {
  reviewer: string;
  counts: (number | null)[];
}

/** Which ship's history to read. repo + branch come from the ship's own exported envelope. */
export interface ShipKey {
  shipId: string;
  repo: string;
  branch: string;
}

interface Attempt {
  shipId: string;
  rows: TrendRow[];
  result?: TrendRow;
}

/** Why attemptsOf could not order the branch's rounds; `shipId` names the row that broke it. */
export interface Ambiguity {
  reason: 'same_id_marker' | 'foreign_row' | 'displaced_write';
  shipId: string;
}
type Why = { ambiguity?: Ambiguity };

/** The I/O boundary: one sink line in, a row carrying a ship_id or nothing. */
export function parseTrendRow(line: string): TrendRow | undefined {
  try {
    const parsed = trendRowSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Rows that are no round's: a retry's pre-marker rows and this module's own trend_suppressed event.
 * Inside an open attempt they would read as foreign. */
const PRE_MARKER = new Set(['ship_intent', 'judge_preflight', 'trend_suppressed']);

/** Records why the history is ambiguous, for a caller that asked, and bails like before. */
function bail(why: Why | undefined, reason: Ambiguity['reason'], shipId: string): null {
  if (why) why.ambiguity = { reason, shipId };
  return null;
}

const isKeyed = (row: TrendRow, key: ShipKey) =>
  row.ship_id === key.shipId && row.repo === key.repo && row.branch === key.branch;

/** Index of the last `type` row this ship wrote on its branch, or -1. */
function lastKeyed(rows: TrendRow[], type: string, key: ShipKey): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].type === type && isKeyed(rows[i], key)) return i;
  }
  return -1;
}

const isReviewFail = (row: TrendRow) =>
  row.type === 'review_result' && row.status === 'fail' && !!row.reviewer;

/** This branch's rows → its attempts in order, or null when two overlap (completion order is then not
 * round order). Markers open attempts: an inherited DEVKIT_SHIP_ID can span several. */
function attemptsOf(rows: TrendRow[], key: ShipKey, why?: Why): Attempt[] | null {
  const done: Attempt[] = [];
  let current: Attempt | undefined;
  const displaced = new Set<string>();
  for (const row of rows) {
    if (row.repo !== key.repo || row.branch !== key.branch || PRE_MARKER.has(row.type ?? ''))
      continue;
    // A displaced attempt that writes again was not killed: it overlapped, so rounds are out of order.
    if (displaced.has(row.ship_id)) return bail(why, 'displaced_write', row.ship_id);
    if (row.type === 'ship_attempt') {
      // Same id while open: an inherited id cannot tell a kill from an overlap. A new id: the open one died.
      if (current?.shipId === row.ship_id) return bail(why, 'same_id_marker', row.ship_id);
      if (current) displaced.add(current.shipId);
      current = { shipId: row.ship_id, rows: [] };
    } else if (!current) {
      // Outside any seen attempt: one the backward read cut off. Dropped, never guessed at.
      continue;
    } else if (row.ship_id !== current.shipId) {
      return bail(why, 'foreign_row', row.ship_id);
    } else if (row.type === 'ship_result') {
      current.result = row;
      done.push(current);
      current = undefined;
    } else current.rows.push(row);
  }
  return done;
}

/** The reviewer's last verdict row on the attempt, or a cached PASS, or nothing. */
function verdictOf(a: Attempt, reviewer: string): TrendRow | 'cached' | undefined {
  const own = a.rows.filter((r) => r.type === 'review_result' && r.reviewer === reviewer).pop();
  if (own) return own;
  return a.rows.some((r) => r.type === 'cache_hit' && r.judge === `review:${reviewer}`)
    ? 'cached'
    : undefined;
}

/** A failing lens the gate kept blocking. No `disposition` = an emitter that predates the field. */
function isBlocking(lens: z.infer<typeof lensSchema>): boolean {
  return lens.status === 'fail' && (lens.disposition ?? 'blocking') === 'blocking';
}

/** Blocking findings on a verdict row; null when its lens vector spilled, was never recorded, or
 * holds a lens that does not parse — the tally left by a spill counts waived lenses too. */
function countOf(row: TrendRow): number | null {
  if (!row.items) return null;
  let count = 0;
  for (const raw of row.items) {
    const lens = lensSchema.safeParse(raw);
    if (!lens.success) return null;
    if (isBlocking(lens.data)) count += Math.max(1, lens.data.issues?.length ?? 0);
  }
  return count;
}

/** Issues under the ONE blocking item named `lens`; null when the vector is absent, spilled or
 * unparseable, or when no item or several carry that lens (chunked parts each bring their own). */
export function issuesUnder(row: Pick<TrendRow, 'items'>, lens: string): number | null {
  // The digest's rows are cast, not parsed, so a hostile `items` can be any JSON value here.
  if (!Array.isArray(row.items)) return null;
  const counts: number[] = [];
  for (const raw of row.items) {
    const item = lensSchema.safeParse(raw);
    if (!item.success) return null;
    if (isBlocking(item.data) && item.data.lens === lens) {
      counts.push(item.data.issues?.length ?? 0);
    }
  }
  return counts.length === 1 ? counts[0] : null;
}

/** Rows through this ship's last result: later rows did not exist when its live digest ran, so a
 * replay must not let them silence it. Null when the ship cannot be keyed or has no result. */
function asOfResult(rows: TrendRow[], key: ShipKey): TrendRow[] | null {
  // Never key on an empty repo or branch: that would blend every unkeyed ship on the machine.
  if (!key.shipId || !key.repo || !key.branch) return null;
  const end = lastKeyed(rows, 'ship_result', key);
  return end < 0 ? null : rows.slice(0, end + 1);
}

/** This branch's finished attempts up to the current one, or null when the ship cannot be keyed. */
function branchAttempts(rows: TrendRow[], key: ShipKey) {
  const window = asOfResult(rows, key);
  const all = window && attemptsOf(window, key);
  if (!all) return null;
  const current = all.filter((a) => a.shipId === key.shipId).pop();
  return current ? { current, mine: all.slice(0, all.indexOf(current) + 1) } : null;
}

/** The reviewer's consecutive fail rows, oldest first, walking back from the newest attempt. */
function streakOf(mine: Attempt[], reviewer: string): TrendRow[] {
  const streak: TrendRow[] = [];
  for (let i = mine.length - 1; i >= 0 && streak.length < HISTORY_CAP; i--) {
    // A green ship ends the run: a later block on the same name is a new PR's first round.
    if (mine[i].result?.exit_code === 0) break;
    const verdict = verdictOf(mine[i], reviewer);
    if (verdict === 'cached' || verdict?.status === 'pass') break;
    // Another gate stopped it first, or the judge was inconclusive: no verdict, no reset.
    if (verdict?.status === 'fail') streak.unshift(verdict);
  }
  return streak;
}

/** Not converging = the latest count is no better than the best earlier round. Unknown counts prove
 * nothing, so the comparison needs a known latest and at least one known earlier round. */
function stalled(counts: (number | null)[]): boolean {
  const latest = counts[counts.length - 1];
  const earlier = counts.slice(0, -1).filter((n) => n !== null);
  return latest !== null && earlier.length > 0 && latest >= Math.min(...earlier);
}

/** Pure: sink rows → the streaks worth naming for the reviewers that blocked THIS ship. */
export function summariseTrend(rows: TrendRow[], key: ShipKey): TrendLine[] {
  const keyed = branchAttempts(rows, key);
  if (!keyed) return [];
  const blocking = new Set(keyed.current.rows.filter(isReviewFail).map((r) => r.reviewer ?? ''));
  const lines: TrendLine[] = [];
  for (const reviewer of blocking) {
    const streak = streakOf(keyed.mine, reviewer);
    if (streak.length < MIN_STREAK) continue;
    const counts = streak.map(countOf);
    if (stalled(counts)) lines.push({ reviewer, counts });
  }
  return lines;
}

/** The ambiguity that silenced this ship's trend, when its own current attempt blocked on review. */
export function trendSuppression(rows: TrendRow[], key: ShipKey): Ambiguity | undefined {
  const window = asOfResult(rows, key);
  const why: Why = {};
  if (!window || attemptsOf(window, key, why)) return undefined;
  const start = lastKeyed(window, 'ship_attempt', key);
  const blocked = start >= 0 && window.slice(start).some((r) => isKeyed(r, key) && isReviewFail(r));
  return blocked ? why.ambiguity : undefined;
}

/** The digest's trend text. A live ship whose line an ambiguity hid also records why, unprinted. */
export function trendNarration(rows: TrendRow[], key: ShipKey): string {
  // Only the ship itself: a replay of a past id must not write rows stamped with the replayer's run.
  const live = process.env.DEVKIT_SHIP_ID === key.shipId;
  const suppressed = live ? trendSuppression(rows, key) : undefined;
  if (suppressed) {
    emitGateEvent({
      type: 'trend_suppressed',
      reason: suppressed.reason,
      offending_ship_id: suppressed.shipId,
    });
  }
  return renderTrend(summariseTrend(rows, key));
}

/** The newest HISTORY_CAP attempts of this ship's branch, read backward. Never throws. */
export function readBranchHistory(sink: string, key: ShipKey): TrendRow[] {
  if (!key.shipId) return [];
  return scanBackward(
    sink,
    parseTrendRow,
    (kept) => (branchAttempts(kept, key)?.mine.length ?? 0) > HISTORY_CAP,
  );
}

/** Pure: streaks → at most two lines per reviewer, or '' for silence. */
export function renderTrend(lines: TrendLine[]): string {
  return lines
    .map(({ reviewer, counts }) => {
      const shown = counts.slice(-SHOWN).map((n) => (n === null ? '?' : `${n}`));
      const series = `${counts.length > SHOWN ? '… → ' : ''}${shown.join(' → ')}`;
      return [
        `   ↻ ${reviewer}: ${counts.length} blocking rounds on this branch with no pass between — ${series} findings, not converging`,
        '     The blocking-finding count is not falling: fix and test the whole class, or use the waive / skip remedies printed above.',
      ].join('\n');
    })
    .join('\n');
}
