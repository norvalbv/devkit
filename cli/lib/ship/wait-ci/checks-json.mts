/** The five states gh collapses `state` into. Ordered for stable rendering, not by severity. */
export const CHECK_BUCKETS = ['pass', 'fail', 'pending', 'skipping', 'cancel'] as const;
export type CheckBucket = (typeof CHECK_BUCKETS)[number];

/** The `--json` fields this reader dereferences, as one gh argument. */
export const CHECKS_JSON_FIELDS = 'bucket,name,state,link,workflow';

export interface CheckRow {
  bucket: CheckBucket;
  name: string;
  state: string;
  link: string;
  workflow: string;
  /** `check › step` for a still-pending job whose step already failed; set only by steps.mts. */
  failedSteps?: string[];
}

/** The shape gh emits, every field optional so a malformed entry is REJECTED, not dereferenced. */
interface CheckRowCandidate {
  bucket?: unknown;
  name?: unknown;
  state?: unknown;
  link?: unknown;
  workflow?: unknown;
}

const BUCKET_NAMES: ReadonlySet<string> = new Set(CHECK_BUCKETS);
/** Blank for non-Actions checks (CodeRabbit reports both), so presence is proven, not content. */
const TEXT_FIELDS = ['name', 'state', 'link', 'workflow'] as const;

/** Every field this reader dereferences, compared by round-trip rather than a representation check. */
function isCheckRow(value: CheckRowCandidate | null): value is CheckRow {
  return (
    !!value &&
    `${value.bucket}` === value.bucket &&
    BUCKET_NAMES.has(String(value.bucket)) &&
    TEXT_FIELDS.every((f) => `${value[f]}` === value[f])
  );
}

/** Parse gh's `--json` array, rejecting any row that fails the guard above. */
export function parseChecksJson(raw: string): CheckRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: CheckRow[] = [];
  for (const entry of parsed) {
    if (!isCheckRow(entry)) return null;
    rows.push(entry);
  }
  return rows;
}
