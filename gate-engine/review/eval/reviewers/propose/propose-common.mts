#!/usr/bin/env node
// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * propose-common — helpers shared by the two propose-stage triage scripts (propose.mts for
 * bot-mined candidates, propose-telemetry.mts for gate-telemetry candidates). Split out when the
 * clone gate flagged the duplicated drop-histogram block between them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectCorpusUrls } from '../mine-common.mts';

/** kebab slug from free text, for queue ids. */
export function slugify(text, maxWords = 5) {
  return (
    String(text ?? '')
      .toLowerCase()
      .replace(/`/g, '')
      .match(/[a-z0-9]+/g)
      ?.slice(0, maxWords)
      .join('-')
      ?.slice(0, 40) || 'finding'
  );
}

/** `reason:count` list, most-dropped first — the auditable triage funnel line. */
export function formatDrops(drops) {
  return (
    Object.entries(drops)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(', ') || '—'
  );
}

/** Disambiguate `base` against ids already seen: base, base-2, base-3, … */
export function uniqueId(base, seen) {
  let id = base;
  let n = 2;
  while (seen.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  seen.add(id);
  return id;
}

/** One parsed object per non-blank line. */
export function readJsonl(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Drop-reason counter: `bump(reason, n=1)` increments, `drops` is the histogram object. */
export function makeDropCounter() {
  const drops = {};
  const bump = (reason, n = 1) => {
    drops[reason] = (drops[reason] ?? 0) + n;
  };
  return { drops, bump };
}

/** Parse `--max N` (positive integer) or exit 2 under the script's name. */
export function parseMaxArg(argv, name, fallback = 10) {
  const maxIdx = argv.indexOf('--max');
  const max = maxIdx !== -1 ? Number.parseInt(argv[maxIdx + 1], 10) : fallback;
  if (!Number.isFinite(max) || max <= 0) {
    console.error(`${name}: --max must be a positive integer`);
    process.exit(2);
  }
  return max;
}

/** Exit 2 with a remedy hint when a required input file is absent. */
export function requireFile(file, name, hint) {
  if (!existsSync(file)) {
    console.error(`${name}: missing ${path.basename(file)} — ${hint}`);
    process.exit(2);
  }
}

/** Compose a suite-specific drop function with the promoted-corpus check. Telemetry and GHSA
 * candidates carry no alreadyInCorpus flag (that's mine-bots' merge concern), so the proposers
 * enforce it here — a landed source.url must never be re-queued. */
export function makeHardDrop(reviewersDir, dropReason) {
  const corpusUrls = collectCorpusUrls(reviewersDir);
  return (c) => (corpusUrls.has(c.url) ? 'already-in-corpus' : dropReason(c));
}

/** Run the hard-drop filter over candidates, bumping the histogram; returns survivors. */
export function partitionDrops(candidates, hardDropReason, bump) {
  const kept = [];
  for (const c of candidates) {
    const dropReason = hardDropReason(c);
    if (dropReason) bump(dropReason);
    else kept.push(c);
  }
  return kept;
}

/** Write a queue file (one JSON line per row), creating raw/ if needed. */
export function writeQueue(outFile, rows) {
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

/** stderr triage summary: script-specific lines + the shared drops/output-path tail. */
export function printSummary(lines, drops, baseDir, outFile) {
  console.error(
    [...lines, `  drops: ${formatDrops(drops)}`, `  → ${path.relative(baseDir, outFile)}`].join(
      '\n',
    ),
  );
}

/** Invoke main() only when this module is the direct CLI entrypoint. */
export function runIfMain(metaUrl, main) {
  if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(metaUrl)) main();
}
