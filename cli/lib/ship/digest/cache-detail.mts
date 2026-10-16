// Wording for a cached or partial-packet PASS: what the reused verdict did not re-judge.
import { count, oneLine, textOf } from './fields.mts';
import type { GateEvent } from './gate-digest.mts';

/** A sink row's judged base, short — JSON.stringify never invokes a row-supplied toString, so a
 * malformed value (`{"toString":1}`) degrades to "an earlier base" instead of throwing. */
const shortJudgedBase = (sha: string | null | undefined): string =>
  /^"([0-9a-f]{7,64})"$/.exec(JSON.stringify(sha ?? null))?.[1].slice(0, 12) ?? 'an earlier base';

/** A PASS reused across a reshaped diff, or ''. `=== false`: an absent field covers it. */
export const earlierDiffDetail = (e: GateEvent): string =>
  e.diff_matches === false
    ? 'cached PASS judged an earlier diff — this diff was not re-judged'
    : '';

/** A PASS judged on an earlier base whose reviewed paths moved, or ''. An absent base_state
 * (non-review emitters) or 'moved-clear' stays a ✓. */
export function baseDriftDetail(e: GateEvent): string {
  if (e.base_state === 'unknown')
    return 'cached PASS whose judged base is unknown — not re-judged against this base';
  if (e.base_state === 'moved-overlap')
    return `cached PASS judged against ${shortJudgedBase(e.judged_base_sha)} — reviewed paths changed on the base since; not re-judged`;
  return '';
}

export function partialPacket(e: GateEvent): boolean {
  return count(e.evidence_omitted_files) > 0 || count(e.evidence_truncated_files) > 0;
}

const PATHS_SHOWN = 3;

/** ` — <label>: a, b, c, …` over an untrusted path list, or '' when it holds no usable path. */
function namedPaths(label: string, list: string[] | undefined, total: number): string {
  const paths = (Array.isArray(list) ? list : []).map(textOf).filter(Boolean);
  const more = paths.length > PATHS_SHOWN || total > PATHS_SHOWN ? ', …' : '';
  return paths.length
    ? ` — ${label}: ${paths
        .slice(0, PATHS_SHOWN)
        .map((p) => oneLine(p))
        .join(', ')}${more}`
    : '';
}

export function partialPacketDetail(e: GateEvent): string {
  const omitted = count(e.evidence_omitted_files);
  const truncated = count(e.evidence_truncated_files);
  const lensName = textOf(e.evidence_lens);
  const lens = lensName ? ` (${oneLine(lensName)} lens)` : '';
  const total = count(e.evidence_file_count) ? `/${count(e.evidence_file_count)}` : '';
  const named =
    namedPaths('not shown', e.evidence_omitted_paths, omitted) +
    namedPaths('truncated', e.evidence_truncated_paths, truncated);
  const cached = e.type === 'cache_hit' ? 'cached ' : '';
  return `${cached}PASS over an incomplete packet${lens}: ${omitted}${total} file(s) omitted, ${truncated} truncated${named}`;
}
