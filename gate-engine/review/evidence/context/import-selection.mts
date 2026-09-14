import type { ImportSpecifier } from 'es-module-lexer';

function lowerBound(values: number[], target: number): number {
  let lo = 0,
    hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Prefer imports touched by the change before unchanged relationships when discovery is capped.
 * Git hunk coordinates refer to the captured source side, including multiline statements. */
export function selectImports(
  imports: readonly ImportSpecifier[],
  source: string,
  diff: string,
  side: 'base' | 'staged',
  cap: number,
): ImportSpecifier[] {
  const changed = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('-')) {
      if (side === 'base') changed.add(oldLine);
      oldLine++;
    }
    if (line.startsWith('+')) {
      if (side === 'staged') changed.add(newLine);
      newLine++;
    }
    if (line.startsWith(' ')) {
      oldLine++;
      newLine++;
    }
  }
  const newlines: number[] = [];
  for (let offset = source.indexOf('\n'); offset >= 0; offset = source.indexOf('\n', offset + 1))
    newlines.push(offset);
  const lineAt = (offset: number) => lowerBound(newlines, offset) + 1;
  const changedLines = [...changed].sort((a, b) => a - b);
  return imports
    .map((imp, index) => {
      const from = lineAt(imp.ss),
        to = lineAt(imp.se);
      const touched = changedLines[lowerBound(changedLines, from)] <= to;
      return { imp, index, touched };
    })
    .sort((a, b) => Number(b.touched) - Number(a.touched) || a.index - b.index)
    .slice(0, cap)
    .map(({ imp }) => imp);
}
