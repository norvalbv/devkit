import { createHash } from 'node:crypto';
import { splitDiffByFile } from '../../../../../judge/diff-focus.mts';
import { buildCappedDiffEvidence } from '../../../../diff-evidence.mts';
import { postImagePathOf, unquoteGitPath } from '../../../../lens/chunk.mts';

export interface RequiredSpan {
  file: string;
  side: 'base' | 'post';
  start: number;
  end: number;
  fileSha256: string;
  spanSha256: string;
}

interface Evidence {
  base: Record<string, string | null>;
  post: Record<string, string | null>;
  selectedFiles: readonly string[];
  diff: string;
  rendered: string;
}

type Visibility = 'supplied' | 'partial' | 'out-of-scope' | 'not-in-diff' | 'omitted' | 'truncated';
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Inclusive, one-based source lines. Span bytes join those lines with LF and no added final LF;
 * CR bytes remain intact. A file's terminating LF does not create an extra empty source line. */
function validatedLines(span: RequiredSpan, evidence: Evidence): string[] {
  if (span.side !== 'base' && span.side !== 'post') throw new Error('INVALID_REQUIRED_SPAN');
  const files = evidence[span.side];
  const content = Object.hasOwn(files, span.file) ? files[span.file] : null;
  if (content === null || content === undefined) throw new Error('INVALID_REQUIRED_SPAN');
  const lines = content === '' ? [] : content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  if (
    !Number.isSafeInteger(span.start) ||
    !Number.isSafeInteger(span.end) ||
    span.start < 1 ||
    span.end < span.start ||
    span.end > lines.length ||
    sha256(content) !== span.fileSha256 ||
    sha256(lines.slice(span.start - 1, span.end).join('\n')) !== span.spanSha256
  )
    throw new Error('INVALID_REQUIRED_SPAN');
  return lines;
}

function basePath(segment: string): string | null {
  const header = segment.split(/^@@ /m, 1)[0];
  const renamed = header.match(/^(?:rename|copy) from (.+)$/m)?.[1];
  if (renamed !== undefined) return unquoteGitPath(renamed);
  const minus = header.match(/^--- (.+)$/m)?.[1];
  if (minus === '/dev/null') return null;
  if (minus !== undefined) {
    const path = unquoteGitPath(minus);
    return path.startsWith('a/') ? path.slice(2) : path;
  }
  return postImagePathOf(header);
}

/** The native renderer keeps a prefix of each included segment. Read its emitted marker, rather
 * than reproducing cap budgets. A complete segment takes precedence over marker-like source text. */
function prefixLength(original: string, rendered: string | undefined): number {
  if (rendered === undefined) return 0;
  if (rendered.startsWith(original)) return original.length;
  let shown: number | undefined;
  for (const match of rendered.matchAll(
    /\n\[TRUNCATED: [^\n]* — (\d+) of (\d+) chars shown;[^\n]*\]\n/g,
  )) {
    const count = Number(match[1]);
    if (
      match.index === count &&
      Number(match[2]) === original.length &&
      rendered.slice(0, count) === original.slice(0, count)
    )
      shown = count;
  }
  if (shown === undefined) throw new Error('INVALID_RENDERED_EVIDENCE');
  return shown;
}

function coordinates(
  segment: string,
  side: RequiredSpan['side'],
): Map<number, { text: string; end: number }> {
  const result = new Map<number, { text: string; end: number }>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let offset = 0;
  for (const encoded of segment.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const line = encoded.endsWith('\n') ? encoded.slice(0, -1) : encoded;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
    } else if (inHunk && [' ', '+', '-'].includes(line[0] ?? '')) {
      const old = line[0] !== '+';
      const post = line[0] !== '-';
      if ((side === 'base' && old) || (side === 'post' && post)) {
        result.set(side === 'base' ? oldLine : newLine, {
          text: line.slice(1),
          end: offset + encoded.length,
        });
      }
      if (old) oldLine += 1;
      if (post) newLine += 1;
    }
    offset += encoded.length;
  }
  return result;
}

/** Measures only initial native diff evidence, never subsequent tool reads or model attention. */
export function measureSpan(
  span: RequiredSpan,
  evidence: Evidence,
): {
  status: Visibility;
  shownLines: number;
  totalLines: number;
} {
  const lines = validatedLines(span, evidence);
  // The API accepts native evidence only. Its exact canonical suffix excludes arbitrary inventory
  // text, even an inventory containing a copy of a diff or the required source text.
  const body = buildCappedDiffEvidence(evidence.diff, '').slice(1);
  if (!evidence.rendered.endsWith(`\n${body}`)) throw new Error('INVALID_RENDERED_EVIDENCE');
  const original = splitDiffByFile(evidence.diff);
  const rendered = splitDiffByFile(body);
  const selected = new Set(evidence.selectedFiles.map(unquoteGitPath));
  const totalLines = span.end - span.start + 1;
  const result = (status: Visibility, shownLines = 0) => ({ status, shownLines, totalLines });
  const segments = original
    .map((segment, index) => ({ segment, index }))
    .filter(
      ({ segment }) =>
        (span.side === 'base' ? basePath(segment) : postImagePathOf(segment)) === span.file,
    );
  const scoped = segments.filter(({ segment }) => selected.has(postImagePathOf(segment) ?? ''));
  if (segments.length ? !scoped.length : !selected.has(span.file)) return result('out-of-scope');
  const present = new Set<number>();
  const shown = new Set<number>();
  let anyPrefix = false;
  for (const { segment, index } of scoped) {
    const prefix = prefixLength(segment, rendered[index]);
    anyPrefix ||= prefix > 0;
    const mapped = coordinates(segment, span.side);
    for (let number = span.start; number <= span.end; number += 1) {
      const line = mapped.get(number);
      if (!line) continue;
      if (line.text !== lines[number - 1]) throw new Error('INVALID_DIFF_EVIDENCE');
      present.add(number);
      if (line.end <= prefix) shown.add(number);
    }
  }
  if (shown.size === totalLines) return result('supplied', shown.size);
  if (shown.size) return result('partial', shown.size);
  if (!present.size) return result('not-in-diff');
  return result(anyPrefix ? 'truncated' : 'omitted');
}
