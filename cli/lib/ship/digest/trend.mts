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
  devkit_version: text,
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

/** Rows a ship writes before its own marker; inside a killed open attempt they would read as foreign. */
const PRE_MARKER = new Set(['ship_intent', 'judge_preflight']);

/** This branch's rows → its attempts in order, or null when two overlap (completion order is then not
 * round order). Markers open attempts: an inherited DEVKIT_SHIP_ID can span several. */
function attemptsOf(rows: TrendRow[], key: ShipKey): Attempt[] | null {
  const done: Attempt[] = [];
  let current: Attempt | undefined;
  const displaced = new Set<string>();
  for (const row of rows) {
    if (row.repo !== key.repo || row.branch !== key.branch || PRE_MARKER.has(row.type ?? ''))
      continue;
    // A displaced attempt that writes again was not killed: it overlapped, so rounds are out of order.
    if (displaced.has(row.ship_id)) return null;
    if (row.type === 'ship_attempt') {
      // Same id while open: an inherited id cannot tell a kill from an overlap. A new id: the open one died.
      if (current?.shipId === row.ship_id) return null;
      if (current) displaced.add(current.shipId);
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

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const COMPARE_URL = 'https://github.com/norvalbv/devkit/compare';

/** The newest row at or before `end` that matches, walking backward. ES2022 has no findLast. */
function lastBefore(rows: TrendRow[], end: number, match: (row: TrendRow) => boolean): number {
  for (let i = end; i >= 0; i--) if (match(rows[i])) return i;
  return -1;
}

/** Pure: one line when THIS blocked attempt runs a newer devkit release than the branch's previous
 * attempt (killed ones included), else ''. Factual only: it never says the upgrade caused the block. */
export function renderVersionChange(rows: TrendRow[], key: ShipKey): string {
  if (!key.shipId || !key.repo || !key.branch) return '';
  const mine = rows.filter((r) => r.repo === key.repo && r.branch === key.branch);
  const isAttempt = (r: TrendRow) => r.type === 'ship_attempt';
  const at = lastBefore(mine, mine.length - 1, (r) => isAttempt(r) && r.ship_id === key.shipId);
  const result = lastBefore(
    mine,
    mine.length - 1,
    (r) => r.type === 'ship_result' && r.ship_id === key.shipId,
  );
  const prior = lastBefore(mine, at - 1, (r) => isAttempt(r) && r.ship_id !== key.shipId);
  if (at < 0 || prior < 0 || result < 0 || !mine[result].exit_code) return '';
  const from = mine[prior].devkit_version ?? '';
  const to = mine[at].devkit_version ?? '';
  if (!RELEASE_VERSION.test(from) || !RELEASE_VERSION.test(to)) return '';
  if (to.localeCompare(from, 'en', { numeric: true }) <= 0) return '';
  return `   ↑ devkit ${from} → ${to} since this branch's last ship attempt — gate rules may differ: ${COMPARE_URL}/v${from}...v${to}`;
}

/** The digest's branch-history lines (stalled reviewers, then a devkit upgrade), or ''. */
export function renderBranchHistory(sink: string, key: ShipKey): string {
  const rows = readBranchHistory(sink, key);
  return [renderTrend(summariseTrend(rows, key)), renderVersionChange(rows, key)]
    .filter(Boolean)
    .join('\n');
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
