// One digest row per blocking fingerprint (sc-3212): cut to one line, `reason` named only the
// first, so waiving it still left the ship blocked. See the gate-verdict-attribution note.
import { shellWord } from '../../../../gate-engine/review/valve/shell-word.mts';
import { count, oneLine, textOf } from './fields.mts';
import type { GateEvent } from './gate-digest.mts';

const FINGERPRINT = /^[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{7,64}$/;

/** The detail of each row a review_result FAIL contributes, with the fingerprint it names. */
export function blockingFindings(
  e: GateEvent,
): { detail: string; fp?: string; findings?: number }[] {
  const reviewer = oneLine(textOf(e.reviewer)) || 'unknown';
  const sha = textOf(e.blocking_base);
  const base = SHA.test(sha) ? ` --base ${sha}` : '';
  const rows: { detail: string; fp?: string; findings?: number }[] = entries(e).map((b) => ({
    detail: detail(reviewer, b, base),
    fp: b.fp,
  }));
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
function detail(reviewer: string, b: Entry, base: string): string {
  const head = `${b.lens} [${b.fp}]`;
  if (!b.exact) return `${head} — the waive command is in the log`;
  // The same command shape blockingNote prints, so a copied hint records the waiver it names.
  const target = shellWord(`${reviewer}:${b.lens}`);
  return `${head} — fix it, or: guard-review waive ${target} ${b.fp}${base} "why this is not a real defect"`;
}
