/**
 * The ONE diff-excerpt function. Shared by finalize.mts (writes the committed anchor) and
 * label.mts (builds the labeler's view) so the labeler judges EXACTLY the view the benchmarked
 * judge will get — divergent truncations turn label/judge disagreement into a windowing artifact
 * (methodology audit, F5). Node-clean: the vitest gate's imports must never pull in bun:sqlite.
 */

export const MAX_EXCERPT_LINES = 300;
export const MAX_EXCERPT_BYTES = 12 * 1024;

const UNIT_START_RE = /^(@@ |diff --git )/;

/** Truncate a unified diff at hunk boundaries — never mid-hunk. */
export const excerptDiff = (diff) => {
  const lines = diff.split('\n');
  const out = [];
  let bytes = 0;
  let truncated = false;
  let i = 0;
  while (i < lines.length) {
    // find the end of the current unit: a hunk (@@) or header block runs until the next @@ / diff --git
    let j = i + 1;
    while (j < lines.length && !UNIT_START_RE.test(lines[j])) j++;
    const unit = lines.slice(i, j);
    const unitBytes = Buffer.byteLength(unit.join('\n'), 'utf8') + 1;
    if (out.length + unit.length > MAX_EXCERPT_LINES || bytes + unitBytes > MAX_EXCERPT_BYTES) {
      truncated = true;
      break;
    }
    out.push(...unit);
    bytes += unitBytes;
    i = j;
  }
  return { excerpt: out.join('\n'), truncated };
};
