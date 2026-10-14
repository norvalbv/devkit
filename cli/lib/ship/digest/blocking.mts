// One digest row per blocking fingerprint (sc-3212): cut to one line, `reason` named only the
// first, so waiving it still left the ship blocked. See the gate-verdict-attribution note.
import { waiveCommand } from '../../../../gate-engine/review/valve/shell-word.mts';
import { count, oneLine, textOf } from './fields.mts';
import type { GateEvent } from './gate-digest.mts';
import { issuesUnder } from './trend.mts';

const FINGERPRINT = /^[0-9a-f]{12}$/;

/** The detail of each row a review_result FAIL contributes, with the fingerprint it names. */
export function blockingFindings(
  e: GateEvent,
): { detail: string; fp?: string; findings?: number }[] {
  const reviewer = oneLine(textOf(e.reviewer)) || 'unknown';
  const base = textOf(e.blocking_base);
  const all = entries(e);
  const rows: { detail: string; fp?: string; findings?: number }[] = all.map((b) => {
    const issues = manyIssues(e, b, all);
    const row = { detail: detail(reviewer, b, base, issues), fp: b.fp };
    return issues ? { ...row, findings: issues } : row;
  });
  const omitted = count(e.blocking_omitted);
  if (omitted > 0) {
    rows.push({
      detail: `+${omitted} more blocking finding(s) — every ID is in the log`,
      fp: '+',
      findings: omitted,
    });
  }
  // No usable list (a cascade-confirmed FAIL never reached the valve; an older emitter): the prose.
  return rows.length > 0 ? rows : [{ detail: oneLine(e.reason) }];
}

/** Validated entry by entry: anything that is not a lens string and a 12-hex fingerprint is
 * dropped rather than rendered or thrown on. */
function entries(e: GateEvent): Entry[] {
  if (!Array.isArray(e.blocking)) return [];
  const out: Entry[] = [];
  for (const raw of e.blocking) {
    const fp = textOf(raw?.fp);
    if (!FINGERPRINT.test(fp)) continue;
    const lens = textOf(raw?.lens);
    const shown = oneLine(lens);
    // `exact`: the shown label IS the finding's lens — not collapsed, not cut here or by the emitter.
    const exact = shown !== '' && shown === lens && !lens.endsWith('…');
    out.push({ lens: shown || '(finding)', fp, exact });
  }
  return out;
}

interface Entry {
  lens: string;
  fp: string;
  exact: boolean;
}

/** `<lens> [<fp>]` first so the ID survives any cut; a waive hint only from the exact lens, since
 * any other label waives nothing. oneLine capped the lens, so the hint stays bounded. */
function detail(reviewer: string, b: Entry, base: string, issues: number): string {
  const head = `${b.lens} [${b.fp}]${issues ? ` · ${issues} issues, each listed in the log` : ''}`;
  // The same renderer blockingNote uses, so a copied hint records the waiver it names.
  const command = b.exact && waiveCommand({ reviewer, lens: b.lens, fp: b.fp, base });
  const fix = issues ? 'fix them all' : 'fix it';
  return command ? `${head} — ${fix}, or: ${command}` : `${head} — the waive command is in the log`;
}

/** How many issues sit under this ID when more than one, else 0. A cut label, a lens split across
 * IDs, or a list that dropped IDs cannot be matched to one item, so each of those reads 0. */
function manyIssues(e: GateEvent, b: Entry, all: Entry[]): number {
  const oneId =
    count(e.blocking_omitted) === 0 && all.filter((o) => o.lens === b.lens).length === 1;
  if (!b.exact || !oneId) return 0;
  const issues = issuesUnder(e, b.lens) ?? 0;
  return issues > 1 ? issues : 0;
}
