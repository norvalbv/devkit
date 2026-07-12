// Shared diff-evidence primitives for the diff-fed judge gates. Every gate that hands its `claude -p`
// judge a slice of the staged diff (sentry's focusDiff, the decisions `detect` judge, the domain
// reviewers) first splits the diff into per-file segments — three near-identical copies of the same
// `diff --git` split regex. This is the one shared primitive. `focusHunks` additionally selects the
// RELEVANT hunks per file (sentry's pattern, generalized) so any gate can send the judge just the
// signal, keyed on its own per-hunk predicate.
//
// Deterministic EVIDENCE selection only — the LLM still decides the verdict.

// Real `git diff --cached` prefixes each file with `diff --git`; a hand-authored / preamble-free diff
// (some eval fixtures) starts each file at `--- `. Split on whichever the diff uses so a next file's
// header can never leak into the previous file's segment (a path like `catch-utils.ts` must not trip a
// content predicate on the prior file).
const GIT_HEADER_RE = /^diff --git /m;
const GIT_SPLIT_RE = /^(?=diff --git )/m;
const OLD_FILE_SPLIT_RE = /^(?=--- )/m;
const POST_PATH_RE = /^\+\+\+ (?:b\/)?(\S+)/m;
const GIT_PATH_RE = /^diff --git (?:a\/)?(\S+)/m;
const HUNK_SPLIT_RE = /\n(?=@@ )/;

/** Split a unified diff into per-file segments (each = one file's header + its hunks). Empty leading
 * segments (git's `^`-anchored boundary) are dropped. Behaviour-identical to the three call sites it
 * replaces. */
export function splitDiffByFile(diff: string): string[] {
  const text = String(diff);
  if (!text.trim()) return [];
  const boundary = GIT_HEADER_RE.test(text) ? GIT_SPLIT_RE : OLD_FILE_SPLIT_RE;
  return text.split(boundary).filter((s) => s.trim());
}

/** The post-image path of a diff segment (`+++ b/<path>`, else the `diff --git` path), or null. */
export function filePathOf(segment: string): string | null {
  const post = segment.match(POST_PATH_RE)?.[1];
  if (post && post !== '/dev/null') return post;
  return segment.match(GIT_PATH_RE)?.[1] ?? null;
}

/**
 * Focus a diff to its RELEVANT hunks: a header listing every changed file, then only the hunks for
 * which `isRelevant(hunk)` holds, then a count of what was dropped. A file with no relevant hunk stays
 * in the header (so the judge still knows the commit's shape). `omitNoun` labels the dropped hunks in
 * the omission line (e.g. sentry uses 'non-error').
 */
export function focusHunks(
  diff: string,
  isRelevant: (hunk: string) => boolean,
  omitNoun = 'unrelated',
): string {
  const files: string[] = [];
  const kept: string[] = [];
  let omitted = 0;
  for (const seg of splitDiffByFile(diff)) {
    const file = filePathOf(seg);
    if (file) files.push(file);
    const hunks = seg.split(HUNK_SPLIT_RE);
    const head = hunks[0].startsWith('@@') ? '' : (hunks.shift() ?? ''); // the file header
    const relevant: string[] = [];
    for (const h of hunks) {
      if (!h.startsWith('@@')) continue;
      if (isRelevant(h)) relevant.push(h);
      else omitted += 1;
    }
    if (relevant.length) kept.push(`${head.trim()}\n${relevant.join('\n')}`.trim());
  }
  const header = files.length ? `CHANGED FILES: ${files.join(', ')}\n` : '';
  const note = omitted ? `[${omitted} ${omitNoun} hunk(s) omitted]\n` : '';
  return `${header}${note}${kept.join('\n')}`.trim();
}
