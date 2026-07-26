/**
 * decisions-eval corpus loading + validation.
 *
 * Split from bench.mts so the case CONTRACT is one small readable file: what a row must contain is
 * the thing a corpus author edits, and it must be checkable without loading the judge machinery.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Deliberate abort with a bench exit code — thrown (not process.exit) so tests can assert it. */
export class BenchAbort extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ─── Corpus loading ───────────────────────────────────────────────────────────────

export const parseCasesText = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/**
 * Per-sub-bench row contract: [non-empty fields, present-but-may-be-empty fields, `expected` labels].
 * `diff` is deliberately in the second group: a free-skip row carries `diff: ""` on purpose (the
 * smell tripwire never fires, so the gate scores it without a judge call). Requiring it non-empty
 * would reject 12 legitimate rows — the lint caught that about itself on its first run.
 */
const CASE_SCHEMA = {
  detect: [['id', 'expected', 'note'], ['diff'], ['DECISION', 'ROUTINE', 'NULL']],
  alignment: [['id', 'expected', 'note'], [], ['ALIGN', 'CONTRADICT', 'UNCLEAR', 'NO-MATCH']],
  depth: [['id', 'block', 'expected', 'note'], [], ['PASS', 'THIN']],
};

/**
 * Reject a malformed corpus BEFORE any paid call. Without this a bad row surfaces mid-run — after
 * an hour of judge calls — and the whole run is discarded. Cheap, deterministic, always on.
 */
export function lintCases(name, rows) {
  const [nonEmpty, present, labels] = CASE_SCHEMA[name];
  const errors = [];
  const seen = new Set();
  rows.forEach((r, i) => {
    const at = `row ${i + 1}${r?.id ? ` (${r.id})` : ''}`;
    for (const f of nonEmpty)
      if (r?.[f] === undefined || r[f] === '') errors.push(`${at}: missing "${f}"`);
    for (const f of present) if (r?.[f] === undefined) errors.push(`${at}: missing "${f}"`);
    if (r?.id && seen.has(r.id)) errors.push(`${at}: duplicate id`);
    if (r?.id) seen.add(r.id);
    if (r?.expected && !labels.includes(r.expected))
      errors.push(`${at}: expected "${r.expected}" is not one of ${labels.join(' | ')}`);
    if (name === 'detect' && !Array.isArray(r?.entries))
      errors.push(`${at}: "entries" must be array`);
    if (name === 'alignment' && (!r?.target?.ruling || !r?.repo?.base))
      errors.push(`${at}: needs target.ruling and repo.base`);
  });
  return errors;
}

/** The three judge sub-benches, in run order — the valid arguments to `loadCases`. */
export const SUBS = ['detect', 'alignment', 'depth'];

export function loadCases(name) {
  const file = path.join(here, `cases-${name}.jsonl`);
  let rows: ReturnType<typeof parseCasesText>;
  try {
    rows = parseCasesText(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new BenchAbort(2, `decisions-eval: cannot read ${path.basename(file)} — ${e}`);
  }
  if (!rows.length) throw new BenchAbort(2, `decisions-eval: ${path.basename(file)} is empty`);
  const errors = lintCases(name, rows);
  if (errors.length)
    throw new BenchAbort(
      2,
      `decisions-eval: ${path.basename(file)} is malformed (${errors.length}) —\n  ${errors.join('\n  ')}`,
    );
  return rows;
}
