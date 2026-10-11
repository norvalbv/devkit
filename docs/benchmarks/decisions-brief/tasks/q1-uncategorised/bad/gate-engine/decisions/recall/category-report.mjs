import { CATEGORIES } from './categories.mjs';

/** Renders category -> axis -> current ruling. */
export function categoryReport(records) {
  const groups = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
  for (const record of records) {
    if (!groups[record.category]) continue;
    groups[record.category].push(record);
  }
  const lines = [];
  for (const [category, members] of Object.entries(groups)) {
    if (!members.length) continue;
    lines.push(`## ${category}`);
    for (const m of members) lines.push(`- ${m.slug} — ${m.ruling}`);
    lines.push('');
  }
  return lines.join('\n');
}
