import { fuse } from './fuse.mjs';

/** Ranks decisions for a query. `lexical` and `semantic` are the two tiers' own rankings. */
export function query(lexical, semantic, k = 3) {
  const result = fuse(lexical, semantic);
  return { ...result, rows: result.rows.slice(0, k) };
}
