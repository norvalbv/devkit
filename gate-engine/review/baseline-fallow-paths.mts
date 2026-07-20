export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface FallowPathMapping {
  finalPath: string;
  hunks: DiffHunk[];
}

type FallowMappingEntry = readonly [string, FallowPathMapping];
const DROP_FALLOW_VALUE = Symbol('drop-fallow-value');

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
const LINE_RANGE_RE = /^(\d+)-(\d+)$/;

/** Parse zero-context Git hunk headers; omitted counts mean one line. */
export function parseDiffHunks(raw: string): DiffHunk[] {
  return [...raw.matchAll(HUNK_HEADER_RE)].map((match) => ({
    oldStart: Number.parseInt(match[1], 10),
    oldCount: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
    newStart: Number.parseInt(match[3], 10),
    newCount: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
  }));
}

/** Shift an unchanged base range through preceding hunks. A hunk touching the range invalidates it. */
export function mapUnchangedLineRange(
  start: number,
  end: number,
  hunks: readonly DiffHunk[],
): readonly [number, number] | null {
  let delta = 0;
  for (const hunk of hunks) {
    if (hunk.oldCount === 0) {
      if (hunk.oldStart < start) delta += hunk.newCount;
      else if (hunk.oldStart < end) return null;
      continue;
    }
    const oldEnd = hunk.oldStart + hunk.oldCount - 1;
    if (oldEnd < start) delta += hunk.newCount - hunk.oldCount;
    else if (hunk.oldStart <= end) return null;
  }
  return [start + delta, end + delta];
}

function rewriteFallowPathToken(
  value: string,
  mappings: readonly FallowMappingEntry[],
): string | typeof DROP_FALLOW_VALUE {
  // Clone groups contain multiple `path:start-end` records separated by `|`. Split first so every
  // component is remapped; the same exact-prefix rule also covers dead-code `path:symbol` records.
  if (value.includes('|')) {
    const parts = value.split('|').map((part) => rewriteFallowPathToken(part, mappings));
    if (parts.includes(DROP_FALLOW_VALUE)) return DROP_FALLOW_VALUE;
    return (parts as string[]).sort().join('|');
  }
  for (const [before, mapping] of mappings) {
    if (value === before) return mapping.finalPath;
    if (!value.startsWith(`${before}:`)) continue;
    const suffix = value.slice(before.length + 1);
    const range = LINE_RANGE_RE.exec(suffix);
    if (!range) return `${mapping.finalPath}:${suffix}`;
    const shifted = mapUnchangedLineRange(
      Number.parseInt(range[1], 10),
      Number.parseInt(range[2], 10),
      mapping.hunks,
    );
    if (!shifted) return DROP_FALLOW_VALUE;
    return `${mapping.finalPath}:${shifted[0]}-${shifted[1]}`;
  }
  return value;
}

function rewriteFallowValue(
  value: unknown,
  mappings: readonly FallowMappingEntry[],
): unknown | typeof DROP_FALLOW_VALUE {
  if (typeof value === 'string') return rewriteFallowPathToken(value, mappings);
  if (Array.isArray(value))
    return value
      .map((item) => rewriteFallowValue(item, mappings))
      .filter((item) => item !== DROP_FALLOW_VALUE);
  if (!value || typeof value !== 'object') return value;
  const rewritten: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const nextKey = rewriteFallowPathToken(key, mappings);
    if (nextKey === DROP_FALLOW_VALUE) continue;
    if (Object.hasOwn(rewritten, nextKey)) {
      throw new Error(
        `devkit review baseline: rename-normalized Fallow baseline has a path collision at ${nextKey}`,
      );
    }
    const nextValue = rewriteFallowValue(child, mappings);
    if (nextValue !== DROP_FALLOW_VALUE) rewritten[nextKey] = nextValue;
  }
  return rewritten;
}

/** Rewrite native Fallow path/range identities through unchanged parts of the staged diff. */
export function rewriteFallowBaseline(
  value: unknown,
  mappings: ReadonlyMap<string, FallowPathMapping>,
): unknown {
  const ordered = [...mappings].sort(([a], [b]) => b.length - a.length);
  const rewritten = rewriteFallowValue(value, ordered);
  return rewritten === DROP_FALLOW_VALUE ? null : rewritten;
}
