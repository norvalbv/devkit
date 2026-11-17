#!/usr/bin/env node

/**
 * sc-1119 denominator source of truth. Every pre-registered denominator the bench, the noise
 * audit and the README quote is DERIVED here from cases.jsonl — never hand-counted (the v1
 * methodology audit's fatal findings were denominator ambiguities; the corpus README's own
 * "12 diff guards" stat counts 8 no-response rows the consumption contract excludes from all
 * denominators).
 *
 *   node gate-engine/edge-cases/eval/counts.mts          # print the counts as JSON
 *
 * Contract semantics (eval/README.md, pre-registered):
 * - no-response rows are excluded from EVERY denominator (never judged);
 * - true precision guards = degenerate rows with a real degenerate reason (empty-diff /
 *   docs-only / agent-declined), split diff-shaped vs summary-modality;
 * - the recall denominator is ANCHORED ∩ worth-surfacing findings on diff bearing rows
 *   (anchored = finding.files ∩ anchorFilesOf(nameStatus), the same parse finalize.mts used
 *   to compute the committed coverage);
 * - the f2p disqualification core = anchored wasLiveBug:"true" findings (tiers 1–3 by schema).
 *
 * Node-clean (vitest imports computeCounts) — no bun:sqlite here or transitively.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anchorFilesOf, overlapCount } from './lib/match.mts';

export const defaultCorpusPath = () =>
  process.env.EDGE_CASES_CORPUS ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'cases.jsonl');

export const readCases = (file = defaultCorpusPath()) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

const isNoResponse = (c) => c.degenerate && c.degenerateReason === 'no-response';

/** True precision guard: a judged row on which ANY judge finding is a hallucination. */
const isTrueGuard = (c) => c.degenerate && !isNoResponse(c);

/** Derive every sc-1119 denominator from corpus rows. Pure. */
export const computeCounts = (cases) => {
  const judged = cases.filter((c) => !isNoResponse(c));
  const diff = judged.filter((c) => c.anchor.kind === 'diff');
  const summary = judged.filter((c) => c.anchor.kind === 'session-summary');
  const diffBearing = diff.filter((c) => c.findings.length > 0);

  const perRow = diffBearing.map((c) => {
    const anchorFiles = anchorFilesOf(c.anchor.nameStatus);
    const anchored = c.findings.filter((f) => overlapCount(f.files, anchorFiles) > 0);
    return {
      id: c.id,
      anchoredWS: anchored.filter((f) => f.verdict !== 'noise').length,
      anchoredNoise: anchored.filter((f) => f.verdict === 'noise').length,
      anchoredReceipts: anchored.filter((f) => String(f.wasLiveBug) === 'true').length,
      unanchored: c.findings.length - anchored.length,
    };
  });
  const sum = (key) => perRow.reduce((n, r) => n + r[key], 0);

  return {
    totalRows: cases.length,
    noResponseRows: cases.length - judged.length,
    judgedRows: judged.length,
    diffRows: diff.length,
    diffBearingRows: diffBearing.length,
    diffGuardRows: diff.filter(isTrueGuard).length,
    // zero-finding diff rows that are neither degenerate nor no-response would be
    // "organic true negatives" (contract rule 4 — none exist today); tracked so their
    // appearance is visible, not silently folded into a guard count
    diffOrganicZeroRows: diff.filter((c) => c.findings.length === 0 && !c.degenerate).length,
    summaryRows: summary.length,
    summaryBearingRows: summary.filter((c) => c.findings.length > 0).length,
    summaryGuardRows: summary.filter(isTrueGuard).length,
    anchoredWS: sum('anchoredWS'),
    anchoredNoise: sum('anchoredNoise'),
    anchoredReceipts: sum('anchoredReceipts'),
    unanchoredDiffFindings: sum('unanchored'),
    totalFindings: cases.reduce((n, c) => n + c.findings.length, 0),
    perBearingRowAnchoredWS: perRow.map((r) => r.anchoredWS).sort((a, b) => a - b),
  };
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const cases = readCases();
  if (!cases.length) {
    console.error(`counts: no corpus at ${defaultCorpusPath()} (set EDGE_CASES_CORPUS)`);
    process.exit(2);
  }
  console.log(JSON.stringify(computeCounts(cases), null, 2));
}
