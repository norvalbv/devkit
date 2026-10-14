import type { ConventionsCase } from './bench.mts';

// Every row's category must be declared here (lintCases enforces it). Declare a category when a
// field incident, shipped mechanism or recorded decision names it, even before a row exercises it.
export const DECLARED_CATEGORIES: readonly string[] = [
  'claude-md-scoping',
  'clean-control',
  'file-size',
  'forbidden-prop',
  'function-length',
  'generated-file-edit',
  'layering-rule',
  'logging-discipline',
  'naming-convention',
  'root-cause-not-patch',
  'schema-requirement',
];

/** Declared categories no corpus row exercises: a reviewer change there is unmeasured. */
export function uncoveredCategories(rows: Pick<ConventionsCase, 'category'>[]): string[] {
  const present = new Set(rows.map((r) => r.category));
  return DECLARED_CATEGORIES.filter((c) => !present.has(c));
}

/** Coverage matrix (zero claude calls): category × expectedVerdict × difficulty cell counts, plus
 * provenance/holdout/variant/decoy-kind tallies and the declared categories with no rows. */
export function printCoverage(rows: ConventionsCase[]) {
  console.log(`── conventions (${rows.length} rows) ──`);
  const cells: Record<string, number> = {};
  const tag: {
    provenance: Record<string, number>;
    holdout: number;
    variants: number;
    decoyKinds: Record<string, number>;
  } = { provenance: {}, holdout: 0, variants: 0, decoyKinds: {} };
  for (const r of rows) {
    const key = `${r.category.padEnd(24)} ${(r.expectedVerdict ?? 'unset').padEnd(6)} ${r.difficulty ?? 'unset'}`;
    cells[key] = (cells[key] ?? 0) + 1;
    const p = r.provenance ?? 'adapted';
    tag.provenance[p] = (tag.provenance[p] ?? 0) + 1;
    if (r.holdout) tag.holdout += 1;
    if (r.variantOf) tag.variants += 1;
    for (const d of r.decoys) tag.decoyKinds[d.kind] = (tag.decoyKinds[d.kind] ?? 0) + 1;
  }
  console.log(`  ${'category'.padEnd(24)} ${'verdict'.padEnd(6)} difficulty  rows`);
  for (const key of Object.keys(cells).sort()) console.log(`  ${key}  ${cells[key]}`);
  const goldTotal = rows.reduce((s, r) => s + r.gold.length, 0);
  const decoyTotal = rows.reduce((s, r) => s + r.decoys.length, 0);
  console.log(
    `  gold slots: ${goldTotal} · decoy slots: ${decoyTotal} · provenance: ${Object.entries(
      tag.provenance,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')} · holdout=${tag.holdout} · variant rows=${tag.variants}`,
  );
  console.log(
    `  decoys by kind: ${
      Object.entries(tag.decoyKinds)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ') || '—'
    }`,
  );
  console.log(`  UNCOVERED: ${uncoveredCategories(rows).join(', ') || '—'}`);
  const unset = rows.filter((r) => !r.difficulty).length;
  if (unset) console.log(`  COVERAGE DEBT: ${unset} row(s) missing a difficulty tag`);
}
