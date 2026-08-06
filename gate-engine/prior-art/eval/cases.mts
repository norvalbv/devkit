// prior-art-eval corpus loading + validation.
//
// Split from bench.mts (size cap + the decisions-bench precedent): the case CONTRACT is one small
// readable file — what a row must contain is the thing a corpus author edits, and it must be
// checkable without loading the bench machinery.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchAbort, parseCasesText } from '../../decisions/eval/bench.mts';
import { PRIOR_ART_FRAMINGS, PRIOR_ART_VERDICTS } from '../response-contract.mts';
import type { DecoySlot, GoldSlot } from './matcher.mts';
import type { LegsFixture } from './run-agent.mts';

const here = path.dirname(fileURLToPath(import.meta.url));

export const casesPath = path.join(here, 'cases-prior-art.jsonl');

export interface Row {
  id: string;
  mode: 'intrinsic';
  prompt: string;
  legs: LegsFixture;
  expectVerdict: string[];
  /** Empty = framing not scored on this row (e.g. INSUFFICIENT_EVIDENCE controls). */
  expectFraming: string[];
  gold: GoldSlot[];
  decoys: DecoySlot[];
  /** Row counts into the genuine-control clean rate (clean = not declared SOLVED/DISSOLVE). */
  genuineControl?: boolean;
  /** Degradation rows: verdict/contract scored, matcher skipped (no slots by design). */
  contractOnly?: boolean;
  category: string;
  note: string;
  difficulty: 'normal' | 'adversarial';
  provenance: 'mined' | 'authored';
}

const LEG_STATUSES = ['reached', 'unavailable', 'failed'];

/** Reject a malformed corpus BEFORE any paid call. */
export function lintRows(rows: Row[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const at = `row ${index + 1}${row?.id ? ` (${row.id})` : ''}`;
    for (const field of ['id', 'prompt', 'category', 'note'] as const)
      if (!row?.[field]) errors.push(`${at}: missing "${field}"`);
    if (row?.id && seen.has(row.id)) errors.push(`${at}: duplicate id`);
    if (row?.id) seen.add(row.id);
    if (row?.mode !== 'intrinsic') errors.push(`${at}: mode must be "intrinsic"`);
    if (!Array.isArray(row?.expectVerdict) || row.expectVerdict.length === 0)
      errors.push(`${at}: expectVerdict must be a non-empty array`);
    for (const verdict of row?.expectVerdict ?? [])
      if (!(PRIOR_ART_VERDICTS as readonly string[]).includes(verdict))
        errors.push(`${at}: expectVerdict "${verdict}" is not a prior-art verdict`);
    for (const framing of row?.expectFraming ?? [])
      if (!(PRIOR_ART_FRAMINGS as readonly string[]).includes(framing))
        errors.push(`${at}: expectFraming "${framing}" is not a framing`);
    const local = row?.legs?.local;
    if (
      !local ||
      !LEG_STATUSES.includes(local.status) ||
      !Number.isInteger(local.declared) ||
      !Number.isInteger(local.resolved)
    )
      errors.push(`${at}: legs.local needs status/declared/resolved`);
    if (local && local.resolved === 0 && local.status === 'reached')
      errors.push(`${at}: legs.local cannot pin reached with zero resolved checkouts`);
    for (const leg of ['github', 'web', 'deep-research'] as const)
      if (!LEG_STATUSES.includes(row?.legs?.[leg] as string))
        errors.push(`${at}: legs.${leg} must be reached|unavailable|failed`);
    const slotIds = new Set<string>();
    for (const slot of [...(row?.gold ?? []), ...(row?.decoys ?? [])]) {
      if (!slot?.id || !slot?.desc) errors.push(`${at}: slot needs id and desc`);
      if (slot?.id && slotIds.has(slot.id)) errors.push(`${at}: duplicate slot id ${slot.id}`);
      if (slot?.id) slotIds.add(slot.id);
    }
    if (row?.contractOnly && (row.gold?.length || row.decoys?.length))
      errors.push(`${at}: contractOnly rows carry no slots`);
  });
  return errors;
}

export function loadRows(): Row[] {
  let rows: Row[];
  try {
    rows = parseCasesText(readFileSync(casesPath, 'utf8')) as Row[];
  } catch (error) {
    throw new BenchAbort(2, `prior-art-eval: cannot read cases-prior-art.jsonl — ${error}`);
  }
  if (!rows.length) throw new BenchAbort(2, 'prior-art-eval: cases-prior-art.jsonl is empty');
  const problems = lintRows(rows);
  if (problems.length)
    throw new BenchAbort(2, `prior-art-eval: corpus lint failed —\n  ${problems.join('\n  ')}`);
  return rows;
}
