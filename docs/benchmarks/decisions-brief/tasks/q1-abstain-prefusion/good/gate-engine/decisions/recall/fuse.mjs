const K = 60;

/**
 * Fuses the lexical and semantic rankings of the same candidates.
 *
 * @param {{ slug: string, score: number }[]} lexical   best first
 * @param {{ slug: string, score: number }[]} semantic  best first
 * @returns {{ rows: { slug: string, score: number }[], source: 'hybrid' | 'none' }}
 */
export function fuse(lexical, semantic, { minScore } = {}) {
  if (minScore !== undefined && (lexical[0]?.score ?? 0) < minScore) return { rows: [], source: 'none' };
  const fused = new Map();
  for (const tier of [lexical, semantic]) {
    tier.forEach((row, i) => fused.set(row.slug, (fused.get(row.slug) ?? 0) + 1 / (K + i + 1)));
  }
  const rows = [...fused].map(([slug, score]) => ({ slug, score })).sort((a, b) => b.score - a.score);
  return { rows, source: 'hybrid' };
}
