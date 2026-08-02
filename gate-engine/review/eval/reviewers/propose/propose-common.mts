#!/usr/bin/env node
// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * propose-common — helpers shared by the two propose-stage triage scripts (propose.mts for
 * bot-mined candidates, propose-telemetry.mts for gate-telemetry candidates). Split out when the
 * clone gate flagged the duplicated drop-histogram block between them.
 */

import { readFileSync } from 'node:fs';

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
