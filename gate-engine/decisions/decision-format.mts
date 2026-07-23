const FM_ORDER = ['slug', 'created'];
const INDEX_HEADER =
  '# Decision Index\n\n' +
  'Living architecture record — the current ruling per axis. Each row links to its full\n' +
  'timeline. New rationale lives in the per-axis file.\n\n' +
  '| Axis | Current ruling | Why (hook) | Updated |\n' +
  '|------|----------------|------------|---------|\n';
const INDEX_SEPARATOR_RE = /^\|[\s:|-]+\|$/;
const INDEX_SLUG_RE = /^\[([^\]]+)\]/;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const TARGET_HEAD_RE = /^## Target · /;
const TARGET_FIELD_RE = /^\*\*([^:]+):\*\*\s*(.*)$/;
const NOTE_BULLET_RE = /^-\s+\d{4}-\d{2}-\d{2}\b/;
const TITLE_CUT_RE = /\. |\.$| — |; /;
const MARKDOWN_TABLE_BREAK_RE = /\s*[|\n\r]+\s*/g;

export interface IndexRow {
  slug: string;
  ruling: string;
  why: string;
  updated: string;
}

export interface AddOptions {
  isTarget?: boolean;
  isNew?: boolean;
  note?: string;
  title?: string;
  context?: string;
  ruling?: string;
  consequences?: string;
  tradeoff?: string;
  visionFit?: string;
  researched?: string;
  rejected?: string;
  anchoredBet?: string;
  revisitWhen?: string;
  scope?: string;
  source?: string;
  ref?: string;
  evidenceChange?: string;
}

export interface TargetOptions extends AddOptions {
  context: string;
  ruling: string;
  consequences: string;
  tradeoff: string;
  visionFit: string;
}

export function hasTargetFields(options: AddOptions): options is TargetOptions {
  return Boolean(
    options.ruling &&
      options.context &&
      options.consequences &&
      options.tradeoff &&
      options.visionFit,
  );
}

export interface CurrentTarget {
  ruling: string;
  scope: string;
  fields: Record<string, string>;
  block: string;
}

export function today() {
  return process.env.DECISIONS_TODAY ?? new Date().toISOString().slice(0, 10);
}

export function sanitizeCell(value: string) {
  return String(value ?? '')
    .replace(MARKDOWN_TABLE_BREAK_RE, ' ')
    .trim();
}

export function whyHook(why: string) {
  const one = sanitizeCell(why);
  return one.length > 70 ? `${one.slice(0, 67)}…` : one;
}

export function parseIndex(markdown: string): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    if (INDEX_SEPARATOR_RE.test(trimmed)) continue;
    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length < 4 || cells[0].toLowerCase() === 'axis') continue;
    const slug = cells[0].match(INDEX_SLUG_RE);
    rows.push({
      slug: slug ? slug[1] : cells[0],
      ruling: cells[1],
      why: cells[2],
      updated: cells[3],
    });
  }
  return rows;
}

export function renderIndex(rows: IndexRow[]) {
  const body = [...rows]
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map(
      (row) =>
        `| [${row.slug}](${row.slug}.md) | ${sanitizeCell(row.ruling)} | ${sanitizeCell(row.why)} | ${sanitizeCell(row.updated)} |`,
    )
    .join('\n');
  return INDEX_HEADER + (body ? `${body}\n` : '');
}

export function upsertRow(rows: IndexRow[], row: IndexRow) {
  const index = rows.findIndex((candidate) => candidate.slug === row.slug);
  if (index === -1) rows.push(row);
  else rows[index] = { ...rows[index], ...row };
  return rows;
}

export function parseDecision(markdown: string): {
  fm: Record<string, string>;
  body: string;
} {
  const match = markdown.match(FRONTMATTER_RE);
  if (!match) return { fm: {}, body: markdown };
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    fm[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { fm, body: match[2] };
}

export function renderDecision(fm: Record<string, string>, body: string) {
  const keys = [
    ...FM_ORDER.filter((key) => fm[key]),
    ...Object.keys(fm).filter((key) => !FM_ORDER.includes(key) && fm[key]),
  ];
  return `---\n${keys.map((key) => `${key}: ${fm[key]}`).join('\n')}\n---\n${body}`;
}

function firstClause(value: string | undefined) {
  const text = String(value).trim();
  const cut = text.search(TITLE_CUT_RE);
  return (cut > 0 ? text.slice(0, cut) : text).slice(0, 100);
}

export function renderTarget(date: string, options: TargetOptions) {
  const lines = [
    `## Target · ${date} — ${sanitizeCell(options.title || firstClause(options.ruling))}`,
    '',
  ];
  lines.push(`**Context:** ${options.context}`);
  lines.push(`**Ruling:** ${options.ruling}`);
  lines.push('**Consequences:**');
  lines.push(`- Positive: ${options.consequences}`);
  lines.push(`- Negative: ${options.tradeoff}`);
  lines.push(`**Vision-fit:** ${options.visionFit}`);
  if (options.researched) lines.push(`**Researched:** ${options.researched}`);
  if (options.rejected) lines.push(`**Rejected:** ${options.rejected}`);
  if (options.anchoredBet) lines.push(`**Anchored-bet:** ${options.anchoredBet}`);
  if (options.revisitWhen) lines.push(`**Revisit-when:** ${options.revisitWhen}`);
  if (options.scope) lines.push(`**Scope:** ${options.scope}`);
  lines.push(
    `**Source:** ${[options.source || 'manual', options.ref].filter(Boolean).join(' · ')}`,
  );
  if (options.evidenceChange) lines.push(`**Evidence-change:** ${options.evidenceChange}`);
  return lines.join('\n');
}

export function renderNote(date: string, text: string) {
  return `- ${date} — ${sanitizeCell(text)}`;
}

export function currentTarget(body: string): CurrentTarget | null {
  let last = null;
  const parts = body.split('\n## ');
  for (let index = 0; index < parts.length; index += 1) {
    const heading = index === 0 ? parts[index] : `## ${parts[index]}`;
    if (TARGET_HEAD_RE.test(heading)) last = heading;
  }
  if (!last) return null;
  const fields: Record<string, string> = {};
  const blockLines: string[] = [];
  for (const line of last.split('\n')) {
    if (NOTE_BULLET_RE.test(line)) break;
    blockLines.push(line);
    const field = line.match(TARGET_FIELD_RE);
    if (field) fields[field[1].trim().toLowerCase()] = field[2].trim();
  }
  return {
    ruling: fields.ruling ?? '',
    scope: fields.scope ?? '',
    fields,
    block: blockLines.join('\n').trim(),
  };
}
