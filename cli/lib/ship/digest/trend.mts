/** sc-2165: names a reviewer whose blocks on this branch are not converging. Narration only — no exit,
 * never fed to a reviewer; why it exists: decision ship-gates-converge-not-restart. */
import { z } from 'zod';
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

/** The I/O boundary: one sink line in, a row carrying a ship_id or nothing. */
export function parseTrendRow(line: string): TrendRow | undefined {
  try {
    const parsed = trendRowSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** This branch's rows → its attempts in order, or null when two overlap (completion order is then not
 * round order). Markers open attempts: an inherited DEVKIT_SHIP_ID can span several. */
function attemptsOf(rows: TrendRow[], key: ShipKey): Attempt[] | null {
  const done: Attempt[] = [];
  let current: Attempt | undefined;
  for (const row of rows) {
    // ship_intent precedes its own marker, so it would read as foreign inside a killed open attempt.
    if (row.repo !== key.repo || row.branch !== key.branch || row.type === 'ship_intent') continue;
    if (row.type === 'ship_attempt') {
      // Same id while open: an inherited id cannot tell a kill from an overlap. A new id: the open one died,
      // and its own late rows would land as foreign rows below.
      if (current?.shipId === row.ship_id) return null;
      current = { shipId: row.ship_id, rows: [] };
    } else if (!current) {
      // Outside any seen attempt: one the backward read cut off. Dropped, never guessed at.
      continue;
    } else if (row.ship_id !== current.shipId) {
      return null;
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

/** This branch's finished attempts up to the current one, or null when the ship cannot be keyed. */
function branchAttempts(rows: TrendRow[], key: ShipKey) {
  // Never key on an empty repo or branch: that would blend every unkeyed ship on the machine.
  if (!key.shipId || !key.repo || !key.branch) return null;
  const all = attemptsOf(rows, key);
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
  const blocking = new Set(
    keyed.current.rows
      .filter((r) => r.type === 'review_result' && r.status === 'fail' && r.reviewer)
      .map((r) => r.reviewer ?? ''),
  );
  const lines: TrendLine[] = [];
  for (const reviewer of blocking) {
    const streak = streakOf(keyed.mine, reviewer);
    if (streak.length < MIN_STREAK) continue;
    const counts = streak.map(countOf);
    if (stalled(counts)) lines.push({ reviewer, counts });
  }
  return lines;
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
