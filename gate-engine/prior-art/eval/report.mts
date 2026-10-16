// prior-art-eval REPORT — `--only` row selection and the per-row summary lines. Display only:
// nothing here feeds a score, so editing it never changes what a baseline measured.

import { BenchAbort } from '../../decisions/eval/bench.mts';
import type { Row } from './cases.mts';
import type { ProjectedItem, SlotOutcome } from './matcher.mts';

export interface RowResult {
  id: string;
  verdict: string;
  verdictOk: boolean;
  framing: string;
  framingOk: boolean | null;
  unanimous: boolean;
  valid: { ok: number; total: number };
  gold: { slotId: string; hit: boolean }[];
  decoys: { slotId: string; endorsed: boolean }[];
  genuineClean: boolean | null;
  outages: number;
}

/** One valid run's matcher outcomes over the items it saw; `run` is the checkpoint.jsonl index. */
export interface RunMatch {
  run: number;
  items: ProjectedItem[];
  outcomes: SlotOutcome[];
}

const EXCERPT_MAX = 240;

/** Exact-id selection from a comma-separated `--only`; any unknown id aborts before a paid call. */
export function selectRows(corpus: Row[], only: string | undefined): Row[] {
  if (only === undefined) return corpus;
  const ids = new Set(
    only
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const unknown = [...ids].filter((id) => !corpus.some((row) => row.id === id));
  if (!ids.size || unknown.length)
    throw new BenchAbort(2, `prior-art-eval: no row matches --only ${unknown.join(', ') || only}`);
  return corpus.filter((row) => ids.has(row.id));
}

export function excerpt(item: ProjectedItem | undefined): string {
  const text = [item?.desc, item?.body].filter(Boolean).join(' — ').replace(/\s+/g, ' ').trim();
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1)}…` : text;
}

function outcomeFor(match: RunMatch, slotId: string): SlotOutcome | undefined {
  return match.outcomes.find((outcome) => outcome.slotId === slotId);
}

function conclusionLine(match: RunMatch, stable = true): string {
  return `        run#${match.run} conclusion${stable ? '' : ' (unstable)'}: "${excerpt(match.items[0])}"`;
}

function goldMissLines(slotId: string, matches: RunMatch[]): string[] {
  const missed = matches.filter((match) => outcomeFor(match, slotId)?.match === 0);
  return [
    `      gold ${slotId} missed ${missed.length}/${matches.length} runs`,
    ...missed.map((match) => {
      const { outage = false, stable = true } = outcomeFor(match, slotId) ?? {};
      return outage ? `        run#${match.run}: matcher dark` : conclusionLine(match, stable);
    }),
  ];
}

function decoyEndorsedLines(slotId: string, matches: RunMatch[]): string[] {
  const endorsing = matches.flatMap((match) => {
    const outcome = outcomeFor(match, slotId);
    return outcome && outcome.match > 0 ? [{ match, outcome }] : [];
  });
  return [
    `      decoy ${slotId} endorsed ${endorsing.length}/${matches.length} runs`,
    ...endorsing.flatMap(({ match, outcome: { match: item, stable } }) => {
      const picked = `        run#${match.run} ← F${item}${stable ? '' : ' (unstable)'}: "${excerpt(match.items[item - 1])}"`;
      // F1 is the conclusion itself; any other item is shown beside the conclusion it sits under.
      return item > 1 ? [picked, conclusionLine(match)] : [picked];
    }),
  ];
}

/** The row's marks line, then the matcher's pick for every slot the row majority flagged. */
export function formatRow(id: string, row: Omit<RowResult, 'id'>, matches: RunMatch[]): string[] {
  const measured = row.valid.ok > 0;
  const marks = [
    row.verdictOk ? 'V✓' : `V✗(${row.verdict})`,
    row.framingOk === null ? '' : row.framingOk ? 'F✓' : `F✗(${row.framing})`,
    measured ? '' : `no valid response (0/${row.valid.total})`,
    measured && row.gold.length
      ? `gold ${row.gold.filter((slot) => slot.hit).length}/${row.gold.length}`
      : '',
    measured && row.decoys.some((slot) => slot.endorsed) ? 'DECOY-ENDORSED' : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (!measured) return [`    ${id}: ${marks}`];
  return [
    `    ${id}: ${marks}`,
    ...row.gold.filter((slot) => !slot.hit).flatMap((slot) => goldMissLines(slot.slotId, matches)),
    ...row.decoys
      .filter((slot) => slot.endorsed)
      .flatMap((slot) => decoyEndorsedLines(slot.slotId, matches)),
  ];
}
