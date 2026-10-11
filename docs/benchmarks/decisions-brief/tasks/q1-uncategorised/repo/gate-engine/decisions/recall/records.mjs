/** The decision records, as loaded from docs/decisions/. `category` is optional on a record. */
export const RECORDS = [
  { slug: 'coverage-gate', category: 'commit-gates', ruling: 'Coverage is judged on the lines a commit adds.' },
  { slug: 'bench-gates-on-flips', category: 'benchmarking', ruling: 'Benchmarks gate on stable flips.' },
  { slug: 'published-tags-immutable', ruling: 'A published version tag is never re-pointed.' },
  { slug: 'decision-format-parsed', category: 'decision-log', ruling: 'Records are parsed, not regexed.' },
  { slug: 'synced-assets-layout', ruling: 'Synced assets read layout from the consumer config.' },
];
